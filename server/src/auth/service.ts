import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { open, seal } from "../crypto.js";
import { uid } from "../db.js";
import { HttpError, badRequest, notFound, type Services } from "../services.js";
import { burnPasswordTime, hashPassword, passwordProblem, verifyPassword } from "./password.js";
import { generateSecret, matchTotp, otpauthUri } from "./totp.js";

export const SESSION_COOKIE = "cadence_session";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const IDLE_DAYS = 7, MFA_PENDING_MINUTES = 5, MFA_MAX_ATTEMPTS = 5;
const LOCK_AFTER = 5, IP_WINDOW_MINUTES = 15, IP_MAX_FAILURES = 30;
const BAD_LOGIN = "E-mail ou mot de passe incorrect. Après plusieurs essais, le compte est verrouillé quelques minutes.";

export const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export interface RequestInfo { ip: string; userAgent: string }
/** Ce qu'une personne a tapé par erreur n'a pas à rester lisible dans les journaux. */
export const maskEmail = (email: string) => { const [local, domain] = email.split("@"); return domain ? `${local.slice(0, 1)}***@${domain.slice(0, 253)}` : "***"; };
const recoveryHash = (userId: string, code: string) => fingerprint(`${userId}:${code.toUpperCase()}`);
interface AccountRow { id: string; email: string; name: string; password_hash: string | null; status: string; failed_logins: number; locked_until: string | null; totp_enabled: boolean; totp_secret: string | null; totp_last_step: string | number | null; recovery_codes: string[] }

export class Auth {
  constructor(private svc: Services) {}

  async record(kind: string, o: { userId?: string | null; actorId?: string | null; ip?: string | null; data?: Record<string, unknown> } = {}) {
    await this.svc.db.query("INSERT INTO security_events (id, kind, user_id, actor_id, ip, data) VALUES ($1,$2,$3,$4,$5,$6)", [uid("sev"), kind, o.userId ?? null, o.actorId ?? null, o.ip ?? null, JSON.stringify(o.data ?? {})]);
  }

  private account(where: "email" | "id", value: string) {
    return this.svc.db.one<AccountRow>(`SELECT id, email, name, password_hash, status, failed_logins, locked_until, totp_enabled, totp_secret, totp_last_step, recovery_codes FROM users WHERE ${where === "email" ? "lower(email) = lower($1)" : "id = $1"} AND NOT is_ai`, [value]);
  }

  // ---------------------------------------------------------------- sessions
  async createSession(userId: string, info: RequestInfo, mfaPending = false) {
    const token = newToken();
    await this.svc.db.query(`INSERT INTO sessions (id, public_id, user_id, mfa_pending, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
      [fingerprint(token), uid("ses"), userId, mfaPending, info.ip, info.userAgent.slice(0, 400), mfaPending ? String(MFA_PENDING_MINUTES * 60) : String(SESSION_MAX_AGE)]);
    return token;
  }

  /** Une session n'est valable que si elle est complète, récente, non révoquée, et que le compte reste actif. */
  async resolve(token: string | undefined) {
    if (!token) return null;
    const s = await this.svc.db.one<{ id: string; public_id: string; user_id: string; last_seen_at: string }>(`SELECT s.id, s.public_id, s.user_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND NOT s.mfa_pending AND s.expires_at > now() AND s.last_seen_at > now() - ($2 || ' days')::interval AND u.status = 'active'`, [fingerprint(token), String(IDLE_DAYS)]);
    if (!s) return null;
    if (Date.now() - Date.parse(s.last_seen_at) > 60_000) await this.svc.db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [s.id]);
    return { userId: s.user_id, sessionId: s.id, publicId: s.public_id };
  }

  async revokeAll(userId: string, exceptSession?: string) {
    await this.svc.db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2", [userId, exceptSession ?? ""]);
  }
  async logout(token: string | undefined) {
    if (token) await this.svc.db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [fingerprint(token)]);
  }
  async listSessions(userId: string, currentSession: string) {
    const rows = await this.svc.db.query<{ id: string; public_id: string; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string }>("SELECT id, public_id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND NOT mfa_pending AND expires_at > now() ORDER BY last_seen_at DESC", [userId]);
    return rows.map(({ id, public_id, ...r }) => ({ ...r, id: public_id, current: id === currentSession }));
  }
  async revokeSession(userId: string, publicId: string) {
    await this.svc.db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND public_id = $2", [userId, publicId]);
  }

  // ---------------------------------------------------------------- connexion
  /** Enregistre l'essai en une seule instruction, avant tout calcul : des requêtes simultanées ne peuvent pas dépasser la limite. */
  private async reserveAttempt(email: string, ip: string) {
    const row = await this.svc.db.one<{ id: string }>(`INSERT INTO login_attempts (id, email, ip, success)
      SELECT $1, $2, $3::text, FALSE WHERE (SELECT count(*) FROM login_attempts WHERE ip = $3::text AND NOT success AND created_at > now() - ($4 || ' minutes')::interval) < $5::int RETURNING id`,
      [uid("lat"), email.toLowerCase().slice(0, 320), ip, String(IP_WINDOW_MINUTES), IP_MAX_FAILURES]);
    if (!row) throw new HttpError(429, "Trop de tentatives depuis cette adresse. Réessayez dans quelques minutes.");
    return row.id;
  }

  /**
   * Compte un essai avant de le vérifier, sinon des requêtes simultanées liraient toutes le même compteur.
   * Verrouillage progressif : 1, 2, 4… minutes, au plus une heure. Renvoie le total d'échecs, ou null si le compte est déjà verrouillé.
   */
  private async reserveFailure(userId: string, counter: "failed_logins" | "mfa_failures", lock: "locked_until" | "mfa_locked_until") {
    const row = await this.svc.db.one<{ n: number }>(`UPDATE users SET ${counter} = ${counter} + 1,
      ${lock} = CASE WHEN ${counter} + 1 >= $1::int THEN now() + make_interval(mins => LEAST(power(2, LEAST(${counter} + 1 - $1::int, 10)), 60)::int) ELSE ${lock} END
      WHERE id = $2 AND (${lock} IS NULL OR ${lock} <= now()) RETURNING ${counter} AS n`, [LOCK_AFTER, userId]);
    return row ? row.n : null;
  }

  async login(email: string, password: string, info: RequestInfo): Promise<{ status: "ok" | "mfa"; token: string }> {
    const attemptId = await this.reserveAttempt(email, info.ip);
    const a = await this.account("email", email);
    const fail = async () => {
      await this.record("login.failed", { userId: a?.id, ip: info.ip, data: { email: maskEmail(email) } });
      throw new HttpError(401, BAD_LOGIN);
    };
    if (!a?.password_hash) { await burnPasswordTime(password); return fail(); }
    if (a.status !== "active") { await verifyPassword(password, a.password_hash); return fail(); }
    const failed = await this.reserveFailure(a.id, "failed_logins", "locked_until");
    const valid = await verifyPassword(password, a.password_hash);
    if (failed === null) return fail();
    if (!valid) {
      if (failed >= LOCK_AFTER) await this.record("account.locked", { userId: a.id, ip: info.ip, data: { failures: failed } });
      return fail();
    }
    await this.svc.db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [a.id]);
    await this.svc.db.query("UPDATE login_attempts SET success = TRUE WHERE id = $1", [attemptId]);
    if (a.totp_enabled) return { status: "mfa", token: await this.createSession(a.id, info, true) };
    return { status: "ok", token: await this.completeLogin(a.id, info, null) };
  }

  private async completeLogin(userId: string, info: RequestInfo, existing: string | null) {
    await this.svc.db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    await this.record("login.success", { userId, ip: info.ip });
    return existing ?? this.createSession(userId, info);
  }

  /** Seconde étape : le code transforme la session incomplète en session valable. */
  async verifyMfa(token: string | undefined, code: string, info: RequestInfo) {
    const denied = new HttpError(401, "Code incorrect ou expiré");
    if (!token) throw denied;
    const id = fingerprint(token);
    const s = await this.svc.db.one<{ user_id: string; mfa_attempts: number }>("SELECT user_id, mfa_attempts FROM sessions WHERE id = $1 AND mfa_pending AND revoked_at IS NULL AND expires_at > now()", [id]);
    if (!s) throw denied;
    const a = (await this.account("id", s.user_id))!;
    // Compté par compte : ouvrir une nouvelle session après chaque série d'essais ne remet pas le compteur à zéro
    const failures = await this.reserveFailure(a.id, "mfa_failures", "mfa_locked_until");
    if (failures === null) throw denied;
    const clean = code.trim();
    const step = matchTotp(open(a.totp_secret!), clean);
    // Chaque code se consomme en une seule instruction : deux requêtes simultanées ne peuvent pas réussir toutes les deux
    let ok = step !== null && !!(await this.svc.db.one("UPDATE users SET totp_last_step = $1::bigint WHERE id = $2 AND COALESCE(totp_last_step, 0) < $1::bigint RETURNING id", [step, a.id]));
    if (!ok && step === null) {
      const used = await this.svc.db.one<{ remaining: number }>("UPDATE users SET recovery_codes = recovery_codes - $1::text WHERE id = $2 AND recovery_codes ? $1::text RETURNING jsonb_array_length(recovery_codes) AS remaining", [recoveryHash(a.id, clean), a.id]);
      if (used) {
        ok = true;
        await this.record("mfa.recovery_used", { userId: a.id, ip: info.ip, data: { remaining: used.remaining } });
      }
    }
    if (!ok) {
      const attempts = s.mfa_attempts + 1;
      await this.svc.db.query("UPDATE sessions SET mfa_attempts = $1, revoked_at = CASE WHEN $1::int >= $2::int THEN now() ELSE NULL END WHERE id = $3", [attempts, MFA_MAX_ATTEMPTS, id]);
      await this.record(failures >= LOCK_AFTER ? "mfa.locked" : "mfa.failed", { userId: a.id, ip: info.ip });
      throw denied;
    }
    await this.svc.db.query("UPDATE users SET mfa_failures = 0, mfa_locked_until = NULL WHERE id = $1", [a.id]);
    await this.svc.db.query(`UPDATE sessions SET mfa_pending = FALSE, expires_at = now() + ($1 || ' seconds')::interval WHERE id = $2`, [String(SESSION_MAX_AGE), id]);
    await this.completeLogin(a.id, info, token);
  }

  // ---------------------------------------------------------------- mot de passe
  async setPassword(userId: string, password: string) {
    const a = (await this.account("id", userId))!;
    const problem = passwordProblem(password, a);
    if (problem) throw badRequest(problem);
    await this.svc.db.query("UPDATE users SET password_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2", [await hashPassword(password), userId]);
  }

  private async assertPassword(userId: string, password: string) {
    const a = await this.account("id", userId);
    if (!a?.password_hash || !(await verifyPassword(password, a.password_hash))) throw badRequest("Mot de passe actuel incorrect");
  }

  async changePassword(userId: string, sessionId: string, current: string, password: string, info: RequestInfo) {
    await this.assertPassword(userId, current);
    await this.setPassword(userId, password);
    await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'reset' AND used_at IS NULL", [userId]);
    await this.revokeAll(userId, sessionId);
    await this.record("password.changed", { userId, ip: info.ip });
  }

  // ---------------------------------------------------------------- double authentification
  async startMfa(userId: string) {
    const a = await this.account("id", userId);
    if (!a) throw notFound("Compte introuvable");
    if (a.totp_enabled) throw badRequest("La double authentification est déjà active");
    const secret = generateSecret();
    await this.svc.db.query("UPDATE users SET totp_secret = $1 WHERE id = $2", [seal(secret), userId]);
    const uri = otpauthUri(secret, a.email);
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  async confirmMfa(userId: string, code: string, info: RequestInfo) {
    const a = await this.account("id", userId);
    if (!a?.totp_secret || a.totp_enabled) throw badRequest("Commencez par configurer la double authentification");
    const step = matchTotp(open(a.totp_secret), code.trim());
    if (step === null) throw badRequest("Code incorrect : vérifiez l'heure de votre téléphone");
    const codes = [...Array(10)].map(() => randomBytes(10).toString("hex").toUpperCase());
    await this.svc.db.query("UPDATE users SET totp_enabled = TRUE, totp_last_step = $1, recovery_codes = $2 WHERE id = $3", [step, JSON.stringify(codes.map((c) => recoveryHash(userId, c))), userId]);
    await this.record("mfa.enabled", { userId, ip: info.ip });
    return { recovery_codes: codes };
  }

  /** Une session volée et un mot de passe ne suffisent pas : il faut aussi le téléphone. */
  async disableMfa(userId: string, password: string, code: string, info: RequestInfo) {
    await this.assertPassword(userId, password);
    const a = await this.account("id", userId);
    if (!a?.totp_secret || matchTotp(open(a.totp_secret), code.trim()) === null) throw badRequest("Code incorrect");
    await this.clearMfa(userId);
    await this.record("mfa.disabled", { userId, ip: info.ip });
  }
  /** Durées de conservation : 30 jours pour les traces techniques, un an pour le journal de sécurité. */
  async purge() {
    await this.svc.db.query("DELETE FROM login_attempts WHERE created_at < now() - interval '30 days'");
    await this.svc.db.query("DELETE FROM security_events WHERE created_at < now() - interval '365 days'");
    await this.svc.db.query("DELETE FROM sessions WHERE expires_at < now() - interval '30 days'");
    await this.svc.db.query("DELETE FROM auth_tokens WHERE expires_at < now() - interval '30 days'");
  }

  async clearMfa(userId: string) {
    await this.svc.db.query("UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = NULL, recovery_codes = '[]', mfa_failures = 0, mfa_locked_until = NULL WHERE id = $1", [userId]);
  }
}

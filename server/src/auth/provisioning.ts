import nodemailer from "nodemailer";
import { uid } from "../db.js";
import type { MailService } from "../mail.js";
import { HttpError, badRequest, forbidden, notFound, type Services } from "../services.js";
import type { Access } from "./access.js";
import { fingerprint, newToken, type Auth, type RequestInfo } from "./service.js";

const INVITE_HOURS = 72, RESET_MINUTES = 30, SETUP_HOURS = 24;
const HOURLY_REQUEST_LIMIT = 5;
type TokenKind = "invite" | "reset" | "setup";
export type Registration = "invite" | "approval";
const PATH: Record<TokenKind, string> = { invite: "/activation", setup: "/activation", reset: "/reinitialisation" };

/** Vie des comptes : invitations, demandes d'accès, réinitialisation, et console de l'administrateur système. */
export class Provisioning {
  constructor(private svc: Services, private auth: Auth, private mail: MailService, private access: Access, private publicUrl: string | undefined) {}

  // ---------------------------------------------------------------- liens à usage unique
  private async createToken(kind: TokenKind, userId: string | null, createdBy: string | null, minutes: number) {
    await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE kind = $1 AND user_id IS NOT DISTINCT FROM $2 AND used_at IS NULL", [kind, userId]);
    const token = newToken();
    await this.svc.db.query(`INSERT INTO auth_tokens (id, token_hash, kind, user_id, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)`, [uid("tok"), fingerprint(token), kind, userId, createdBy, String(minutes)]);
    // Après le #, le jeton ne part jamais vers le serveur : ni journaux, ni proxy, ni en-tête Referer
    return `${this.publicUrl ?? ""}${PATH[kind]}#token=${token}`;
  }

  private async accountStatus(userId: string) {
    return (await this.svc.db.one<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]))?.status;
  }

  /** Seule la première organisation d'un compte en attente peut émettre son lien : les suivantes y gagneraient le compte entier. */
  private async isOrigin(orgId: string, userId: string) {
    return (await this.svc.db.one<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id = $1 ORDER BY joined_at, org_id LIMIT 1", [userId]))?.org_id === orgId;
  }

  private validToken(token: string) {
    return this.svc.db.one<{ id: string; kind: TokenKind; user_id: string | null }>("SELECT id, kind, user_id FROM auth_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()", [fingerprint(token)]);
  }
  /** Un lien ne peut être consommé qu'une fois, même par deux requêtes simultanées. */
  private async consume(id: string) {
    if (!(await this.svc.db.one("UPDATE auth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id", [id]))) throw badRequest("Ce lien n'est plus valable");
  }

  async peek(token: string) {
    const t = await this.validToken(token);
    if (!t) throw badRequest("Ce lien n'est plus valable : demandez-en un nouveau");
    if (!t.user_id) return { kind: t.kind, email: null, name: null };
    const u = await this.svc.db.one<{ email: string; name: string }>("SELECT email, name FROM users WHERE id = $1", [t.user_id]);
    return { kind: t.kind, email: u?.email ?? null, name: u?.name ?? null };
  }

  /** Dernière étape d'une invitation, d'une validation ou de la création du premier administrateur. */
  async activate(token: string, password: string, setup: { name?: string; email?: string }, info: RequestInfo) {
    const t = await this.validToken(token);
    if (!t || t.kind === "reset") throw badRequest("Ce lien n'est plus valable : demandez-en un nouveau");
    if (t.kind === "setup") {
      if (await this.hasSuperAdmin() && !process.env.CADENCE_BOOTSTRAP) throw badRequest("Un administrateur système existe déjà");
      const email = setup.email?.trim().toLowerCase(), name = setup.name?.trim();
      if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || !name) throw badRequest("Nom et adresse e-mail obligatoires");
      const existing = await this.svc.db.one<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND NOT is_ai", [email]);
      const id = existing?.id ?? uid("usr");
      if (!existing) await this.svc.db.query("INSERT INTO users (id, name, email, status) VALUES ($1,$2,$3,'invited')", [id, name, email]);
      await this.auth.setPassword(id, password);
      await this.consume(t.id);
      await this.svc.db.query("UPDATE users SET status = 'active', platform_role = 'super_admin' WHERE id = $1", [id]);
      await this.auth.record("account.activated", { userId: id, ip: info.ip, data: { super_admin: true } });
      return;
    }
    if ((await this.accountStatus(t.user_id!)) !== "invited") throw badRequest("Ce lien n'est plus valable : demandez-en un nouveau");
    await this.auth.setPassword(t.user_id!, password);
    await this.consume(t.id);
    await this.svc.db.query("UPDATE users SET status = 'active' WHERE id = $1", [t.user_id]);
    await this.auth.record("account.activated", { userId: t.user_id, ip: info.ip });
  }

  async reset(token: string, password: string, info: RequestInfo) {
    const t = await this.validToken(token);
    if (!t || t.kind !== "reset" || (await this.accountStatus(t.user_id!)) !== "active") throw badRequest("Ce lien n'est plus valable : demandez-en un nouveau");
    await this.auth.setPassword(t.user_id!, password);
    await this.consume(t.id);
    await this.auth.revokeAll(t.user_id!);
    await this.auth.record("password.reset", { userId: t.user_id, ip: info.ip });
  }

  // ---------------------------------------------------------------- e-mails
  /** Sans organisation, seul le SMTP de la plateforme sert : un lien de réinitialisation ne doit jamais transiter par un serveur qu'un administrateur d'organisation contrôle. */
  private async deliver(orgId: string | null, to: string, subject: string, text: string): Promise<boolean> {
    if (orgId && (await this.mail.send(orgId, { to, subject, text })).ok) return true;
    if (!process.env.SMTP_URL) return false;
    try {
      const transport = nodemailer.createTransport(process.env.SMTP_URL);
      await transport.sendMail({ from: process.env.SMTP_FROM ?? "Cadence <no-reply@localhost>", to, subject, text });
      transport.close();
      return true;
    } catch { return false; }
  }

  private async sendInvitation(userId: string, email: string, name: string, orgId: string | null, orgName: string, actorId: string | null) {
    const link = await this.createToken("invite", userId, actorId, INVITE_HOURS * 60);
    const sent = await this.deliver(orgId, email, `Votre accès à ${orgName}`, `Bonjour ${name},\n\nVous êtes invité(e) à rejoindre ${orgName} sur Cadence.\nChoisissez votre mot de passe en ouvrant ce lien, valable ${INVITE_HOURS} heures :\n\n${link}\n\nSi vous n'attendiez pas ce message, ignorez-le.\n\n— Cadence`);
    return { sent, link: sent ? undefined : link };
  }

  // ---------------------------------------------------------------- invitations par une organisation
  async invite(actorId: string, orgId: string, input: { email: string; name: string; profile_id: string }, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const email = input.email.trim().toLowerCase();
    await this.access.assertCanAssign(actorId, orgId, input.profile_id);
    const org = (await this.svc.db.one<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [orgId]))!;
    const profile = await this.access.profile(orgId, input.profile_id);
    const existing = await this.svc.db.one<{ id: string; status: string; name: string }>("SELECT id, status, name FROM users WHERE lower(email) = $1 AND NOT is_ai", [email]);
    if (existing?.status === "suspended") throw forbidden("Ce compte ne peut pas être invité. Contactez l'administrateur système.");
    if (existing && (await this.svc.orgRole(existing.id, orgId))) throw badRequest("Cette personne est déjà membre de l'organisation");
    let userId = existing?.id;
    if (!userId) {
      userId = uid("usr");
      await this.svc.db.query("INSERT INTO users (id, name, email, status) VALUES ($1,$2,$3,'invited')", [userId, input.name.trim(), email]);
    }
    await this.svc.db.query("INSERT INTO org_members (org_id, user_id, role, profile_id) VALUES ($1,$2,$3,$4)", [orgId, userId, profile.base_role, profile.id]);
    await this.auth.record("account.invited", { userId, actorId, ip: info.ip, data: { org_id: orgId } });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
    if (existing?.status === "active") {
      await this.svc.notify(userId, orgId, { kind: "org.invite", title: `Vous avez rejoint ${org.name}`, actor_id: actorId });
      return { user_id: userId, sent: true, already_active: true };
    }
    if (existing) await this.svc.db.query("UPDATE users SET status = 'invited' WHERE id = $1", [userId]);
    if (!(await this.isOrigin(orgId, userId))) return { user_id: userId, sent: false, awaiting_activation: true };
    return { user_id: userId, ...(await this.sendInvitation(userId, email, input.name.trim(), orgId, org.name, actorId)) };
  }

  async listInvitations(actorId: string, orgId: string) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    return this.svc.db.query(`SELECT u.id, u.name, u.email, om.profile_id, p.name AS profile_name, u.created_at FROM users u JOIN org_members om ON om.user_id = u.id LEFT JOIN access_profiles p ON p.id = om.profile_id WHERE om.org_id = $1 AND u.status = 'invited' ORDER BY u.created_at DESC`, [orgId]);
  }

  async resendInvitation(actorId: string, orgId: string, userId: string) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const u = await this.invited(orgId, userId);
    if (!(await this.isOrigin(orgId, userId))) throw forbidden("Seule l'organisation qui a invité cette personne en premier peut renvoyer son lien");
    const org = (await this.svc.db.one<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [orgId]))!;
    return { user_id: userId, ...(await this.sendInvitation(userId, u.email, u.name, orgId, org.name, actorId)) };
  }

  private async invited(orgId: string, userId: string) {
    const u = await this.svc.db.one<{ email: string; name: string }>("SELECT u.email, u.name FROM users u JOIN org_members om ON om.user_id = u.id WHERE u.id = $1 AND om.org_id = $2 AND u.status = 'invited'", [userId, orgId]);
    if (!u) throw notFound("Invitation introuvable");
    return u;
  }

  async cancelInvitation(actorId: string, orgId: string, userId: string, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    await this.invited(orgId, userId);
    // Le lien appartient à l'organisation d'origine : les autres ne peuvent pas l'annuler
    const origin = await this.isOrigin(orgId, userId);
    await this.svc.db.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
    if (origin) await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'invite' AND used_at IS NULL", [userId]);
    const others = await this.svc.db.one("SELECT 1 FROM org_members WHERE user_id = $1", [userId]);
    if (!others) await this.svc.db.query("DELETE FROM users WHERE id = $1", [userId]);
    await this.auth.record("invitation.cancelled", { userId, actorId, ip: info.ip, data: { org_id: orgId } });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
  }

  // ---------------------------------------------------------------- réglages et demandes d'accès
  async registration(): Promise<Registration> {
    return (await this.svc.db.one<{ value: Registration }>("SELECT value FROM platform_settings WHERE key = 'registration'"))?.value ?? "invite";
  }

  private async withinHourlyLimit(kind: string, ip: string) {
    const n = await this.svc.db.one<{ n: number }>("SELECT count(*)::int AS n FROM security_events WHERE kind = $1 AND ip = $2 AND created_at > now() - interval '1 hour'", [kind, ip]);
    return (n?.n ?? 0) < HOURLY_REQUEST_LIMIT;
  }

  /** La réponse est la même que l'adresse soit connue ou non. */
  async requestAccess(input: { name: string; email: string; note?: string }, info: RequestInfo) {
    if ((await this.registration()) !== "approval") throw forbidden("Les comptes sont créés sur invitation d'un administrateur");
    if (!(await this.withinHourlyLimit("access.requested", info.ip))) throw new HttpError(429, "Trop de demandes. Réessayez plus tard.");
    await this.auth.record("access.requested", { ip: info.ip, data: { email: input.email.slice(0, 320) } });
    const email = input.email.trim().toLowerCase();
    if (await this.svc.db.one("SELECT 1 FROM users WHERE lower(email) = $1", [email])) return;
    const id = uid("usr");
    await this.svc.db.query("INSERT INTO users (id, name, email, status, access_request_note) VALUES ($1,$2,$3,'pending',$4)", [id, input.name.trim(), email, input.note?.trim() ?? null]);
    for (const a of await this.svc.db.query<{ id: string }>("SELECT id FROM users WHERE platform_role = 'super_admin' AND status = 'active'")) {
      await this.svc.notify(a.id, null, { kind: "access.request", title: `${input.name.trim()} demande un accès`, body: email });
    }
  }

  async forgot(emailRaw: string, info: RequestInfo) {
    if (!(await this.withinHourlyLimit("password.forgot", info.ip))) return;
    await this.auth.record("password.forgot", { ip: info.ip, data: { email: emailRaw.slice(0, 320) } });
    const u = await this.svc.db.one<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE lower(email) = lower($1) AND status = 'active' AND NOT is_ai", [emailRaw.trim()]);
    if (!u) return;
    const link = await this.createToken("reset", u.id, null, RESET_MINUTES);
    const sent = await this.deliver(null, u.email, "Réinitialiser votre mot de passe", `Bonjour ${u.name},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien, valable ${RESET_MINUTES} minutes :\n\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\n— Cadence`);
    if (!sent && process.env.NODE_ENV !== "production") console.info(`[auth] aucun SMTP configuré : lien de réinitialisation pour ${u.email} : ${link}`);
  }

  // ---------------------------------------------------------------- administrateur système
  private async hasSuperAdmin() {
    return !!(await this.svc.db.one("SELECT 1 FROM users WHERE platform_role = 'super_admin' AND status = 'active'"));
  }

  /** Lien de création du premier administrateur, à afficher dans la console du serveur. */
  async bootstrapLink() {
    if (await this.hasSuperAdmin() && !process.env.CADENCE_BOOTSTRAP) return null;
    return this.createToken("setup", null, null, SETUP_HOURS * 60);
  }

  async requireSuperAdmin(actorId: string) {
    if (!(await this.svc.db.one("SELECT 1 FROM users WHERE id = $1 AND platform_role = 'super_admin' AND status = 'active'", [actorId]))) throw forbidden("Réservé à l'administrateur système");
  }

  async adminUsers(actorId: string) {
    await this.requireSuperAdmin(actorId);
    const rows = await this.svc.db.query<Record<string, unknown>>(`SELECT u.*, COALESCE((SELECT json_agg(json_build_object('org_id', o.id, 'org_name', o.name, 'role', om.role)) FROM org_members om JOIN organizations o ON o.id = om.org_id WHERE om.user_id = u.id), '[]') AS orgs,
      (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND NOT s.mfa_pending AND s.expires_at > now()) AS active_sessions
      FROM users u WHERE NOT u.is_ai ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC`);
    return rows.map(({ password_hash: _p, totp_secret: _t, recovery_codes: _r, totp_last_step: _s, avatar_version: _v, ...r }) => { void [_p, _t, _r, _s, _v]; return r; });
  }

  async adminOrgs(actorId: string) {
    await this.requireSuperAdmin(actorId);
    const orgs = await this.svc.db.query<{ id: string; name: string }>("SELECT id, name FROM organizations ORDER BY name");
    const out = [];
    for (const o of orgs) out.push({ ...o, profiles: await this.svc.db.query("SELECT id, name, base_role FROM access_profiles WHERE org_id = $1 ORDER BY created_at", [o.id]) });
    return out;
  }

  async adminEvents(actorId: string) {
    await this.requireSuperAdmin(actorId);
    return this.svc.db.query(`SELECT e.id, e.kind, e.ip, e.data, e.created_at, u.name AS user_name, a.name AS actor_name FROM security_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users a ON a.id = e.actor_id ORDER BY e.created_at DESC LIMIT 200`);
  }

  async setRegistration(actorId: string, value: Registration, info: RequestInfo) {
    await this.requireSuperAdmin(actorId);
    await this.svc.db.query("INSERT INTO platform_settings (key, value) VALUES ('registration', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(value)]);
    await this.auth.record("settings.registration", { actorId, ip: info.ip, data: { value } });
  }

  private async adminTarget(actorId: string, userId: string) {
    await this.requireSuperAdmin(actorId);
    const u = await this.svc.db.one<{ id: string; name: string; email: string; status: string; platform_role: string | null }>("SELECT id, name, email, status, platform_role FROM users WHERE id = $1 AND NOT is_ai", [userId]);
    if (!u) throw notFound("Compte introuvable");
    return u;
  }

  private async assertNotLastSuperAdmin(u: { id: string; platform_role: string | null }) {
    if (u.platform_role !== "super_admin") return;
    const n = await this.svc.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE platform_role = 'super_admin' AND status = 'active' AND id <> $1", [u.id]);
    if (!n?.n) throw badRequest("Il doit rester au moins un administrateur système");
  }

  /** La validation d'une demande débouche sur une invitation : l'adresse e-mail est ainsi prouvée. */
  async approve(actorId: string, userId: string, orgId: string, profileId: string, info: RequestInfo) {
    const u = await this.adminTarget(actorId, userId);
    if (u.status !== "pending") throw badRequest("Cette demande a déjà été traitée");
    const profile = await this.access.profile(orgId, profileId);
    await this.svc.db.query("INSERT INTO org_members (org_id, user_id, role, profile_id) VALUES ($1,$2,$3,$4)", [orgId, userId, profile.base_role, profile.id]);
    await this.svc.db.query("UPDATE users SET status = 'invited' WHERE id = $1", [userId]);
    await this.auth.record("access.approved", { userId, actorId, ip: info.ip, data: { org_id: orgId } });
    const org = (await this.svc.db.one<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [orgId]))!;
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
    return { user_id: userId, ...(await this.sendInvitation(userId, u.email, u.name, orgId, org.name, actorId)) };
  }

  async reject(actorId: string, userId: string, info: RequestInfo) {
    const u = await this.adminTarget(actorId, userId);
    if (u.status !== "pending") throw badRequest("Cette demande a déjà été traitée");
    await this.svc.db.query("UPDATE users SET status = 'rejected' WHERE id = $1", [userId]);
    await this.auth.record("access.rejected", { userId, actorId, ip: info.ip });
  }

  async suspend(actorId: string, userId: string, info: RequestInfo) {
    const u = await this.adminTarget(actorId, userId);
    if (u.id === actorId) throw badRequest("Vous ne pouvez pas suspendre votre propre compte");
    await this.assertNotLastSuperAdmin(u);
    await this.svc.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
    await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
    await this.auth.revokeAll(userId);
    await this.auth.record("account.suspended", { userId, actorId, ip: info.ip });
  }

  async reactivate(actorId: string, userId: string, info: RequestInfo) {
    const u = await this.adminTarget(actorId, userId);
    if (u.status !== "suspended") throw badRequest("Ce compte n'est pas suspendu");
    await this.svc.db.query("UPDATE users SET status = 'active', failed_logins = 0, locked_until = NULL WHERE id = $1", [userId]);
    await this.auth.record("account.reactivated", { userId, actorId, ip: info.ip });
  }

  async revokeSessions(actorId: string, userId: string, info: RequestInfo) {
    await this.adminTarget(actorId, userId);
    await this.auth.revokeAll(userId);
    await this.auth.record("sessions.revoked", { userId, actorId, ip: info.ip });
  }

  async setSuperAdmin(actorId: string, userId: string, on: boolean, info: RequestInfo) {
    const u = await this.adminTarget(actorId, userId);
    if (!on) await this.assertNotLastSuperAdmin(u);
    await this.svc.db.query("UPDATE users SET platform_role = $1 WHERE id = $2", [on ? "super_admin" : null, userId]);
    await this.auth.record(on ? "platform.granted" : "platform.revoked", { userId, actorId, ip: info.ip });
  }

  async resetLink(userId: string) {
    return { link: await this.createToken("reset", userId, null, RESET_MINUTES) };
  }

  /** Secours quand un compte n'a pas encore de mot de passe, a oublié le sien ou a perdu sa double authentification. */
  async adminReset(actorId: string, userId: string, clearMfa: boolean, info: RequestInfo) {
    const u = await this.adminTarget(actorId, userId);
    if (u.status !== "active") throw badRequest("Ce compte n'est pas actif");
    if (clearMfa) await this.auth.clearMfa(userId);
    const { link } = await this.resetLink(userId);
    const sent = await this.deliver(null, u.email, "Réinitialiser votre mot de passe", `Bonjour ${u.name},\n\nUn administrateur vous envoie ce lien pour choisir un nouveau mot de passe, valable ${RESET_MINUTES} minutes :\n\n${link}\n\n— Cadence`);
    await this.auth.record("password.reset_requested", { userId, actorId, ip: info.ip, data: { clear_mfa: clearMfa } });
    return { sent, link: sent ? undefined : link };
  }
}

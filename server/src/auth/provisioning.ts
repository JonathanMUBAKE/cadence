import nodemailer from "nodemailer";
import { uid, type Queryable } from "../db.js";
import { HttpError, badRequest, forbidden, notFound, type Services } from "../services.js";
import type { Access } from "./access.js";
import { fingerprint, maskEmail, newToken, type Auth, type RequestInfo } from "./service.js";

const INVITE_HOURS = 72, RESET_MINUTES = 30, SETUP_HOURS = 24;
const HOURLY_REQUEST_LIMIT = 5;
type TokenKind = "invite" | "reset" | "setup";
export type Registration = "invite" | "approval";
const PATH: Record<TokenKind, string> = { invite: "/activation", setup: "/activation", reset: "/reinitialisation" };
const LINK_EXPIRED = "Ce lien n'est plus valable : demandez-en un nouveau";
const INVITATION_COLUMNS = "i.id, i.org_id, i.email, i.name, i.profile_id, i.created_account";
interface OrgInvitation { id: string; org_id: string; email: string; name: string; profile_id: string; created_account: boolean }

/** Vie des comptes : invitations, demandes d'accès, réinitialisation, et console de l'administrateur système. */
export class Provisioning {
  constructor(private svc: Services, private auth: Auth, private access: Access, private publicUrl: string | undefined) {}

  // ---------------------------------------------------------------- liens à usage unique
  private async createToken(kind: TokenKind, userId: string | null, createdBy: string | null, minutes: number, invitationId: string | null = null) {
    await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE kind = $1 AND user_id IS NOT DISTINCT FROM $2 AND invitation_id IS NOT DISTINCT FROM $3 AND used_at IS NULL", [kind, userId, invitationId]);
    const token = newToken();
    await this.svc.db.query(`INSERT INTO auth_tokens (id, token_hash, kind, user_id, created_by, expires_at, invitation_id) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval, $7)`, [uid("tok"), fingerprint(token), kind, userId, createdBy, String(minutes), invitationId]);
    // Après le #, le jeton ne part jamais vers le serveur : ni journaux, ni proxy, ni en-tête Referer
    return `${this.publicUrl ?? ""}${PATH[kind]}#token=${token}`;
  }

  private async accountStatus(userId: string) {
    return (await this.svc.db.one<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]))?.status;
  }

  private validToken(token: string) {
    return this.svc.db.one<{ id: string; kind: TokenKind; user_id: string | null; invitation_id: string | null }>("SELECT id, kind, user_id, invitation_id FROM auth_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()", [fingerprint(token)]);
  }
  /** Un lien ne peut être consommé qu'une fois, même par deux requêtes simultanées. */
  private async consume(id: string, q: Queryable = this.svc.db) {
    if (!(await q.query("UPDATE auth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id", [id])).length) throw badRequest("Ce lien n'est plus valable");
  }
  /** Une invitation ne se consomme qu'une fois : le rattachement suit, dans la même transaction. */
  private async join(q: Queryable, inv: OrgInvitation, userId: string) {
    if (!(await q.query("UPDATE org_invitations SET status = 'accepted', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [inv.id])).length) throw notFound("Invitation introuvable");
    await q.query("INSERT INTO org_members (org_id, user_id, role, profile_id) SELECT $1, $2, p.base_role, p.id FROM access_profiles p WHERE p.id = $3 ON CONFLICT (org_id, user_id) DO NOTHING", [inv.org_id, userId, inv.profile_id]);
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
    const invitation = t.invitation_id ? await this.svc.db.one<OrgInvitation>(`SELECT ${INVITATION_COLUMNS} FROM org_invitations i WHERE i.id = $1 AND i.status = 'pending'`, [t.invitation_id]) : undefined;
    if (!invitation || (await this.accountStatus(t.user_id!)) !== "invited") throw badRequest(LINK_EXPIRED);
    await this.auth.setPassword(t.user_id!, password);
    await this.svc.db.tx(async (q) => {
      await this.consume(t.id, q);
      await q.query("UPDATE users SET status = 'active' WHERE id = $1", [t.user_id]);
      await this.join(q, invitation, t.user_id!);
    });
    await this.auth.record("account.activated", { userId: t.user_id, ip: info.ip, data: { org_id: invitation.org_id } });
    this.svc.bus.emit({ type: "org.changed", actorId: t.user_id!, orgId: invitation.org_id });
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
  /** Toujours le SMTP de la plateforme : un lien de compte ne doit jamais transiter par un serveur qu'un administrateur d'organisation contrôle. */
  private async deliver(to: string, subject: string, text: string): Promise<boolean> {
    if (!process.env.SMTP_URL) return false;
    try {
      const transport = nodemailer.createTransport(process.env.SMTP_URL);
      await transport.sendMail({ from: process.env.SMTP_FROM ?? "Cadence <no-reply@localhost>", to, subject, text });
      transport.close();
      return true;
    } catch { return false; }
  }

  /**
   * Prévient le titulaire de l'adresse. La réponse ne dit jamais si un compte existe.
   * Sans SMTP (usage local uniquement), le lien n'est montré que pour un compte créé par cette invitation.
   */
  private async notifyInvitee(inv: OrgInvitation, actorId: string | null) {
    const org = (await this.svc.db.one<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [inv.org_id]))!;
    const u = await this.svc.db.one<{ id: string; status: string; name: string }>("SELECT id, status, name FROM users WHERE lower(email) = $1 AND NOT is_ai", [inv.email]);
    if (!u || u.status === "suspended") return { sent: true };
    if (u.status === "active") {
      await this.svc.notify(u.id, null, { kind: "org.invite", title: `${org.name} vous invite à rejoindre son espace` });
      await this.deliver(inv.email, `Invitation à rejoindre ${org.name}`, `Bonjour ${u.name},\n\n${org.name} vous invite à rejoindre son espace sur Cadence.\nConnectez-vous pour accepter ou refuser : ${this.publicUrl ?? ""}/login\n\nSi vous n'attendiez pas ce message, ignorez-le.\n\n— Cadence`);
      return { sent: true };
    }
    await this.svc.db.query("UPDATE users SET status = 'invited' WHERE id = $1", [u.id]);
    const link = await this.createToken("invite", u.id, actorId, INVITE_HOURS * 60, inv.id);
    const sent = await this.deliver(inv.email, `Votre accès à ${org.name}`, `Bonjour ${u.name},\n\nVous êtes invité(e) à rejoindre ${org.name} sur Cadence.\nChoisissez votre mot de passe en ouvrant ce lien, valable ${INVITE_HOURS} heures :\n\n${link}\n\nSi vous n'attendiez pas ce message, ignorez-le.\n\n— Cadence`);
    return { sent, link: !sent && !process.env.SMTP_URL && inv.created_account ? link : undefined };
  }

  private async createInvitation(input: Omit<OrgInvitation, "id">, invitedBy: string, q: Queryable = this.svc.db) {
    const inv: OrgInvitation = { id: uid("inv"), ...input };
    await q.query(`INSERT INTO org_invitations (id, org_id, email, name, profile_id, invited_by, created_account, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval)`,
      [inv.id, inv.org_id, inv.email, inv.name, inv.profile_id, invitedBy, inv.created_account, String(INVITE_HOURS)]);
    return inv;
  }

  // ---------------------------------------------------------------- invitations par une organisation
  async invite(actorId: string, orgId: string, input: { email: string; name: string; profile_id: string }, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const email = input.email.trim().toLowerCase();
    await this.access.assertCanAssign(actorId, orgId, input.profile_id);
    if (await this.svc.db.one("SELECT 1 FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = $1 AND lower(u.email) = $2", [orgId, email])) throw badRequest("Cette personne est déjà membre de l'organisation");
    if (await this.svc.db.one("SELECT 1 FROM org_invitations WHERE org_id = $1 AND email = $2 AND status = 'pending'", [orgId, email])) throw badRequest("Une invitation est déjà en attente pour cette adresse");
    const existing = await this.svc.db.one<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND NOT is_ai", [email]);
    const userId = existing?.id ?? uid("usr");
    const inv = await this.svc.db.tx(async (q) => {
      if (!existing) await q.query("INSERT INTO users (id, name, email, status) VALUES ($1,$2,$3,'invited')", [userId, input.name.trim(), email]);
      return this.createInvitation({ org_id: orgId, email, name: input.name.trim(), profile_id: input.profile_id, created_account: !existing }, actorId, q);
    });
    await this.auth.record("account.invited", { userId, actorId, ip: info.ip, data: { org_id: orgId } });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
    return { invitation_id: inv.id, ...(await this.notifyInvitee(inv, actorId)) };
  }

  async listInvitations(actorId: string, orgId: string) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    return this.svc.db.query(`SELECT i.id, i.name, i.email, i.profile_id, p.name AS profile_name, i.created_at FROM org_invitations i LEFT JOIN access_profiles p ON p.id = i.profile_id WHERE i.org_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`, [orgId]);
  }

  private async pendingOf(orgId: string, id: string) {
    const inv = await this.svc.db.one<OrgInvitation>(`SELECT ${INVITATION_COLUMNS} FROM org_invitations i WHERE i.id = $1 AND i.org_id = $2 AND i.status = 'pending'`, [id, orgId]);
    if (!inv) throw notFound("Invitation introuvable");
    return inv;
  }

  async resendInvitation(actorId: string, orgId: string, id: string) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const inv = await this.pendingOf(orgId, id);
    await this.svc.db.query("UPDATE org_invitations SET expires_at = now() + ($1 || ' hours')::interval WHERE id = $2", [String(INVITE_HOURS), id]);
    return { invitation_id: id, ...(await this.notifyInvitee(inv, actorId)) };
  }

  async cancelInvitation(actorId: string, orgId: string, id: string, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const inv = await this.pendingOf(orgId, id);
    await this.svc.db.query("UPDATE org_invitations SET status = 'cancelled', decided_at = now() WHERE id = $1", [id]);
    await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE invitation_id = $1 AND used_at IS NULL", [id]);
    // Un compte jamais activé, créé pour cette invitation, disparaît avec elle s'il n'attend plus rien
    if (inv.created_account) await this.svc.db.query(`DELETE FROM users u WHERE lower(u.email) = $1 AND u.status = 'invited'
      AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM org_invitations i WHERE i.email = $1 AND i.status = 'pending')`, [inv.email]);
    await this.auth.record("invitation.cancelled", { actorId, ip: info.ip, data: { org_id: orgId } });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
  }

  // ---------------------------------------------------------------- invitations reçues
  async myInvitations(userId: string) {
    return this.svc.db.query(`SELECT i.id, o.name AS org_name, p.name AS profile_name, i.created_at FROM org_invitations i JOIN users u ON lower(u.email) = i.email JOIN organizations o ON o.id = i.org_id JOIN access_profiles p ON p.id = i.profile_id
      WHERE u.id = $1 AND i.status = 'pending' AND i.expires_at > now() ORDER BY i.created_at DESC`, [userId]);
  }

  /** Seul le titulaire de l'adresse invitée voit son invitation : pour les autres, elle n'existe pas. */
  private async mine(userId: string, id: string) {
    const inv = await this.svc.db.one<OrgInvitation>(`SELECT ${INVITATION_COLUMNS} FROM org_invitations i JOIN users u ON lower(u.email) = i.email WHERE i.id = $1 AND u.id = $2 AND i.status = 'pending' AND i.expires_at > now()`, [id, userId]);
    if (!inv) throw notFound("Invitation introuvable");
    return inv;
  }

  async acceptInvitation(userId: string, id: string, info: RequestInfo) {
    const inv = await this.mine(userId, id);
    await this.svc.db.tx((q) => this.join(q, inv, userId));
    await this.auth.record("invitation.accepted", { userId, ip: info.ip, data: { org_id: inv.org_id } });
    this.svc.bus.emit({ type: "org.changed", actorId: userId, orgId: inv.org_id });
  }

  async declineInvitation(userId: string, id: string, info: RequestInfo) {
    const inv = await this.mine(userId, id);
    await this.svc.db.query("UPDATE org_invitations SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'", [id]);
    await this.svc.db.query("UPDATE auth_tokens SET used_at = now() WHERE invitation_id = $1 AND used_at IS NULL", [id]);
    await this.auth.record("invitation.declined", { userId, ip: info.ip, data: { org_id: inv.org_id } });
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
    await this.auth.record("password.forgot", { ip: info.ip, data: { email: maskEmail(emailRaw) } });
    const u = await this.svc.db.one<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE lower(email) = lower($1) AND status = 'active' AND NOT is_ai", [emailRaw.trim()]);
    // En arrière-plan : la durée de la réponse ne doit pas révéler si le compte existe
    if (u) void this.sendReset(u).catch(() => undefined);
  }

  private async sendReset(u: { id: string; name: string; email: string }) {
    const link = await this.createToken("reset", u.id, null, RESET_MINUTES);
    const sent = await this.deliver(u.email, "Réinitialiser votre mot de passe", `Bonjour ${u.name},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien, valable ${RESET_MINUTES} minutes :\n\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\n— Cadence`);
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
    await this.svc.assertAdminMfa(actorId);
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
    const inv = await this.createInvitation({ org_id: orgId, email: u.email.toLowerCase(), name: u.name, profile_id: profile.id, created_account: true }, actorId);
    await this.auth.record("access.approved", { userId, actorId, ip: info.ip, data: { org_id: orgId } });
    return { invitation_id: inv.id, ...(await this.notifyInvitee(inv, actorId)) };
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
    const sent = await this.deliver(u.email, "Réinitialiser votre mot de passe", `Bonjour ${u.name},\n\nUn administrateur vous envoie ce lien pour choisir un nouveau mot de passe, valable ${RESET_MINUTES} minutes :\n\n${link}\n\n— Cadence`);
    await this.auth.record("password.reset_requested", { userId, actorId, ip: info.ip, data: { clear_mfa: clearMfa } });
    return { sent, link: sent ? undefined : link };
  }
}

import nodemailer from "nodemailer";
import { uid, type Db } from "./db.js";
import type { Bus, DomainEvent } from "./bus.js";
import { open, seal } from "./crypto.js";
import { assertPublicHost } from "./net-guard.js";
import { badRequest, notFound, type Services } from "./services.js";

/**
 * Messagerie par organisation.
 * - Un domaine d'envoi et un serveur SMTP propres à chaque organisation.
 * - Une adresse de service par niveau : l'organisation (contact@), chaque entité, chaque équipe.
 * - Les e-mails partent de l'adresse la plus précise : équipe du projet → entité de l'équipe → organisation.
 * Le mot de passe SMTP est chiffré en base et n'est jamais renvoyé par l'API.
 */
export type SmtpSecurity = "none" | "starttls" | "tls";
interface StoredMail {
  domain: string; from_name: string; notifications: boolean;
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; password_sealed?: string };
}
export interface MailConfig {
  domain: string; from_name: string; notifications: boolean;
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; password_set: boolean };
}
export interface MailConfigInput {
  domain: string; from_name?: string; notifications?: boolean;
  smtp: { host: string; port: number; security: SmtpSecurity; username?: string; password?: string };
}
export interface ServiceAddress {
  id: string; target_type: "org" | "unit" | "team"; target_id: string; name: string; kind: string;
  parent_name: string | null; local_part: string; address: string;
}

const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED = new Set(["postmaster", "abuse", "hostmaster", "webmaster", "mailer-daemon", "root"]);

export const slugLocal = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " et ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "service";

/** Traduit les erreurs SMTP techniques en messages compréhensibles. */
export function smtpError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  switch (err.code) {
    case "EAUTH": return "Échec d'authentification SMTP : identifiants refusés par le serveur.";
    case "ECONNECTION": case "ECONNREFUSED": case "ESOCKET": case "EDNS": return "Serveur SMTP injoignable : vérifiez l'hôte, le port et le mode de sécurité.";
    case "ETIMEDOUT": case "ETIMEOUT": return "Le serveur SMTP ne répond pas (délai dépassé).";
    case "ETLS": return "Échec de la négociation TLS : essayez un autre mode de sécurité.";
    case "EENVELOPE": return `Adresse refusée par le serveur SMTP${err.responseCode ? ` (${err.responseCode})` : ""}.`;
    default: return `Erreur SMTP : ${err.message ?? "inconnue"}`;
  }
}

export class MailService {
  private queue: Promise<unknown> = Promise.resolve();
  private addressSync: Promise<unknown> = Promise.resolve();
  /** Sur un serveur exposé, un SMTP saisi par un client ne peut pas viser le réseau interne. */
  blockPrivateHosts = false;
  private detach: (() => void) | null = null;
  private closed = false;

  constructor(private db: Db, private svc: Services, private bus: Bus) {}

  /** Envoie un e-mail pour chaque notification d'une organisation qui l'a activé. */
  attach() {
    this.detach = this.bus.on((e) => {
      if (e.type === "notification" && e.notificationId) this.enqueue(() => this.mailNotification(e));
      // Les adresses suivent l'organigramme ici, et non à la lecture : une lecture ne doit rien écrire
      if (e.type === "org.changed") this.addressSync = this.addressSync.then(async () => { if (await this.stored(e.orgId)) await this.ensureAddresses(e.orgId); }).catch(() => undefined);
    });
    return () => this.detach?.();
  }
  /** Attend la fin des envois en cours (fermeture propre, tests). */
  async idle() { await this.queue; }
  async shutdown() { this.detach?.(); this.closed = true; await Promise.race([Promise.all([this.queue, this.addressSync]), new Promise((r) => setTimeout(r, 3000))]); }

  private enqueue(fn: () => Promise<unknown>) {
    this.queue = this.queue.then(() => (this.closed ? undefined : fn())).catch(() => undefined);
  }

  // ---------------------------------------------------------------- configuration
  private async stored(orgId: string): Promise<StoredMail | null> {
    const r = await this.db.one<{ settings: { mail?: StoredMail } | null }>("SELECT settings FROM organizations WHERE id = $1", [orgId]);
    return r?.settings?.mail ?? null;
  }
  async getConfig(actorId: string, orgId: string): Promise<MailConfig | null> {
    await this.svc.requirePerm(actorId, orgId, "org.mail");
    const m = await this.stored(orgId);
    if (!m) return null;
    const { password_sealed, ...smtp } = m.smtp;
    return { domain: m.domain, from_name: m.from_name, notifications: m.notifications, smtp: { ...smtp, password_set: !!password_sealed } };
  }
  async updateConfig(actorId: string, orgId: string, input: MailConfigInput) {
    await this.svc.requirePerm(actorId, orgId, "org.mail");
    const domain = input.domain.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw badRequest("Nom de domaine invalide (exemple : mon-entreprise.fr)");
    const host = input.smtp.host.trim();
    if (!host) throw badRequest("L'hôte SMTP est obligatoire");
    if (this.blockPrivateHosts) await assertPublicHost(host);
    const previous = await this.stored(orgId);
    const org = await this.db.one<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [orgId]);
    const mail: StoredMail = {
      domain, from_name: input.from_name?.trim() || org?.name || "Cadence", notifications: input.notifications ?? true,
      smtp: {
        host, port: input.smtp.port, security: input.smtp.security, username: input.smtp.username?.trim() ?? "",
        // Mot de passe vide : on conserve l'ancien (le formulaire ne le renvoie jamais)
        password_sealed: input.smtp.password ? seal(input.smtp.password) : previous?.smtp.password_sealed,
      },
    };
    await this.db.query("UPDATE organizations SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb WHERE id = $2", [JSON.stringify({ mail }), orgId]);
    await this.svc.log(actorId, "org.mail.config", { orgId, data: { domain, host, port: mail.smtp.port, security: mail.smtp.security, password_changed: !!input.smtp.password } });
    await this.ensureAddresses(orgId);
    return this.getConfig(actorId, orgId);
  }

  // ---------------------------------------------------------------- adresses de service
  /** Crée les adresses manquantes : contact@ pour l'organisation, une par entité et par équipe. */
  async ensureAddresses(orgId: string) {
    const existing = await this.db.query<{ local_part: string; target_type: string; target_id: string }>("SELECT local_part, target_type, target_id FROM service_addresses WHERE org_id = $1", [orgId]);
    const taken = new Set(existing.map((a) => a.local_part));
    const has = new Set(existing.map((a) => `${a.target_type}:${a.target_id}`));
    const wanted: { type: "org" | "unit" | "team"; id: string; name: string }[] = [{ type: "org", id: orgId, name: "contact" }];
    // L'entité racine représente l'organisation elle-même : elle partage contact@
    for (const u of await this.db.query<{ id: string; name: string }>("SELECT id, name FROM org_units WHERE org_id = $1 AND parent_id IS NOT NULL ORDER BY created_at, id", [orgId])) wanted.push({ type: "unit", id: u.id, name: u.name });
    for (const t of await this.db.query<{ id: string; name: string }>("SELECT id, name FROM teams WHERE org_id = $1 ORDER BY created_at, id", [orgId])) wanted.push({ type: "team", id: t.id, name: t.name });
    // Les équipes d'abord : ce sont elles qui écrivent le plus, elles ont la priorité sur l'adresse la plus courte
    wanted.sort((a, b) => ["org", "team", "unit"].indexOf(a.type) - ["org", "team", "unit"].indexOf(b.type));
    for (const w of wanted) {
      if (has.has(`${w.type}:${w.id}`)) continue;
      const base = slugLocal(w.name);
      let local = base;
      for (let i = 2; taken.has(local) || RESERVED.has(local); i++) local = `${base}-${i}`;
      taken.add(local);
      await this.db.query("INSERT INTO service_addresses (id, org_id, local_part, target_type, target_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [uid("adr"), orgId, local, w.type, w.id]);
    }
    // Entités ou équipes supprimées depuis
    await this.db.query(`DELETE FROM service_addresses s WHERE s.org_id = $1 AND (
      (s.target_type = 'unit' AND NOT EXISTS (SELECT 1 FROM org_units u WHERE u.id = s.target_id)) OR
      (s.target_type = 'team' AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = s.target_id)))`, [orgId]);
  }
  async listAddresses(actorId: string, orgId: string): Promise<ServiceAddress[]> {
    await this.svc.requireOrg(actorId, orgId, "member");
    return this.addresses(orgId);
  }
  private async addresses(orgId: string): Promise<ServiceAddress[]> {
    const m = await this.stored(orgId);
    if (!m) return [];
    await this.addressSync;
    return this.db.query<ServiceAddress>(`
      SELECT s.id, s.target_type, s.target_id, s.local_part, s.local_part || '@' || $2 AS address,
        COALESCE(u.name, t.name, o.name) AS name,
        CASE s.target_type WHEN 'org' THEN 'Organisation' WHEN 'team' THEN 'Équipe' ELSE u.kind END AS kind,
        COALESCE(pu.name, tu.name) AS parent_name
      FROM service_addresses s
      LEFT JOIN organizations o ON s.target_type = 'org' AND o.id = s.target_id
      LEFT JOIN org_units u ON s.target_type = 'unit' AND u.id = s.target_id
      LEFT JOIN org_units pu ON pu.id = u.parent_id
      LEFT JOIN teams t ON s.target_type = 'team' AND t.id = s.target_id
      LEFT JOIN org_units tu ON tu.id = t.unit_id
      WHERE s.org_id = $1
      ORDER BY CASE s.target_type WHEN 'org' THEN 0 WHEN 'unit' THEN 1 ELSE 2 END, name`, [orgId, m.domain]);
  }
  async setAddress(actorId: string, orgId: string, id: string, localPart: string) {
    await this.svc.requirePerm(actorId, orgId, "org.mail");
    const m = await this.stored(orgId);
    if (!m) throw badRequest("Configurez d'abord la messagerie de l'organisation");
    const local = localPart.trim().toLowerCase();
    if (!LOCAL_RE.test(local)) throw badRequest("Adresse invalide : lettres minuscules, chiffres, points, tirets ou soulignés, sans espace");
    if (RESERVED.has(local)) throw badRequest(`« ${local} » est une adresse réservée`);
    const row = await this.db.one<{ id: string }>("SELECT id FROM service_addresses WHERE id = $1 AND org_id = $2", [id, orgId]);
    if (!row) throw notFound("Adresse introuvable");
    if (await this.db.one("SELECT 1 FROM service_addresses WHERE org_id = $1 AND local_part = $2 AND id <> $3", [orgId, local, id]))
      throw badRequest(`${local}@${m.domain} est déjà utilisée par un autre niveau`);
    await this.db.query("UPDATE service_addresses SET local_part = $1 WHERE id = $2", [local, id]);
    await this.svc.log(actorId, "org.mail.address", { orgId, data: { id, local_part: local } });
    return (await this.addresses(orgId)).find((a) => a.id === id)!;
  }

  /** Adresse d'envoi pour un projet : équipe → entité de l'équipe (ou ses ancêtres) → organisation. */
  async senderFor(orgId: string, projectId?: string | null): Promise<{ address: string; name: string } | null> {
    const m = await this.stored(orgId);
    if (!m) return null;
    const all = await this.addresses(orgId);
    const org = all.find((a) => a.target_type === "org")!;
    const fallback = { address: org.address, name: m.from_name };
    if (!projectId) return fallback;
    const p = await this.db.one<{ team_id: string | null; unit_id: string | null }>("SELECT p.team_id, t.unit_id FROM projects p LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = $1", [projectId]);
    const team = p?.team_id ? all.find((a) => a.target_type === "team" && a.target_id === p.team_id) : undefined;
    if (team) return { address: team.address, name: `${team.name} · ${m.from_name}` };
    if (p?.unit_id) {
      const chain = await this.db.query<{ id: string }>(`WITH RECURSIVE up(id, parent_id, d) AS (
        SELECT id, parent_id, 0 FROM org_units WHERE id = $1 UNION ALL SELECT u.id, u.parent_id, up.d + 1 FROM org_units u JOIN up ON u.id = up.parent_id)
        SELECT id FROM up ORDER BY d`, [p.unit_id]);
      for (const c of chain) { const a = all.find((x) => x.target_type === "unit" && x.target_id === c.id); if (a) return { address: a.address, name: `${a.name} · ${m.from_name}` }; }
    }
    return fallback;
  }

  // ---------------------------------------------------------------- envoi
  async send(orgId: string, msg: { to: string; subject: string; text: string; html?: string; projectId?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
    const m = await this.stored(orgId);
    if (!m) return { ok: false, error: "La messagerie de l'organisation n'est pas configurée" };
    const from = (await this.senderFor(orgId, msg.projectId))!;
    const log = (status: "sent" | "failed", error: string | null) =>
      this.db.query("INSERT INTO email_log (id, org_id, from_address, to_address, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [uid("eml"), orgId, from.address, msg.to, msg.subject.slice(0, 300), status, error]);
    try {
      if (this.blockPrivateHosts) await assertPublicHost(m.smtp.host); // Le nom a pu changer de cible depuis son enregistrement
      const transport = nodemailer.createTransport({
        host: m.smtp.host, port: m.smtp.port, secure: m.smtp.security === "tls",
        ignoreTLS: m.smtp.security === "none", requireTLS: m.smtp.security === "starttls",
        auth: m.smtp.username ? { user: m.smtp.username, pass: m.smtp.password_sealed ? open(m.smtp.password_sealed) : "" } : undefined,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      });
      await transport.sendMail({
        from: { name: from.name, address: from.address }, replyTo: { name: from.name, address: from.address },
        to: msg.to, subject: msg.subject, text: msg.text, html: msg.html,
        headers: { "Auto-Submitted": "auto-generated", "X-Cadence-Org": orgId },
      });
      transport.close();
      await log("sent", null);
      return { ok: true };
    } catch (e) {
      const error = smtpError(e);
      await log("failed", error).catch(() => undefined);
      return { ok: false, error };
    }
  }

  /** E-mail de test envoyé à l'administrateur, depuis contact@. */
  async test(actorId: string, orgId: string) {
    await this.svc.requirePerm(actorId, orgId, "org.mail");
    const me = await this.svc.user(actorId);
    if (!me.email) throw badRequest("Votre profil n'a pas d'adresse e-mail");
    const m = await this.stored(orgId);
    if (!m) throw badRequest("Configurez d'abord la messagerie de l'organisation");
    return this.send(orgId, {
      to: me.email, subject: `Test de messagerie · ${m.from_name}`,
      text: `Bonjour ${me.name},\n\nCet e-mail confirme que la messagerie de ${m.from_name} fonctionne.\nServeur : ${m.smtp.host}:${m.smtp.port}\nDomaine : ${m.domain}\n\n— Cadence`,
    });
  }

  async log(actorId: string, orgId: string) {
    await this.svc.requirePerm(actorId, orgId, "org.mail");
    return this.db.query("SELECT id, from_address, to_address, subject, status, error, created_at FROM email_log WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50", [orgId]);
  }

  private async mailNotification(e: Extract<DomainEvent, { type: "notification" }>) {
    if (!e.orgId) return;
    const m = await this.stored(e.orgId);
    if (!m?.notifications || !m.smtp.host) return;
    const user = await this.svc.userOrNull(e.userId);
    if (!user || user.is_ai || !user.email) return;
    const task = e.taskId ? await this.db.one<{ key: string; title: string }>("SELECT p.key || '-' || t.number AS key, t.title FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1", [e.taskId]) : undefined;
    // Un fil par tâche : « [APP-12] Titre de la tâche »
    const subject = task ? `[${task.key}] ${task.title}` : e.title ?? "Notification Cadence";
    const text = [`Bonjour ${user.name},`, "", e.title ?? "", e.body ? `\n${e.body}` : "", "", "Répondez à cet e-mail pour joindre l'équipe concernée.", "— Cadence"].join("\n");
    await this.send(e.orgId, { to: user.email, subject, text, projectId: e.projectId });
  }
}

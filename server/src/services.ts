import { now, uid, type Db, type Queryable, type Row } from "./db.js";
import type { Bus } from "./bus.js";

// ---------------------------------------------------------------------------
// Types exposés par l'API
// ---------------------------------------------------------------------------
export type Role = "viewer" | "commenter" | "editor" | "admin";
export type OrgRole = "owner" | "admin" | "member" | "guest";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type ProjectStatus = "on_track" | "at_risk" | "off_track" | "done";
export type TeamVisibility = "public" | "request" | "private";

export interface User {
  id: string; name: string; email: string | null; title: string | null;
  avatar_color: string; is_ai: boolean; ai_role: string | null; ai_instructions: string | null;
  /** Lien versionné vers la photo de profil, ou null (initiales). */
  avatar_url: string | null;
}
export interface OrgUser extends User { org_role: OrgRole; unit_id: string | null }
export interface Organization { id: string; name: string; slug: string; domains: string[]; role: OrgRole }
export interface OrgUnit {
  id: string; org_id: string; parent_id: string | null; name: string; kind: string; manager_id: string | null;
  position: number; depth: number; member_count: number; team_count: number;
}
export interface Team {
  id: string; org_id: string; unit_id: string | null; name: string; description: string; visibility: TeamVisibility; color: string;
  member_count: number; project_count: number; my_role: "lead" | "member" | null; request_pending: boolean;
}
export interface Project {
  id: string; org_id: string; team_id: string | null; key: string; access: "team" | "private";
  name: string; description: string; color: string; icon: string;
  status: ProjectStatus; due_on: string | null; owner_id: string | null; archived: boolean; created_at: string;
}
export interface Section { id: string; project_id: string; name: string; position: number }
export interface Task {
  id: string; number: number; key: string; project_id: string; section_id: string | null; parent_id: string | null;
  title: string; description: string; assignee_id: string | null; creator_id: string | null;
  priority: Priority; start_on: string | null; due_on: string | null; completed: boolean;
  completed_at: string | null; position: number; tags: string[]; created_at: string; updated_at: string;
  subtask_count?: number; subtask_done?: number; comment_count?: number;
}
export interface Comment { id: string; task_id: string; author_id: string; body: string; ai_run_id: string | null; created_at: string; edited_at: string | null }
export interface Activity { id: string; project_id: string | null; task_id: string | null; actor_id: string; kind: string; data: Record<string, unknown>; created_at: string }
export interface Notification {
  id: string; user_id: string; kind: string; title: string; body: string; task_id: string | null;
  project_id: string | null; approval_id: string | null; actor_id: string | null; read: boolean; created_at: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const forbidden = (msg = "Accès refusé") => new HttpError(403, msg);
export const notFound = (msg = "Introuvable") => new HttpError(404, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);

export const ROLE_RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4 };
const RANK_ROLE: Role[] = ["viewer", "viewer", "commenter", "editor", "admin"];
const ORG_RANK: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 };
export const today = () => new Date().toISOString().slice(0, 10);
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * Rôle effectif de $1 sur chaque projet de ses organisations : le plus fort parmi
 * le rôle d'organisation, l'adhésion explicite, l'appartenance à l'équipe,
 * la supervision hiérarchique (responsable d'une entité ancêtre) et la visibilité publique.
 */
const ACCESS_SQL = `
  WITH RECURSIVE managed(id) AS (
    SELECT id FROM org_units WHERE manager_id = $1
    UNION SELECT u.id FROM org_units u JOIN managed m ON u.parent_id = m.id
  )
  SELECT p.id, p.org_id, p.archived, GREATEST(
    CASE WHEN om.role IN ('owner','admin') THEN 4 ELSE 0 END,
    COALESCE((SELECT CASE ms.role WHEN 'admin' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END
              FROM memberships ms WHERE ms.project_id = p.id AND ms.user_id = $1), 0),
    CASE WHEN om.role <> 'guest' AND p.access = 'team' THEN COALESCE((SELECT CASE tm.role WHEN 'lead' THEN 4 ELSE 3 END
              FROM team_members tm WHERE tm.team_id = p.team_id AND tm.user_id = $1), 0) ELSE 0 END,
    CASE WHEN om.role <> 'guest' AND p.access = 'team' AND t.visibility <> 'private' AND t.unit_id IN (SELECT id FROM managed) THEN 1 ELSE 0 END,
    CASE WHEN om.role <> 'guest' AND p.access = 'team' AND t.visibility = 'public' THEN 1 ELSE 0 END
  ) AS rank
  FROM projects p
  JOIN org_members om ON om.org_id = p.org_id AND om.user_id = $1
  LEFT JOIN teams t ON t.id = p.team_id`;

// ---------------------------------------------------------------------------
// Conversion des lignes
// ---------------------------------------------------------------------------
const toTask = (r: Row): Task => ({
  ...(r as unknown as Task),
  number: Number(r.number),
  subtask_count: r.subtask_count === undefined ? undefined : Number(r.subtask_count),
  subtask_done: r.subtask_done === undefined ? undefined : Number(r.subtask_done),
  comment_count: r.comment_count === undefined ? undefined : Number(r.comment_count),
  tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
});
const TASK_COLS = `t.*, p.key || '-' || t.number AS key`;

/** Ajoute le lien de la photo (versionné : le navigateur peut la garder en cache indéfiniment). */
export const withAvatar = <T extends Row>(u: T) => {
  const { avatar_version, ...rest } = u as T & { avatar_version?: number };
  return { ...rest, avatar_url: Number(avatar_version) > 0 ? `/api/avatars/${rest.id}?v=${Number(avatar_version)}` : null };
};
const AVATAR_MAX = 512 * 1024;
const AVATAR_TYPES: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

export interface TaskFilters {
  project_id?: string; section_id?: string; assignee_id?: string | null; completed?: boolean;
  overdue?: boolean; due_before?: string; due_after?: string; text?: string;
  parent_id?: string | null; priority?: Priority; include_subtasks?: boolean; limit?: number;
}
export interface TaskInput {
  project_id: string; title: string; description?: string; section_id?: string | null; parent_id?: string | null;
  assignee_id?: string | null; priority?: Priority; start_on?: string | null; due_on?: string | null; tags?: string[];
}
export type TaskPatch = Partial<Omit<TaskInput, "project_id" | "parent_id">> & { completed?: boolean; position?: number };

// ---------------------------------------------------------------------------
// Services : toute la logique métier, exécutée « au nom de » un acteur
// ---------------------------------------------------------------------------
export class Services {
  constructor(public db: Db, public bus: Bus) {}

  // ================================================================ utilisateurs
  async user(id: string): Promise<User> {
    const r = await this.userOrNull(id);
    if (!r) throw notFound("Utilisateur introuvable");
    return r;
  }
  async userOrNull(id: string): Promise<User | null> {
    const r = await this.db.one<Row>("SELECT * FROM users WHERE id = $1", [id]);
    return r ? (withAvatar(r) as unknown as User) : null;
  }
  async usersOf(orgId: string): Promise<OrgUser[]> {
    return (await this.db.query<Row>(`SELECT u.*, om.role AS org_role, om.unit_id FROM users u JOIN org_members om ON om.user_id = u.id
      WHERE om.org_id = $1 ORDER BY u.is_ai, u.name`, [orgId])).map((u) => withAvatar(u) as unknown as OrgUser);
  }

  // ================================================================ photos de profil
  /** Seul l'intéressé, ou un administrateur d'une organisation dont il est membre, peut changer sa photo. */
  private async canEditProfile(actorId: string, userId: string) {
    if (actorId === userId) return;
    const shared = await this.db.one(`SELECT 1 FROM org_members a JOIN org_members b ON b.org_id = a.org_id AND b.user_id = $2
      WHERE a.user_id = $1 AND a.role IN ('owner','admin')`, [actorId, userId]);
    if (!shared) throw forbidden("Seul l'intéressé ou un administrateur peut changer cette photo");
  }
  async setAvatar(actorId: string, userId: string, dataUrl: string) {
    await this.user(userId);
    await this.canEditProfile(actorId, userId);
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) throw badRequest("Image attendue au format data:image/…;base64");
    const data = Buffer.from(m[2], "base64");
    if (data.length > AVATAR_MAX) throw new HttpError(413, "Image trop lourde : 512 Ko au maximum");
    const mime = AVATAR_TYPES.find(([, test]) => test(data))?.[0];
    if (!mime) throw new HttpError(415, "Format non pris en charge : PNG, JPEG, GIF ou WebP");
    await this.db.tx(async (q) => {
      await q.query(`INSERT INTO avatars (user_id, mime, data) VALUES ($1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`, [userId, mime, data]);
      await q.query("UPDATE users SET avatar_version = abs(avatar_version) + 1 WHERE id = $1", [userId]);
    });
    await this.log(actorId, "user.avatar", { data: { userId } });
    await this.emitUserChanged(actorId, userId);
    return this.user(userId);
  }
  async removeAvatar(actorId: string, userId: string) {
    await this.user(userId);
    await this.canEditProfile(actorId, userId);
    await this.db.query("DELETE FROM avatars WHERE user_id = $1", [userId]);
    // La version n'est jamais remise à zéro : un ancien lien ne doit pas resservir une ancienne image
    await this.db.query("UPDATE users SET avatar_version = -abs(avatar_version) WHERE id = $1", [userId]);
    await this.log(actorId, "user.avatar", { data: { userId, removed: true } });
    await this.emitUserChanged(actorId, userId);
  }
  async avatar(actorId: string, userId: string) {
    // Visible des personnes qui partagent une organisation avec l'intéressé
    if (actorId !== userId && !(await this.db.one("SELECT 1 FROM org_members a JOIN org_members b ON b.org_id = a.org_id AND b.user_id = $2 WHERE a.user_id = $1", [actorId, userId])))
      throw notFound("Photo introuvable");
    const r = await this.db.one<{ mime: string; data: Uint8Array }>("SELECT mime, data FROM avatars WHERE user_id = $1", [userId]);
    if (!r) throw notFound("Photo introuvable");
    return { mime: r.mime, data: Buffer.from(r.data) };
  }
  private async emitUserChanged(actorId: string, userId: string) {
    for (const o of await this.db.query<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id = $1", [userId])) this.bus.emit({ type: "org.changed", actorId, orgId: o.org_id });
  }
  async agents(orgId: string) { return (await this.usersOf(orgId)).filter((u) => u.is_ai && u.id !== "ai_cadence"); }

  // ================================================================ organisations
  async orgsOf(userId: string): Promise<Organization[]> {
    return this.db.query<Organization>(`SELECT o.id, o.name, o.slug, o.domains, om.role FROM organizations o
      JOIN org_members om ON om.org_id = o.id WHERE om.user_id = $1 ORDER BY o.created_at`, [userId]);
  }
  async orgRole(userId: string, orgId: string): Promise<OrgRole | null> {
    return (await this.db.one<{ role: OrgRole }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]))?.role ?? null;
  }
  async requireOrg(userId: string, orgId: string, min: OrgRole = "guest"): Promise<OrgRole> {
    const role = await this.orgRole(userId, orgId);
    if (!role) throw forbidden("Vous n'êtes pas membre de cette organisation");
    if (ORG_RANK[role] < ORG_RANK[min]) throw forbidden(min === "admin" || min === "owner" ? "Réservé aux administrateurs de l'organisation" : "Accès réservé aux membres de l'organisation");
    return role;
  }
  async createOrg(userId: string, input: { name: string; domains?: string[] }) {
    const name = input.name?.trim();
    if (!name) throw badRequest("Le nom de l'organisation est obligatoire");
    const id = uid("org");
    const slug = `${name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org"}-${id.slice(-4)}`;
    await this.db.tx(async (q) => {
      await q.query("INSERT INTO organizations (id, name, slug, domains) VALUES ($1,$2,$3,$4)", [id, name, slug, JSON.stringify(input.domains ?? [])]);
      const root = uid("unt");
      await q.query("INSERT INTO org_units (id, org_id, name, kind, manager_id) VALUES ($1,$2,$3,'Organisation',$4)", [root, id, name, userId]);
      await q.query("INSERT INTO org_members (org_id, user_id, role, unit_id) VALUES ($1,$2,'owner',$3)", [id, userId, root]);
    });
    await this.log(userId, "org.created", { orgId: id, data: { name } });
    return (await this.orgsOf(userId)).find((o) => o.id === id)!;
  }
  async updateOrg(actorId: string, orgId: string, patch: { name?: string; domains?: string[] }) {
    await this.requireOrg(actorId, orgId, "admin");
    if (patch.name !== undefined) await this.db.query("UPDATE organizations SET name = $1 WHERE id = $2", [patch.name.trim(), orgId]);
    if (patch.domains !== undefined) await this.db.query("UPDATE organizations SET domains = $1 WHERE id = $2", [JSON.stringify(patch.domains), orgId]);
    this.bus.emit({ type: "org.changed", actorId, orgId });
  }
  async setOrgMember(actorId: string, orgId: string, userId: string, role: OrgRole | null) {
    const mine = await this.requireOrg(actorId, orgId, "admin");
    const current = await this.orgRole(userId, orgId);
    if (role === "owner" && mine !== "owner") throw forbidden("Seul un propriétaire peut nommer un propriétaire");
    if (current === "owner" && role !== "owner") {
      const owners = await this.db.one<{ n: number }>("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
      if ((owners?.n ?? 0) <= 1) throw badRequest("Impossible de retirer le dernier propriétaire de l'organisation");
    }
    if (role === null) {
      await this.db.tx(async (q) => {
        await q.query("DELETE FROM team_members WHERE user_id = $1 AND team_id IN (SELECT id FROM teams WHERE org_id = $2)", [userId, orgId]);
        await q.query("DELETE FROM memberships WHERE user_id = $1 AND project_id IN (SELECT id FROM projects WHERE org_id = $2)", [userId, orgId]);
        await q.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
      });
    } else {
      await this.db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)
        ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [orgId, userId, role]);
    }
    await this.log(actorId, "org.member", { orgId, data: { userId, role } });
    this.bus.emit({ type: "org.changed", actorId, orgId });
  }

  // ================================================================ entités (hiérarchie)
  async units(actorId: string, orgId: string): Promise<OrgUnit[]> {
    await this.requireOrg(actorId, orgId, "member");
    return (await this.db.query<OrgUnit>(`
      WITH RECURSIVE tree AS (
        SELECT u.*, 0 AS depth, ARRAY[u.position::text || u.id] AS sort FROM org_units u WHERE u.org_id = $1 AND u.parent_id IS NULL
        UNION ALL
        SELECT c.*, tree.depth + 1, tree.sort || (lpad(c.position::text, 12, '0') || c.id) FROM org_units c JOIN tree ON c.parent_id = tree.id
      )
      SELECT tree.id, tree.org_id, tree.parent_id, tree.name, tree.kind, tree.manager_id, tree.position, tree.depth,
        (SELECT count(*)::int FROM org_members m WHERE m.unit_id = tree.id) AS member_count,
        (SELECT count(*)::int FROM teams t WHERE t.unit_id = tree.id) AS team_count
      FROM tree ORDER BY tree.sort`, [orgId])).map((u) => ({ ...u, position: Number(u.position), depth: Number(u.depth) }));
  }
  private async unitRow(id: string) {
    const u = await this.db.one<{ id: string; org_id: string; parent_id: string | null; name: string }>("SELECT * FROM org_units WHERE id = $1", [id]);
    if (!u) throw notFound("Entité introuvable");
    return u;
  }
  async createUnit(actorId: string, orgId: string, input: { name: string; kind?: string; parent_id?: string | null; manager_id?: string | null }) {
    await this.requireOrg(actorId, orgId, "admin");
    if (!input.name?.trim()) throw badRequest("Le nom de l'entité est obligatoire");
    if (input.parent_id) { const p = await this.unitRow(input.parent_id); if (p.org_id !== orgId) throw badRequest("Entité parente invalide"); }
    if (input.manager_id && !(await this.orgRole(input.manager_id, orgId))) throw badRequest("Le responsable doit être membre de l'organisation");
    const id = uid("unt");
    const pos = (await this.db.one<{ m: number | null }>("SELECT max(position) AS m FROM org_units WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2", [orgId, input.parent_id ?? null]))?.m ?? 0;
    await this.db.query("INSERT INTO org_units (id, org_id, parent_id, name, kind, manager_id, position) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, orgId, input.parent_id ?? null, input.name.trim(), input.kind?.trim() || "Service", input.manager_id ?? null, Number(pos) + 1024]);
    await this.log(actorId, "unit.created", { orgId, data: { name: input.name } });
    this.bus.emit({ type: "org.changed", actorId, orgId });
    return id;
  }
  async updateUnit(actorId: string, unitId: string, patch: { name?: string; kind?: string; parent_id?: string | null; manager_id?: string | null }) {
    const u = await this.unitRow(unitId);
    await this.requireOrg(actorId, u.org_id, "admin");
    if (patch.parent_id !== undefined && patch.parent_id !== u.parent_id) {
      if (patch.parent_id === null) {
        const roots = await this.db.one<{ n: number }>("SELECT count(*)::int AS n FROM org_units WHERE org_id = $1 AND parent_id IS NULL", [u.org_id]);
        if ((roots?.n ?? 0) >= 1) throw badRequest("L'organisation a déjà une entité racine");
      } else {
        const target = await this.unitRow(patch.parent_id);
        if (target.org_id !== u.org_id) throw badRequest("Entité parente invalide");
        // Refuser un cycle : la nouvelle parente ne peut pas être l'entité elle-même ni une de ses descendantes
        const cyc = await this.db.one(`WITH RECURSIVE d(id) AS (SELECT $1::text UNION SELECT c.id FROM org_units c JOIN d ON c.parent_id = d.id)
          SELECT 1 FROM d WHERE id = $2`, [unitId, patch.parent_id]);
        if (cyc) throw badRequest("Une entité ne peut pas être placée sous l'une de ses propres sous-entités");
      }
    }
    if (patch.manager_id && !(await this.orgRole(patch.manager_id, u.org_id))) throw badRequest("Le responsable doit être membre de l'organisation");
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of ["name", "kind", "parent_id", "manager_id"] as const) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
    if (sets.length) { vals.push(unitId); await this.db.query(`UPDATE org_units SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals); }
    this.bus.emit({ type: "org.changed", actorId, orgId: u.org_id });
  }
  async deleteUnit(actorId: string, unitId: string) {
    const u = await this.unitRow(unitId);
    await this.requireOrg(actorId, u.org_id, "admin");
    const c = await this.db.one<{ kids: number; teams: number; people: number }>(`SELECT
      (SELECT count(*)::int FROM org_units WHERE parent_id = $1) AS kids,
      (SELECT count(*)::int FROM teams WHERE unit_id = $1) AS teams,
      (SELECT count(*)::int FROM org_members WHERE unit_id = $1) AS people`, [unitId]);
    if (c!.kids || c!.teams || c!.people) throw badRequest(`Entité non vide : ${c!.kids} sous-entité(s), ${c!.teams} équipe(s), ${c!.people} personne(s) rattachée(s)`);
    if (!u.parent_id) throw badRequest("L'entité racine ne peut pas être supprimée");
    await this.db.query("DELETE FROM org_units WHERE id = $1", [unitId]);
    this.bus.emit({ type: "org.changed", actorId, orgId: u.org_id });
  }
  async setMemberUnit(actorId: string, orgId: string, userId: string, unitId: string | null) {
    await this.requireOrg(actorId, orgId, "admin");
    if (unitId && (await this.unitRow(unitId)).org_id !== orgId) throw badRequest("Entité invalide");
    await this.db.query("UPDATE org_members SET unit_id = $1 WHERE org_id = $2 AND user_id = $3", [unitId, orgId, userId]);
    this.bus.emit({ type: "org.changed", actorId, orgId });
  }

  // ================================================================ équipes
  async teams(actorId: string, orgId: string): Promise<Team[]> {
    const role = await this.requireOrg(actorId, orgId);
    const admin = role === "owner" || role === "admin";
    return (await this.db.query<Team>(`SELECT t.*,
        (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count,
        (SELECT count(*)::int FROM projects p WHERE p.team_id = t.id AND NOT p.archived) AS project_count,
        (SELECT m.role FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2) AS my_role,
        EXISTS (SELECT 1 FROM team_requests r WHERE r.team_id = t.id AND r.user_id = $2 AND r.status = 'pending') AS request_pending
      FROM teams t WHERE t.org_id = $1 ORDER BY t.name`, [orgId, actorId]))
      .filter((t) => admin || t.my_role || (role !== "guest" && t.visibility !== "private"));
  }
  private async teamRow(id: string) {
    const t = await this.db.one<Team>("SELECT * FROM teams WHERE id = $1", [id]);
    if (!t) throw notFound("Équipe introuvable");
    return t;
  }
  async teamRole(userId: string, teamId: string) {
    return (await this.db.one<{ role: "lead" | "member" }>("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]))?.role ?? null;
  }
  private async requireTeamManager(actorId: string, teamId: string) {
    const t = await this.teamRow(teamId);
    const org = await this.requireOrg(actorId, t.org_id);
    if (org !== "owner" && org !== "admin" && (await this.teamRole(actorId, teamId)) !== "lead") throw forbidden("Réservé aux responsables de l'équipe");
    return t;
  }
  async team(actorId: string, teamId: string) {
    const t = await this.teamRow(teamId);
    const visible = (await this.teams(actorId, t.org_id)).find((x) => x.id === teamId);
    if (!visible) throw forbidden("Cette équipe est privée");
    const members = await this.db.query<{ user_id: string; role: string }>("SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY role, user_id", [teamId]);
    const readable = new Set(await this.readableProjectIds(actorId, t.org_id));
    const projects = (await this.listProjects(actorId, t.org_id)).filter((p) => p.team_id === teamId && readable.has(p.id));
    const requests = visible.my_role === "lead" || ["owner", "admin"].includes((await this.orgRole(actorId, t.org_id)) ?? "")
      ? await this.db.query("SELECT id, user_id, created_at FROM team_requests WHERE team_id = $1 AND status = 'pending'", [teamId]) : [];
    return { ...visible, members, projects, requests };
  }
  async createTeam(actorId: string, orgId: string, input: { name: string; description?: string; visibility?: TeamVisibility; unit_id?: string | null; color?: string }) {
    const role = await this.requireOrg(actorId, orgId, "member");
    if (!input.name?.trim()) throw badRequest("Le nom de l'équipe est obligatoire");
    if (input.unit_id && (await this.unitRow(input.unit_id)).org_id !== orgId) throw badRequest("Entité invalide");
    void role;
    const id = uid("tem");
    await this.db.tx(async (q) => {
      await q.query("INSERT INTO teams (id, org_id, unit_id, name, description, visibility, color) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, orgId, input.unit_id ?? null, input.name.trim(), input.description ?? "", input.visibility ?? "public", input.color ?? "#6E56CF"]);
      await q.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'lead')", [id, actorId]);
    });
    this.bus.emit({ type: "org.changed", actorId, orgId });
    return this.team(actorId, id);
  }
  async updateTeam(actorId: string, teamId: string, patch: { name?: string; description?: string; visibility?: TeamVisibility; unit_id?: string | null; color?: string }) {
    const t = await this.requireTeamManager(actorId, teamId);
    if (patch.unit_id && (await this.unitRow(patch.unit_id)).org_id !== t.org_id) throw badRequest("Entité invalide");
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of ["name", "description", "visibility", "unit_id", "color"] as const) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
    if (sets.length) { vals.push(teamId); await this.db.query(`UPDATE teams SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals); }
    this.bus.emit({ type: "org.changed", actorId, orgId: t.org_id });
  }
  async setTeamMember(actorId: string, teamId: string, userId: string, role: "lead" | "member" | null) {
    const t = await this.requireTeamManager(actorId, teamId);
    const orgRole = await this.orgRole(userId, t.org_id);
    if (!orgRole) throw badRequest("La personne doit d'abord être membre de l'organisation");
    if (orgRole === "guest") throw badRequest("Un invité ne peut pas rejoindre une équipe : ajoutez-le directement aux projets");
    if (role === null) {
      const leads = await this.db.one<{ n: number }>("SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'lead' AND user_id <> $2", [teamId, userId]);
      if ((await this.teamRole(userId, teamId)) === "lead" && !leads?.n) throw badRequest("L'équipe doit garder au moins un responsable");
      await this.db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
    } else {
      await this.db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role", [teamId, userId, role]);
    }
    this.bus.emit({ type: "org.changed", actorId, orgId: t.org_id });
  }
  async joinTeam(actorId: string, teamId: string): Promise<"joined" | "requested"> {
    const t = await this.teamRow(teamId);
    const orgRole = await this.requireOrg(actorId, t.org_id, "member");
    if (await this.teamRole(actorId, teamId)) return "joined";
    if (t.visibility === "public" || orgRole === "owner" || orgRole === "admin") {
      await this.db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'member')", [teamId, actorId]);
      this.bus.emit({ type: "org.changed", actorId, orgId: t.org_id });
      return "joined";
    }
    if (t.visibility === "private") throw forbidden("Cette équipe est privée : seul un responsable peut vous ajouter");
    const pending = await this.db.one("SELECT 1 FROM team_requests WHERE team_id = $1 AND user_id = $2 AND status = 'pending'", [teamId, actorId]);
    if (!pending) {
      await this.db.query("INSERT INTO team_requests (id, team_id, user_id) VALUES ($1,$2,$3)", [uid("req"), teamId, actorId]);
      const me = await this.user(actorId);
      for (const l of await this.db.query<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'lead'", [teamId])) {
        await this.notify(l.user_id, t.org_id, { kind: "team.request", title: `${me.name} demande à rejoindre « ${t.name} »`, actor_id: actorId });
      }
    }
    return "requested";
  }
  async decideTeamRequest(actorId: string, requestId: string, approve: boolean) {
    const r = await this.db.one<{ team_id: string; user_id: string; status: string }>("SELECT * FROM team_requests WHERE id = $1", [requestId]);
    if (!r) throw notFound("Demande introuvable");
    const t = await this.requireTeamManager(actorId, r.team_id);
    if (r.status !== "pending") throw badRequest("Demande déjà traitée");
    await this.db.tx(async (q) => {
      await q.query("UPDATE team_requests SET status = $1 WHERE id = $2", [approve ? "approved" : "rejected", requestId]);
      if (approve) await q.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [r.team_id, r.user_id]);
    });
    await this.notify(r.user_id, t.org_id, { kind: "team.request", title: approve ? `Vous avez rejoint l'équipe « ${t.name} »` : `Votre demande pour « ${t.name} » a été refusée`, actor_id: actorId });
    this.bus.emit({ type: "org.changed", actorId, orgId: t.org_id });
  }

  // ================================================================ droits sur les projets
  async projectRole(userId: string, projectId: string): Promise<Role | null> {
    const r = await this.db.one<{ rank: number }>(`SELECT rank FROM (${ACCESS_SQL}) a WHERE a.id = $2`, [userId, projectId]);
    return r && r.rank > 0 ? RANK_ROLE[r.rank] : null;
  }
  /** Alias historique utilisé par l'IA et les routes. */
  role(userId: string, projectId: string) { return this.projectRole(userId, projectId); }
  async require(actorId: string, projectId: string, min: Role = "viewer"): Promise<Role> {
    const project = await this.db.one<{ name: string }>("SELECT name FROM projects WHERE id = $1", [projectId]);
    if (!project) throw notFound("Projet introuvable");
    const role = await this.projectRole(actorId, projectId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
      const verb = min === "viewer" ? "consulter" : min === "commenter" ? "commenter" : min === "editor" ? "modifier" : "administrer";
      throw forbidden(`${(await this.user(actorId)).name} n'a pas le droit de ${verb} le projet « ${project.name} »`);
    }
    return role;
  }
  async readableProjectIds(actorId: string, orgId?: string | null, includeArchived = false): Promise<string[]> {
    return (await this.db.query<{ id: string }>(`SELECT id FROM (${ACCESS_SQL}) a WHERE a.rank > 0 AND ($2::text IS NULL OR a.org_id = $2) AND ($3 OR NOT a.archived)`,
      [actorId, orgId ?? null, includeArchived])).map((r) => r.id);
  }

  // ================================================================ projets
  async listProjects(actorId: string, orgId: string, opts: { archived?: boolean } = {}) {
    await this.requireOrg(actorId, orgId);
    const rows = await this.db.query<Row>(`
      SELECT p.*, a.rank, tm.name AS team_name,
        (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL) AS task_count,
        (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL AND t.completed) AS done_count,
        (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND NOT t.completed AND t.due_on < $3::date) AS overdue_count
      FROM (${ACCESS_SQL}) a JOIN projects p ON p.id = a.id LEFT JOIN teams tm ON tm.id = p.team_id
      WHERE a.rank > 0 AND p.org_id = $2 AND p.archived = $4 ORDER BY tm.name NULLS LAST, p.created_at`, [actorId, orgId, today(), !!opts.archived]);
    const out = [];
    for (const r of rows) {
      out.push({
        ...(r as unknown as Project), role: RANK_ROLE[Number(r.rank)], team_name: (r.team_name as string) ?? null,
        task_count: Number(r.task_count), done_count: Number(r.done_count), overdue_count: Number(r.overdue_count),
        members: (await this.members(String(r.id))).map((m) => m.user_id),
      });
    }
    return out;
  }
  /** Membres affichés d'un projet : adhésions explicites, puis membres de l'équipe (si accès « équipe »). */
  async members(projectId: string) {
    return this.db.query<{ user_id: string; role: Role; source: "explicit" | "team" }>(`
      SELECT user_id, role, 'explicit' AS source FROM memberships WHERE project_id = $1
      UNION ALL
      SELECT tm.user_id, CASE tm.role WHEN 'lead' THEN 'admin' ELSE 'editor' END, 'team' FROM team_members tm
        JOIN projects p ON p.team_id = tm.team_id AND p.access = 'team'
        WHERE p.id = $1 AND tm.user_id NOT IN (SELECT user_id FROM memberships WHERE project_id = $1)
      ORDER BY 2 DESC`, [projectId]);
  }
  async getProject(actorId: string, projectId: string) {
    const role = await this.require(actorId, projectId);
    const p = (await this.db.one<Project & { team_name: string | null }>("SELECT p.*, t.name AS team_name FROM projects p LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = $1", [projectId]))!;
    return {
      ...p, role,
      sections: (await this.db.query<Section>("SELECT * FROM sections WHERE project_id = $1 ORDER BY position", [projectId])).map((s) => ({ ...s, position: Number(s.position) })),
      members: await this.members(projectId),
    };
  }
  private async suggestKey(orgId: string, name: string) {
    const base = (name.normalize("NFD").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase() || "PRJ").replace(/^[0-9]+/, "").padEnd(3, "X").slice(0, 4);
    let key = /^[A-Z]/.test(base) ? base : `P${base}`.slice(0, 4);
    for (let i = 2; await this.db.one("SELECT 1 FROM projects WHERE org_id = $1 AND key = $2", [orgId, key]); i++) key = `${base.slice(0, 3)}${i}`;
    return key;
  }
  async createProject(actorId: string, orgId: string, input: { name: string; description?: string; color?: string; icon?: string; due_on?: string | null; sections?: string[]; team_id?: string | null; key?: string; access?: "team" | "private" }) {
    const orgRole = await this.requireOrg(actorId, orgId, "member");
    const name = input.name?.trim();
    if (!name) throw badRequest("Le nom du projet est obligatoire");
    if (input.team_id) {
      const t = await this.teamRow(input.team_id);
      if (t.org_id !== orgId) throw badRequest("Équipe invalide");
      if (!(await this.teamRole(actorId, t.id)) && orgRole !== "owner" && orgRole !== "admin") throw forbidden("Vous devez être membre de l'équipe pour y créer un projet");
    }
    const key = input.key ? input.key.trim().toUpperCase() : await this.suggestKey(orgId, name);
    if (!KEY_RE.test(key)) throw badRequest("La clé doit faire 2 à 10 caractères : lettres majuscules et chiffres, en commençant par une lettre");
    if (await this.db.one("SELECT 1 FROM projects WHERE org_id = $1 AND key = $2", [orgId, key])) throw badRequest(`La clé ${key} est déjà utilisée dans l'organisation`);
    const id = uid("prj");
    await this.db.tx(async (q) => {
      await q.query(`INSERT INTO projects (id, org_id, team_id, key, access, name, description, color, icon, due_on, owner_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, orgId, input.team_id ?? null, key, input.access ?? "team", name, input.description ?? "", input.color ?? "#6E56CF", input.icon ?? "rocket", input.due_on ?? null, actorId]);
      await q.query("INSERT INTO memberships (project_id, user_id, role) VALUES ($1,$2,'admin')", [id, actorId]);
      const secs = input.sections?.length ? input.sections : ["À faire", "En cours", "En revue", "Terminé"];
      for (let i = 0; i < secs.length; i++) await q.query("INSERT INTO sections (id, project_id, name, position) VALUES ($1,$2,$3,$4)", [uid("sec"), id, secs[i], (i + 1) * 1024]);
    });
    await this.log(actorId, "project.created", { orgId, projectId: id, data: { name } });
    this.bus.emit({ type: "project.changed", actorId, projectId: id });
    return this.getProject(actorId, id);
  }
  async updateProject(actorId: string, projectId: string, patch: Partial<Pick<Project, "name" | "description" | "color" | "icon" | "status" | "due_on" | "archived" | "team_id" | "access">>) {
    const role = await this.require(actorId, projectId, "editor");
    if ((patch.team_id !== undefined || patch.access !== undefined) && role !== "admin") throw forbidden("Seuls les administrateurs du projet changent son équipe ou son accès");
    const p = await this.projectRow(projectId);
    if (patch.team_id) { const t = await this.teamRow(patch.team_id); if (t.org_id !== p.org_id) throw badRequest("Équipe invalide"); }
    const allowed = ["name", "description", "color", "icon", "status", "due_on", "archived", "team_id", "access"] as const;
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of allowed) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
    if (sets.length) { vals.push(projectId); await this.db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals); }
    if (patch.status) await this.log(actorId, "project.status", { projectId, data: { status: patch.status } });
    this.bus.emit({ type: "project.changed", actorId, projectId });
    return this.getProject(actorId, projectId);
  }
  private async projectRow(id: string) {
    const p = await this.db.one<Project>("SELECT * FROM projects WHERE id = $1", [id]);
    if (!p) throw notFound("Projet introuvable");
    return p;
  }
  async setMember(actorId: string, projectId: string, userId: string, role: Role | null) {
    await this.require(actorId, projectId, "admin");
    const p = await this.projectRow(projectId);
    await this.user(userId);
    if (role && !(await this.orgRole(userId, p.org_id))) throw badRequest("La personne doit d'abord être membre de l'organisation");
    if (role === null) await this.db.query("DELETE FROM memberships WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
    else await this.db.query("INSERT INTO memberships (project_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role", [projectId, userId, role]);
    await this.log(actorId, "project.member", { projectId, data: { userId, role } });
    this.bus.emit({ type: "project.changed", actorId, projectId });
    return this.members(projectId);
  }
  async deleteProject(actorId: string, projectId: string, confirm: string) {
    await this.require(actorId, projectId, "admin");
    const p = await this.projectRow(projectId);
    if (confirm.trim() !== p.name) throw badRequest("Saisissez le nom exact du projet pour confirmer la suppression");
    const members = (await this.readableUsers(projectId)).map((u) => u);
    await this.db.tx(async (q) => {
      await q.query("DELETE FROM notifications WHERE project_id = $1", [projectId]);
      await q.query("DELETE FROM activity WHERE project_id = $1", [projectId]);
      await q.query("DELETE FROM projects WHERE id = $1", [projectId]);
    });
    await this.log(actorId, "project.deleted", { orgId: p.org_id, data: { name: p.name } });
    this.bus.emit({ type: "project.deleted", actorId, projectId, members });
  }
  /** Toutes les personnes qui ont un accès effectif au projet (pour le temps réel). */
  async readableUsers(projectId: string) {
    const p = await this.db.one<{ org_id: string }>("SELECT org_id FROM projects WHERE id = $1", [projectId]);
    if (!p) return [];
    const out: string[] = [];
    for (const m of await this.db.query<{ user_id: string }>("SELECT user_id FROM org_members WHERE org_id = $1", [p.org_id])) {
      if (await this.projectRole(m.user_id, projectId)) out.push(m.user_id);
    }
    return out;
  }

  // ================================================================ sections
  async createSection(actorId: string, projectId: string, name: string) {
    await this.require(actorId, projectId, "editor");
    const max = (await this.db.one<{ m: number | null }>("SELECT max(position) AS m FROM sections WHERE project_id = $1", [projectId]))?.m ?? 0;
    const id = uid("sec");
    await this.db.query("INSERT INTO sections (id, project_id, name, position) VALUES ($1,$2,$3,$4)", [id, projectId, name.trim() || "Nouvelle section", Number(max) + 1024]);
    this.bus.emit({ type: "project.changed", actorId, projectId });
    return (await this.db.one<Section>("SELECT * FROM sections WHERE id = $1", [id]))!;
  }
  private async sectionRow(id: string) {
    const s = await this.db.one<Section>("SELECT * FROM sections WHERE id = $1", [id]);
    if (!s) throw notFound("Section introuvable");
    return { ...s, position: Number(s.position) };
  }
  async updateSection(actorId: string, sectionId: string, patch: { name?: string; position?: number }) {
    const s = await this.sectionRow(sectionId);
    await this.require(actorId, s.project_id, "editor");
    if (patch.name !== undefined) await this.db.query("UPDATE sections SET name = $1 WHERE id = $2", [patch.name, sectionId]);
    if (patch.position !== undefined) await this.db.query("UPDATE sections SET position = $1 WHERE id = $2", [patch.position, sectionId]);
    this.bus.emit({ type: "project.changed", actorId, projectId: s.project_id });
    return this.sectionRow(sectionId);
  }
  async moveSection(actorId: string, sectionId: string, direction: "left" | "right") {
    const s = await this.sectionRow(sectionId);
    await this.require(actorId, s.project_id, "editor");
    const list = (await this.db.query<Section>("SELECT * FROM sections WHERE project_id = $1 ORDER BY position", [s.project_id])).map((x) => ({ ...x, position: Number(x.position) }));
    const i = list.findIndex((x) => x.id === sectionId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) {
      await this.db.tx(async (q) => {
        await q.query("UPDATE sections SET position = $1 WHERE id = $2", [list[j].position, list[i].id]);
        await q.query("UPDATE sections SET position = $1 WHERE id = $2", [list[i].position, list[j].id]);
      });
      this.bus.emit({ type: "project.changed", actorId, projectId: s.project_id });
    }
    return this.db.query<Section>("SELECT * FROM sections WHERE project_id = $1 ORDER BY position", [s.project_id]);
  }
  async deleteSection(actorId: string, sectionId: string) {
    const s = await this.sectionRow(sectionId);
    await this.require(actorId, s.project_id, "editor");
    const fallback = await this.db.one<{ id: string }>("SELECT id FROM sections WHERE project_id = $1 AND id <> $2 ORDER BY position LIMIT 1", [s.project_id, sectionId]);
    if (!fallback) throw badRequest("Un projet doit garder au moins une section");
    await this.db.tx(async (q) => {
      await q.query("UPDATE tasks SET section_id = $1 WHERE section_id = $2", [fallback.id, sectionId]);
      await q.query("DELETE FROM sections WHERE id = $1", [sectionId]);
    });
    this.bus.emit({ type: "project.changed", actorId, projectId: s.project_id });
  }

  // ================================================================ tâches
  async taskRow(id: string): Promise<Task> {
    const r = await this.db.one<Row>(`SELECT ${TASK_COLS} FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [id]);
    if (!r) throw notFound("Tâche introuvable");
    return toTask(r);
  }
  /** Résout « APP-12 », « #12 » (si non ambigu) ou un identifiant interne, parmi ce que l'acteur peut lire. */
  async resolveTaskId(actorId: string, ref: string): Promise<string> {
    const s = String(ref).trim();
    const byKey = s.match(/^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/);
    const byNum = s.match(/^#?(\d+)$/);
    if (!byKey && !byNum) return s;
    const readable = await this.readableProjectIds(actorId, null, true);
    if (!readable.length) throw notFound(`Tâche ${s} introuvable`);
    const rows = byKey
      ? await this.db.query<{ id: string }>("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.key = $1 AND t.number = $2 AND t.project_id = ANY($3)", [byKey[1].toUpperCase(), Number(byKey[2]), readable])
      : await this.db.query<{ id: string }>("SELECT id FROM tasks WHERE number = $1 AND project_id = ANY($2)", [Number(byNum![1]), readable]);
    if (!rows.length) throw notFound(`Tâche ${s} introuvable`);
    if (rows.length > 1) throw badRequest(`Plusieurs tâches portent le numéro ${s} : précisez la clé, par exemple APP-${byNum?.[1]}`);
    return rows[0].id;
  }

  async listTasks(actorId: string, f: TaskFilters & { org_id?: string | null } = {}): Promise<Task[]> {
    let projectIds = await this.readableProjectIds(actorId, f.org_id ?? null);
    if (f.project_id) { await this.require(actorId, f.project_id); projectIds = [f.project_id]; }
    if (!projectIds.length) return [];
    const where = ["t.project_id = ANY($1)"]; const params: unknown[] = [projectIds];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (f.parent_id !== undefined && f.parent_id !== null) add("t.parent_id = ?", f.parent_id);
    else if (!f.include_subtasks) where.push("t.parent_id IS NULL");
    if (f.section_id) add("t.section_id = ?", f.section_id);
    if (f.assignee_id === null) where.push("t.assignee_id IS NULL");
    else if (f.assignee_id) add("t.assignee_id = ?", f.assignee_id);
    if (f.completed !== undefined) add("t.completed = ?", f.completed);
    if (f.overdue) add("NOT t.completed AND t.due_on IS NOT NULL AND t.due_on < ?::date", today());
    if (f.due_before) add("t.due_on IS NOT NULL AND t.due_on <= ?::date", f.due_before);
    if (f.due_after) add("t.due_on IS NOT NULL AND t.due_on >= ?::date", f.due_after);
    if (f.priority) add("t.priority = ?", f.priority);
    if (f.text) { params.push(`%${f.text}%`); where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`); }
    params.push(Math.max(1, Math.min(Number(f.limit) || 500, 1000)));
    return (await this.db.query<Row>(`
      SELECT ${TASK_COLS},
        (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
        (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id AND s.completed) AS subtask_done,
        (SELECT count(*)::int FROM comments c WHERE c.task_id = t.id) AS comment_count
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where.join(" AND ")}
      ORDER BY t.position LIMIT $${params.length}`, params)).map(toTask);
  }

  async getTask(actorId: string, ref: string) {
    const task = await this.taskRow(await this.resolveTaskId(actorId, ref));
    const role = await this.require(actorId, task.project_id);
    const project = await this.projectRow(task.project_id);
    const parent = task.parent_id ? await this.taskRow(task.parent_id) : null;
    return {
      ...task, role,
      project: { id: project.id, name: project.name, color: project.color, icon: project.icon, description: project.description, key: project.key, org_id: project.org_id },
      section: task.section_id ? (await this.db.one<Section>("SELECT * FROM sections WHERE id = $1", [task.section_id])) ?? null : null,
      parent: parent ? { id: parent.id, number: parent.number, key: parent.key, title: parent.title } : null,
      subtasks: await this.listTasks(actorId, { project_id: task.project_id, parent_id: task.id }),
      comments: await this.db.query<Comment>("SELECT * FROM comments WHERE task_id = $1 ORDER BY created_at", [task.id]),
      activity: await this.db.query<Activity>("SELECT * FROM activity WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50", [task.id]),
    };
  }

  private async endPosition(q: Queryable, projectId: string, sectionId: string | null, parentId: string | null) {
    const r = parentId
      ? await q.query<{ m: number | null }>("SELECT max(position) AS m FROM tasks WHERE parent_id = $1", [parentId])
      : await q.query<{ m: number | null }>("SELECT max(position) AS m FROM tasks WHERE project_id = $1 AND parent_id IS NULL AND section_id IS NOT DISTINCT FROM $2", [projectId, sectionId]);
    return Number(r[0]?.m ?? 0) + 1024;
  }

  async createTask(actorId: string, input: TaskInput): Promise<Task> {
    const title = input.title?.trim();
    if (!title) throw badRequest("Le titre est obligatoire");
    await this.require(actorId, input.project_id, "editor");
    let sectionId = input.section_id ?? null;
    let parentId = input.parent_id ?? null;
    if (parentId) {
      const parent = await this.taskRow(await this.resolveTaskId(actorId, parentId));
      if (parent.project_id !== input.project_id) throw badRequest("La tâche parente est dans un autre projet");
      parentId = parent.id; sectionId = parent.section_id;
    } else if (!sectionId) {
      sectionId = (await this.db.one<{ id: string }>("SELECT id FROM sections WHERE project_id = $1 ORDER BY position LIMIT 1", [input.project_id]))?.id ?? null;
    } else {
      const s = await this.db.one<Section>("SELECT * FROM sections WHERE id = $1", [sectionId]);
      if (!s || s.project_id !== input.project_id) throw badRequest("Section invalide");
    }
    if (input.assignee_id) await this.checkAssignee(input.project_id, input.assignee_id);
    if (input.start_on && input.due_on && input.start_on > input.due_on) throw badRequest("La date de début doit précéder l'échéance");
    const id = uid("tsk");
    await this.db.tx(async (q) => {
      // Numéro attribué atomiquement par projet
      const [{ task_seq }] = await q.query<{ task_seq: number }>("UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq", [input.project_id]);
      await q.query(`INSERT INTO tasks (id, number, project_id, section_id, parent_id, title, description, assignee_id, creator_id, priority, start_on, due_on, position, tags)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, task_seq, input.project_id, sectionId, parentId, title, input.description ?? "", input.assignee_id ?? null, actorId, input.priority ?? "none",
          input.start_on ?? null, input.due_on ?? null, await this.endPosition(q, input.project_id, sectionId, parentId), JSON.stringify(input.tags ?? [])]);
    });
    const task = await this.taskRow(id);
    await this.log(actorId, "task.created", { projectId: task.project_id, taskId: id, data: { title, parent_id: task.parent_id } });
    if (task.assignee_id && task.assignee_id !== actorId) await this.notifyAssigned(actorId, task);
    this.bus.emit({ type: "task.created", actorId, projectId: task.project_id, taskId: id });
    return task;
  }

  private async checkAssignee(projectId: string, userId: string) {
    const u = await this.user(userId);
    if (!(await this.projectRole(userId, projectId))) throw badRequest(`${u.name} n'a pas accès à ce projet`);
  }

  async updateTask(actorId: string, ref: string, patch: TaskPatch): Promise<Task> {
    const before = await this.taskRow(await this.resolveTaskId(actorId, ref));
    await this.require(actorId, before.project_id, "editor");
    const start = patch.start_on !== undefined ? patch.start_on : before.start_on;
    const due = patch.due_on !== undefined ? patch.due_on : before.due_on;
    if (start && due && start > due) throw badRequest("La date de début doit précéder l'échéance");
    const fields = ["title", "description", "section_id", "assignee_id", "priority", "start_on", "due_on", "completed", "position", "tags"] as const;
    const sets: string[] = []; const vals: unknown[] = []; const changes: string[] = []; const previous: Record<string, unknown> = {};
    for (const k of fields) {
      const v = patch[k];
      if (v === undefined) continue;
      if (k === "title" && !String(v).trim()) throw badRequest("Le titre ne peut pas être vide");
      if (k === "assignee_id" && v) await this.checkAssignee(before.project_id, String(v));
      if (k === "section_id" && v) {
        const s = await this.db.one<Section>("SELECT * FROM sections WHERE id = $1", [v]);
        if (!s || s.project_id !== before.project_id) throw badRequest("Section invalide");
      }
      if (k === "priority" && !["none", "low", "medium", "high", "urgent"].includes(String(v))) throw badRequest("Priorité invalide");
      const same = k === "tags" ? JSON.stringify(before.tags) === JSON.stringify(v) : (before as unknown as Row)[k] === v;
      if (same) continue;
      vals.push(k === "tags" ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}`);
      changes.push(k); previous[k] = (before as unknown as Row)[k];
      if (k === "completed") { vals.push(v ? now() : null); sets.push(`completed_at = $${vals.length}`); }
    }
    if (!sets.length) return before;
    vals.push(now()); sets.push(`updated_at = $${vals.length}`);
    vals.push(before.id);
    await this.db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    const after = await this.taskRow(before.id);
    for (const k of changes) {
      if (k === "position") continue;
      await this.log(actorId, `task.${k}`, { projectId: after.project_id, taskId: after.id, data: { from: previous[k], to: (after as unknown as Row)[k] } });
    }
    if (changes.includes("assignee_id") && after.assignee_id && after.assignee_id !== actorId) await this.notifyAssigned(actorId, after);
    if (changes.includes("completed") && after.completed && after.creator_id && after.creator_id !== actorId) {
      await this.notify(after.creator_id, await this.orgOfProject(after.project_id), { kind: "task.completed", title: `${(await this.user(actorId)).name} a terminé « ${after.title} »`, task_id: after.id, project_id: after.project_id, actor_id: actorId });
    }
    this.bus.emit({ type: "task.updated", actorId, projectId: after.project_id, taskId: after.id, changes, previous });
    return after;
  }

  async moveTask(actorId: string, ref: string, to: { section_id: string; before_id?: string | null; after_id?: string | null }) {
    const task = await this.taskRow(await this.resolveTaskId(actorId, ref));
    await this.require(actorId, task.project_id, "editor");
    const pos = async (id?: string | null) => (id ? (await this.db.one<{ position: number }>("SELECT position FROM tasks WHERE id = $1", [id]))?.position : undefined);
    const a = await pos(to.after_id), b = await pos(to.before_id);
    let position: number;
    if (a !== undefined && b !== undefined) position = (Number(a) + Number(b)) / 2;
    else if (a !== undefined) position = Number(a) + 1024;
    else if (b !== undefined) position = Number(b) - 1024;
    else position = await this.endPosition(this.db, task.project_id, to.section_id, null);
    return this.updateTask(actorId, task.id, { section_id: to.section_id, position });
  }

  async duplicateTask(actorId: string, ref: string, opts: { subtasks?: boolean } = {}): Promise<Task> {
    const src = await this.taskRow(await this.resolveTaskId(actorId, ref));
    await this.require(actorId, src.project_id, "editor");
    const copy = (t: Task, parentId: string | null, title: string) => this.createTask(actorId, {
      project_id: t.project_id, title, description: t.description, section_id: parentId ? null : t.section_id, parent_id: parentId,
      assignee_id: t.assignee_id, priority: t.priority, start_on: t.start_on, due_on: t.due_on, tags: t.tags,
    });
    const created = await copy(src, src.parent_id, `Copie de ${src.title}`);
    if (opts.subtasks) {
      for (const sub of (await this.db.query<Row>(`SELECT ${TASK_COLS} FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.parent_id = $1 ORDER BY t.position`, [src.id])).map(toTask)) {
        await copy(sub, created.id, sub.title);
      }
    }
    return this.taskRow(created.id);
  }

  async moveTaskToProject(actorId: string, ref: string, projectId: string): Promise<Task> {
    const t = await this.taskRow(await this.resolveTaskId(actorId, ref));
    if (t.parent_id) throw badRequest("Une sous-tâche se déplace avec sa tâche parente");
    await this.require(actorId, t.project_id, "editor");
    await this.require(actorId, projectId, "editor");
    if (t.project_id === projectId) return t;
    const [src, dst] = [await this.projectRow(t.project_id), await this.projectRow(projectId)];
    if (src.org_id !== dst.org_id) throw badRequest("Une tâche ne peut pas changer d'organisation");
    const section = (await this.db.one<{ id: string }>("SELECT id FROM sections WHERE project_id = $1 ORDER BY position LIMIT 1", [projectId]))?.id ?? null;
    const ids = [t.id];
    for (let i = 0; i < ids.length; i++) for (const r of await this.db.query<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1", [ids[i]])) ids.push(r.id);
    const keep = new Map<string, string | null>();
    for (const id of ids) { const row = await this.taskRow(id); keep.set(id, row.assignee_id && (await this.projectRole(row.assignee_id, projectId)) ? row.assignee_id : null); }
    await this.db.tx(async (q) => {
      for (const id of ids) {
        const [{ task_seq }] = await q.query<{ task_seq: number }>("UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq", [projectId]);
        await q.query("UPDATE tasks SET project_id = $1, number = $2, assignee_id = $3, updated_at = now() WHERE id = $4", [projectId, task_seq, keep.get(id), id]);
      }
      await q.query("UPDATE tasks SET section_id = $1, position = $2 WHERE id = $3", [section, await this.endPosition(q, projectId, section, null), t.id]);
      await q.query("UPDATE activity SET project_id = $1 WHERE task_id = ANY($2)", [projectId, ids]);
    });
    await this.log(actorId, "task.moved_project", { projectId, taskId: t.id, data: { from: t.project_id, to: projectId } });
    this.bus.emit({ type: "task.deleted", actorId, projectId: t.project_id, taskId: t.id });
    this.bus.emit({ type: "task.updated", actorId, projectId, taskId: t.id, changes: ["project_id"], previous: { project_id: t.project_id } });
    return this.taskRow(t.id);
  }

  async deleteTask(actorId: string, ref: string) {
    const task = await this.taskRow(await this.resolveTaskId(actorId, ref));
    await this.require(actorId, task.project_id, "editor");
    await this.db.query("DELETE FROM tasks WHERE id = $1", [task.id]);
    await this.log(actorId, "task.deleted", { projectId: task.project_id, data: { title: task.title, key: task.key } });
    this.bus.emit({ type: "task.deleted", actorId, projectId: task.project_id, taskId: task.id });
  }

  // ================================================================ commentaires
  async addComment(actorId: string, ref: string, body: string, aiRunId: string | null = null): Promise<Comment> {
    const task = await this.taskRow(await this.resolveTaskId(actorId, ref));
    await this.require(actorId, task.project_id, "commenter");
    const text = body.trim();
    if (!text) throw badRequest("Le commentaire est vide");
    const id = uid("cmt");
    await this.db.query("INSERT INTO comments (id, task_id, author_id, body, ai_run_id) VALUES ($1,$2,$3,$4,$5)", [id, task.id, actorId, text, aiRunId]);
    await this.log(actorId, "comment.created", { projectId: task.project_id, taskId: task.id, data: { excerpt: text.slice(0, 140) } });
    const orgId = await this.orgOfProject(task.project_id);
    // Mentions @Prénom, limitées aux membres de l'organisation qui ont accès au projet
    const mentions: string[] = [];
    for (const u of await this.usersOf(orgId)) {
      if (u.id === actorId || !new RegExp(`@${u.name.split(" ")[0]}\\b`, "i").test(text)) continue;
      if (await this.projectRole(u.id, task.project_id)) mentions.push(u.id);
    }
    const author = await this.user(actorId);
    const notified = new Set<string>();
    for (const m of mentions) {
      notified.add(m);
      if (!(await this.user(m)).is_ai) await this.notify(m, orgId, { kind: "mention", title: `${author.name} vous a mentionné sur « ${task.title} »`, body: text.slice(0, 200), task_id: task.id, project_id: task.project_id, actor_id: actorId });
    }
    if (task.assignee_id && task.assignee_id !== actorId && !notified.has(task.assignee_id) && !(await this.user(task.assignee_id)).is_ai) {
      await this.notify(task.assignee_id, orgId, { kind: "comment", title: `${author.name} a commenté « ${task.title} »`, body: text.slice(0, 200), task_id: task.id, project_id: task.project_id, actor_id: actorId });
    }
    this.bus.emit({ type: "comment.created", actorId, projectId: task.project_id, taskId: task.id, commentId: id, mentions });
    return (await this.db.one<Comment>("SELECT * FROM comments WHERE id = $1", [id]))!;
  }
  private async commentRow(id: string) {
    const c = await this.db.one<Comment>("SELECT * FROM comments WHERE id = $1", [id]);
    if (!c) throw notFound("Commentaire introuvable");
    return { c, task: await this.taskRow(c.task_id) };
  }
  async updateComment(actorId: string, id: string, body: string): Promise<Comment> {
    const { c, task } = await this.commentRow(id);
    await this.require(actorId, task.project_id, "commenter");
    if (c.author_id !== actorId) throw forbidden("Seul l'auteur peut modifier ce commentaire");
    if (!body.trim()) throw badRequest("Le commentaire est vide");
    await this.db.query("UPDATE comments SET body = $1, edited_at = now() WHERE id = $2", [body.trim(), id]);
    this.bus.emit({ type: "task.updated", actorId, projectId: task.project_id, taskId: task.id, changes: ["comment"], previous: {} });
    return (await this.db.one<Comment>("SELECT * FROM comments WHERE id = $1", [id]))!;
  }
  async deleteComment(actorId: string, id: string) {
    const { c, task } = await this.commentRow(id);
    const role = await this.require(actorId, task.project_id, "commenter");
    if (c.author_id !== actorId && role !== "admin") throw forbidden("Seuls l'auteur et les administrateurs du projet peuvent supprimer ce commentaire");
    await this.db.query("DELETE FROM comments WHERE id = $1", [id]);
    await this.log(actorId, "comment.deleted", { projectId: task.project_id, taskId: task.id, data: { author: c.author_id } });
    this.bus.emit({ type: "task.updated", actorId, projectId: task.project_id, taskId: task.id, changes: ["comment"], previous: {} });
  }

  // ================================================================ notifications
  async orgOfProject(projectId: string) {
    return (await this.db.one<{ org_id: string }>("SELECT org_id FROM projects WHERE id = $1", [projectId]))?.org_id ?? "";
  }
  async notify(userId: string, orgId: string | null, n: { kind: string; title: string; body?: string; task_id?: string | null; project_id?: string | null; approval_id?: string | null; actor_id?: string | null }) {
    const id = uid("ntf");
    await this.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, task_id, project_id, approval_id, actor_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, orgId || null, userId, n.kind, n.title, n.body ?? "", n.task_id ?? null, n.project_id ?? null, n.approval_id ?? null, n.actor_id ?? null]);
    this.bus.emit({ type: "notification", userId, notificationId: id, orgId: orgId || null, kind: n.kind, title: n.title, body: n.body ?? "", projectId: n.project_id ?? null, taskId: n.task_id ?? null, actorId: n.actor_id ?? null });
  }
  private async notifyAssigned(actorId: string, task: Task) {
    if (!task.assignee_id || (await this.user(task.assignee_id)).is_ai) return;
    await this.notify(task.assignee_id, await this.orgOfProject(task.project_id), { kind: "assigned", title: `${(await this.user(actorId)).name} vous a assigné « ${task.title} »`, task_id: task.id, project_id: task.project_id, actor_id: actorId });
  }
  async listNotifications(userId: string, orgId: string) {
    return this.db.query<Notification>("SELECT * FROM notifications WHERE user_id = $1 AND (org_id = $2 OR org_id IS NULL) ORDER BY created_at DESC LIMIT 100", [userId, orgId]);
  }
  async markRead(userId: string, orgId: string, ids: string[] | "all") {
    if (ids === "all") await this.db.query("UPDATE notifications SET read = TRUE WHERE user_id = $1 AND (org_id = $2 OR org_id IS NULL)", [userId, orgId]);
    else await this.db.query("UPDATE notifications SET read = TRUE WHERE id = ANY($1) AND user_id = $2", [ids, userId]);
    this.bus.emit({ type: "notification", userId });
  }

  // ================================================================ activité, indicateurs, recherche
  async log(actorId: string, kind: string, o: { orgId?: string | null; projectId?: string | null; taskId?: string | null; data?: Record<string, unknown> }) {
    const orgId = o.orgId ?? (o.projectId ? await this.orgOfProject(o.projectId) : null);
    await this.db.query("INSERT INTO activity (id, org_id, project_id, task_id, actor_id, kind, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [uid("act"), orgId || null, o.projectId ?? null, o.taskId ?? null, actorId, kind, JSON.stringify(o.data ?? {})]);
  }
  async projectActivity(actorId: string, projectId: string, limit = 40) {
    await this.require(actorId, projectId);
    return this.db.query<Activity>("SELECT * FROM activity WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]);
  }
  async projectStats(actorId: string, projectId: string) {
    await this.require(actorId, projectId);
    const tasks = await this.listTasks(actorId, { project_id: projectId });
    const t = today();
    const sections = await this.db.query<{ id: string; name: string }>("SELECT id, name FROM sections WHERE project_id = $1 ORDER BY position", [projectId]);
    const bySection = sections.map((s) => ({ ...s, open: tasks.filter((x) => x.section_id === s.id && !x.completed).length, done: tasks.filter((x) => x.section_id === s.id && x.completed).length }));
    const byAssignee = new Map<string, { open: number; done: number; overdue: number }>();
    for (const x of tasks) {
      const k = x.assignee_id ?? "";
      const e = byAssignee.get(k) ?? { open: 0, done: 0, overdue: 0 };
      if (x.completed) e.done++; else { e.open++; if (x.due_on && x.due_on < t) e.overdue++; }
      byAssignee.set(k, e);
    }
    const byPriority = (["urgent", "high", "medium", "low", "none"] as Priority[]).map((p) => ({ priority: p, open: tasks.filter((x) => !x.completed && x.priority === p).length }));
    const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toISOString().slice(0, 10); });
    const burnup = days.map((d) => ({ day: d, done: tasks.filter((x) => x.completed && (x.completed_at ?? "").slice(0, 10) <= d).length, total: tasks.filter((x) => x.created_at.slice(0, 10) <= d).length }));
    const week = new Date(); week.setDate(week.getDate() + 7); const w = week.toISOString().slice(0, 10);
    return {
      total: tasks.length, done: tasks.filter((x) => x.completed).length,
      overdue: tasks.filter((x) => !x.completed && x.due_on && x.due_on < t).length,
      due_this_week: tasks.filter((x) => !x.completed && x.due_on && x.due_on >= t && x.due_on <= w).length,
      unassigned: tasks.filter((x) => !x.completed && !x.assignee_id).length,
      bySection, byPriority, burnup,
      byAssignee: [...byAssignee.entries()].map(([user_id, v]) => ({ user_id: user_id || null, ...v })).sort((a, b) => b.open - a.open),
    };
  }
  async search(actorId: string, orgId: string, q: string) {
    const text = q.trim();
    if (!text) return { tasks: [], projects: [] };
    let tasks: Task[];
    if (/^([A-Za-z][A-Za-z0-9]{1,9}-\d+|#?\d+)$/.test(text)) {
      try { tasks = [await this.taskRow(await this.resolveTaskId(actorId, text))].filter((t) => t); } catch { tasks = []; }
      const readable = new Set(await this.readableProjectIds(actorId, orgId));
      tasks = tasks.filter((t) => readable.has(t.project_id));
    } else tasks = await this.listTasks(actorId, { org_id: orgId, text, include_subtasks: true, limit: 20 });
    const projects = (await this.listProjects(actorId, orgId)).filter((p) => p.name.toLowerCase().includes(text.toLowerCase()) || p.key === text.toUpperCase()).slice(0, 8);
    return { tasks, projects };
  }
}

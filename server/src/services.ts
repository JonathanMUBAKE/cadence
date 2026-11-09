import { all, get, now, run, tx, uid, type DB } from "./db.js";
import type { Bus } from "./bus.js";

// ---------------------------------------------------------------------------
// Types exposés par l'API
// ---------------------------------------------------------------------------
export type Role = "viewer" | "commenter" | "editor" | "admin";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type ProjectStatus = "on_track" | "at_risk" | "off_track" | "done";

export interface User {
  id: string; name: string; email: string | null; title: string | null;
  avatar_color: string; is_ai: boolean; ai_role: string | null; ai_instructions: string | null;
}
export interface Project {
  id: string; name: string; description: string; color: string; icon: string;
  status: ProjectStatus; due_on: string | null; owner_id: string | null; archived: boolean; created_at: string;
}
export interface Section { id: string; project_id: string; name: string; position: number }
export interface Task {
  id: string; number: number; project_id: string; section_id: string | null; parent_id: string | null;
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

const ROLE_RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4 };
export const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Conversion des lignes SQL
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const toUser = (r: Row): User => ({ ...(r as unknown as User), is_ai: !!r.is_ai });
const toProject = (r: Row): Project => ({ ...(r as unknown as Project), archived: !!r.archived });
const toTask = (r: Row): Task => ({
  ...(r as unknown as Task),
  completed: !!r.completed,
  tags: (() => { try { return JSON.parse(String(r.tags ?? "[]")); } catch { return []; } })(),
});
const toActivity = (r: Row): Activity => ({ ...(r as unknown as Activity), data: JSON.parse(String(r.data || "{}")) });
const toNotif = (r: Row): Notification => ({ ...(r as unknown as Notification), read: !!r.read });

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
// Services : toute la logique métier, toujours exécutée « au nom de » un acteur
// ---------------------------------------------------------------------------
export class Services {
  constructor(public db: DB, public bus: Bus) {}

  // ----------------------------------------------------------- utilisateurs
  user(id: string): User {
    const r = get<Row>(this.db, "SELECT * FROM users WHERE id = ?", id);
    if (!r) throw notFound("Utilisateur introuvable");
    return toUser(r);
  }
  listUsers(): User[] {
    return all<Row>(this.db, "SELECT * FROM users ORDER BY is_ai, name").map(toUser);
  }
  agents(): User[] {
    return this.listUsers().filter((u) => u.is_ai);
  }

  // ----------------------------------------------------------- droits
  role(actorId: string, projectId: string): Role | null {
    const r = get<{ role: Role }>(this.db, "SELECT role FROM memberships WHERE project_id = ? AND user_id = ?", projectId, actorId);
    return r?.role ?? null;
  }
  require(actorId: string, projectId: string, min: Role = "viewer"): Role {
    const project = get<Row>(this.db, "SELECT id, name FROM projects WHERE id = ?", projectId);
    if (!project) throw notFound("Projet introuvable");
    const role = this.role(actorId, projectId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
      const verb = min === "viewer" ? "consulter" : min === "commenter" ? "commenter" : min === "editor" ? "modifier" : "administrer";
      throw forbidden(`${this.user(actorId).name} n'a pas le droit de ${verb} le projet « ${project.name} »`);
    }
    return role;
  }
  readableProjectIds(actorId: string): string[] {
    return all<{ project_id: string }>(this.db,
      "SELECT m.project_id FROM memberships m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? AND p.archived = 0",
      actorId).map((r) => r.project_id);
  }

  // ----------------------------------------------------------- projets
  listProjects(actorId: string, opts: { archived?: boolean } = {}) {
    const rows = all<Row>(this.db, `
      SELECT p.*, m.role,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL AND t.completed = 1) AS done_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.completed = 0 AND t.due_on < ?) AS overdue_count
      FROM projects p JOIN memberships m ON m.project_id = p.id AND m.user_id = ?
      WHERE p.archived = ? ORDER BY p.created_at`, today(), actorId, opts.archived ? 1 : 0);
    return rows.map((r) => ({
      ...toProject(r), role: r.role as Role,
      task_count: Number(r.task_count), done_count: Number(r.done_count), overdue_count: Number(r.overdue_count),
      members: this.members(String(r.id)).map((m) => m.user_id),
    }));
  }
  members(projectId: string) {
    return all<{ user_id: string; role: Role }>(this.db,
      "SELECT user_id, role FROM memberships WHERE project_id = ? ORDER BY role DESC", projectId);
  }
  getProject(actorId: string, projectId: string) {
    const role = this.require(actorId, projectId);
    const p = toProject(get<Row>(this.db, "SELECT * FROM projects WHERE id = ?", projectId)!);
    return {
      ...p, role,
      sections: all<Section>(this.db, "SELECT * FROM sections WHERE project_id = ? ORDER BY position", projectId),
      members: this.members(projectId),
    };
  }
  createProject(actorId: string, input: { name: string; description?: string; color?: string; icon?: string; due_on?: string | null; sections?: string[] }) {
    const name = input.name?.trim();
    if (!name) throw badRequest("Le nom du projet est obligatoire");
    const id = uid("prj");
    tx(this.db, () => {
      run(this.db, "INSERT INTO projects (id, name, description, color, icon, due_on, owner_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
        id, name, input.description ?? "", input.color ?? "#6E56CF", input.icon ?? "rocket", input.due_on ?? null, actorId, now());
      run(this.db, "INSERT INTO memberships (project_id, user_id, role) VALUES (?,?,?)", id, actorId, "admin");
      (input.sections?.length ? input.sections : ["À faire", "En cours", "En revue", "Terminé"]).forEach((s, i) =>
        run(this.db, "INSERT INTO sections (id, project_id, name, position) VALUES (?,?,?,?)", uid("sec"), id, s, (i + 1) * 1024));
    });
    this.log(actorId, "project.created", { projectId: id, data: { name } });
    this.bus.emit({ type: "project.changed", actorId, projectId: id });
    return this.getProject(actorId, id);
  }
  updateProject(actorId: string, projectId: string, patch: Partial<Pick<Project, "name" | "description" | "color" | "icon" | "status" | "due_on" | "archived">>) {
    this.require(actorId, projectId, "editor");
    const allowed = ["name", "description", "color", "icon", "status", "due_on", "archived"] as const;
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(k === "archived" ? (patch[k] ? 1 : 0) : patch[k]); }
    if (sets.length) run(this.db, `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, ...vals, projectId);
    if (patch.status) this.log(actorId, "project.status", { projectId, data: { status: patch.status } });
    this.bus.emit({ type: "project.changed", actorId, projectId });
    return this.getProject(actorId, projectId);
  }
  setMember(actorId: string, projectId: string, userId: string, role: Role | null) {
    this.require(actorId, projectId, "admin");
    this.user(userId);
    if (role === null) run(this.db, "DELETE FROM memberships WHERE project_id = ? AND user_id = ?", projectId, userId);
    else run(this.db, "INSERT INTO memberships (project_id, user_id, role) VALUES (?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role", projectId, userId, role);
    this.log(actorId, "project.member", { projectId, data: { userId, role } });
    this.bus.emit({ type: "project.changed", actorId, projectId });
    return this.members(projectId);
  }

  deleteProject(actorId: string, projectId: string, confirm: string) {
    this.require(actorId, projectId, "admin");
    const p = get<{ name: string }>(this.db, "SELECT name FROM projects WHERE id = ?", projectId)!;
    if (confirm.trim() !== p.name) throw badRequest("Saisissez le nom exact du projet pour confirmer la suppression");
    const members = this.members(projectId).map((m) => m.user_id);
    tx(this.db, () => {
      run(this.db, "DELETE FROM notifications WHERE project_id = ?", projectId);
      run(this.db, "DELETE FROM activity WHERE project_id = ?", projectId);
      run(this.db, "DELETE FROM projects WHERE id = ?", projectId);
    });
    this.log(actorId, "project.deleted", { data: { name: p.name } });
    this.bus.emit({ type: "project.deleted", actorId, projectId, members });
  }

  // ----------------------------------------------------------- sections
  createSection(actorId: string, projectId: string, name: string) {
    this.require(actorId, projectId, "editor");
    const max = get<{ m: number | null }>(this.db, "SELECT MAX(position) AS m FROM sections WHERE project_id = ?", projectId)?.m ?? 0;
    const id = uid("sec");
    run(this.db, "INSERT INTO sections (id, project_id, name, position) VALUES (?,?,?,?)", id, projectId, name.trim() || "Nouvelle section", max + 1024);
    this.bus.emit({ type: "project.changed", actorId, projectId });
    return get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", id)!;
  }
  updateSection(actorId: string, sectionId: string, patch: { name?: string; position?: number }) {
    const s = get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", sectionId);
    if (!s) throw notFound("Section introuvable");
    this.require(actorId, s.project_id, "editor");
    if (patch.name !== undefined) run(this.db, "UPDATE sections SET name = ? WHERE id = ?", patch.name, sectionId);
    if (patch.position !== undefined) run(this.db, "UPDATE sections SET position = ? WHERE id = ?", patch.position, sectionId);
    this.bus.emit({ type: "project.changed", actorId, projectId: s.project_id });
    return get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", sectionId)!;
  }
  moveSection(actorId: string, sectionId: string, direction: "left" | "right") {
    const s = get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", sectionId);
    if (!s) throw notFound("Section introuvable");
    this.require(actorId, s.project_id, "editor");
    const list = all<Section>(this.db, "SELECT * FROM sections WHERE project_id = ? ORDER BY position", s.project_id);
    const i = list.findIndex((x) => x.id === sectionId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return list;
    tx(this.db, () => {
      run(this.db, "UPDATE sections SET position = ? WHERE id = ?", list[j].position, list[i].id);
      run(this.db, "UPDATE sections SET position = ? WHERE id = ?", list[i].position, list[j].id);
    });
    this.bus.emit({ type: "project.changed", actorId, projectId: s.project_id });
    return all<Section>(this.db, "SELECT * FROM sections WHERE project_id = ? ORDER BY position", s.project_id);
  }

  deleteSection(actorId: string, sectionId: string) {
    const s = get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", sectionId);
    if (!s) throw notFound("Section introuvable");
    this.require(actorId, s.project_id, "editor");
    const fallback = get<{ id: string }>(this.db, "SELECT id FROM sections WHERE project_id = ? AND id != ? ORDER BY position LIMIT 1", s.project_id, sectionId);
    if (!fallback) throw badRequest("Un projet doit garder au moins une section");
    run(this.db, "UPDATE tasks SET section_id = ? WHERE section_id = ?", fallback.id, sectionId);
    run(this.db, "DELETE FROM sections WHERE id = ?", sectionId);
    this.bus.emit({ type: "project.changed", actorId, projectId: s.project_id });
  }

  // ----------------------------------------------------------- tâches
  private taskRow(id: string): Task {
    const r = get<Row>(this.db, "SELECT * FROM tasks WHERE id = ?", id);
    if (!r) throw notFound("Tâche introuvable");
    return toTask(r);
  }
  /** Résout « 12 », « #12 » ou un id interne. */
  resolveTaskId(ref: string): string {
    const m = String(ref).trim().match(/^#?(\d+)$/);
    if (m) {
      const r = get<{ id: string }>(this.db, "SELECT id FROM tasks WHERE number = ?", Number(m[1]));
      if (!r) throw notFound(`Tâche #${m[1]} introuvable`);
      return r.id;
    }
    return String(ref);
  }

  listTasks(actorId: string, f: TaskFilters = {}): Task[] {
    let projectIds = this.readableProjectIds(actorId);
    if (f.project_id) { this.require(actorId, f.project_id); projectIds = [f.project_id]; }
    if (!projectIds.length) return [];
    const where = [`t.project_id IN (${projectIds.map(() => "?").join(",")})`];
    const params: unknown[] = [...projectIds];
    if (f.parent_id !== undefined && f.parent_id !== null) { where.push("t.parent_id = ?"); params.push(f.parent_id); }
    else if (!f.include_subtasks) where.push("t.parent_id IS NULL");
    if (f.section_id) { where.push("t.section_id = ?"); params.push(f.section_id); }
    if (f.assignee_id === null) where.push("t.assignee_id IS NULL");
    else if (f.assignee_id) { where.push("t.assignee_id = ?"); params.push(f.assignee_id); }
    if (f.completed !== undefined) { where.push("t.completed = ?"); params.push(f.completed ? 1 : 0); }
    if (f.overdue) { where.push("t.completed = 0 AND t.due_on IS NOT NULL AND t.due_on < ?"); params.push(today()); }
    if (f.due_before) { where.push("t.due_on IS NOT NULL AND t.due_on <= ?"); params.push(f.due_before); }
    if (f.due_after) { where.push("t.due_on IS NOT NULL AND t.due_on >= ?"); params.push(f.due_after); }
    if (f.priority) { where.push("t.priority = ?"); params.push(f.priority); }
    if (f.text) { where.push("(t.title LIKE ? OR t.description LIKE ?)"); params.push(`%${f.text}%`, `%${f.text}%`); }
    const limit = Math.max(1, Math.min(Number(f.limit) || 500, 1000));
    return all<Row>(this.db, `
      SELECT t.*,
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.completed = 1) AS subtask_done,
        (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
      FROM tasks t WHERE ${where.join(" AND ")}
      ORDER BY t.position LIMIT ?`, ...params, limit).map(toTask);
  }

  getTask(actorId: string, ref: string) {
    const task = this.taskRow(this.resolveTaskId(ref));
    const role = this.require(actorId, task.project_id);
    const project = toProject(get<Row>(this.db, "SELECT * FROM projects WHERE id = ?", task.project_id)!);
    return {
      ...task, role,
      project: { id: project.id, name: project.name, color: project.color, icon: project.icon, description: project.description },
      section: task.section_id ? get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", task.section_id) ?? null : null,
      parent: task.parent_id ? (({ id, number, title }) => ({ id, number, title }))(this.taskRow(task.parent_id)) : null,
      subtasks: this.listTasks(actorId, { project_id: task.project_id, parent_id: task.id }),
      comments: all<Comment>(this.db, "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at", task.id),
      activity: all<Row>(this.db, "SELECT * FROM activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 50", task.id).map(toActivity),
    };
  }

  private nextNumber(): number {
    return (get<{ m: number | null }>(this.db, "SELECT MAX(number) AS m FROM tasks")?.m ?? 0) + 1;
  }
  private endPosition(projectId: string, sectionId: string | null, parentId: string | null) {
    const r = parentId
      ? get<{ m: number | null }>(this.db, "SELECT MAX(position) AS m FROM tasks WHERE parent_id = ?", parentId)
      : get<{ m: number | null }>(this.db, "SELECT MAX(position) AS m FROM tasks WHERE project_id = ? AND parent_id IS NULL AND section_id IS ?", projectId, sectionId);
    return (r?.m ?? 0) + 1024;
  }

  createTask(actorId: string, input: TaskInput): Task {
    const title = input.title?.trim();
    if (!title) throw badRequest("Le titre est obligatoire");
    this.require(actorId, input.project_id, "editor");
    let sectionId = input.section_id ?? null;
    if (input.parent_id) {
      const parent = this.taskRow(this.resolveTaskId(input.parent_id));
      if (parent.project_id !== input.project_id) throw badRequest("La tâche parente est dans un autre projet");
      input.parent_id = parent.id;
      sectionId = parent.section_id;
    } else if (!sectionId) {
      sectionId = get<{ id: string }>(this.db, "SELECT id FROM sections WHERE project_id = ? ORDER BY position LIMIT 1", input.project_id)?.id ?? null;
    } else {
      const s = get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", sectionId);
      if (!s || s.project_id !== input.project_id) throw badRequest("Section invalide");
    }
    if (input.assignee_id) this.checkAssignee(input.project_id, input.assignee_id);
    const id = uid("tsk"); const ts = now();
    run(this.db, `INSERT INTO tasks (id, number, project_id, section_id, parent_id, title, description, assignee_id, creator_id,
      priority, start_on, due_on, position, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, this.nextNumber(), input.project_id, sectionId, input.parent_id ?? null, title, input.description ?? "",
      input.assignee_id ?? null, actorId, input.priority ?? "none", input.start_on ?? null, input.due_on ?? null,
      this.endPosition(input.project_id, sectionId, input.parent_id ?? null), JSON.stringify(input.tags ?? []), ts, ts);
    const task = this.taskRow(id);
    this.log(actorId, "task.created", { projectId: task.project_id, taskId: id, data: { title, parent_id: task.parent_id } });
    if (task.assignee_id && task.assignee_id !== actorId) this.notifyAssigned(actorId, task);
    this.bus.emit({ type: "task.created", actorId, projectId: task.project_id, taskId: id });
    return task;
  }

  private checkAssignee(projectId: string, userId: string) {
    this.user(userId);
    if (!this.role(userId, projectId)) {
      const u = this.user(userId);
      throw badRequest(`${u.name} n'est pas membre de ce projet`);
    }
  }

  updateTask(actorId: string, ref: string, patch: TaskPatch): Task {
    const before = this.taskRow(this.resolveTaskId(ref));
    this.require(actorId, before.project_id, "editor");
    const start = patch.start_on !== undefined ? patch.start_on : before.start_on;
    const due = patch.due_on !== undefined ? patch.due_on : before.due_on;
    if (start && due && start > due) throw badRequest("La date de début doit précéder l'échéance");
    const fields = ["title", "description", "section_id", "assignee_id", "priority", "start_on", "due_on", "completed", "position", "tags"] as const;
    const sets: string[] = []; const vals: unknown[] = []; const changes: string[] = []; const previous: Record<string, unknown> = {};
    for (const k of fields) {
      const v = patch[k];
      if (v === undefined) continue;
      if (k === "title" && !String(v).trim()) throw badRequest("Le titre ne peut pas être vide");
      if (k === "assignee_id" && v) this.checkAssignee(before.project_id, String(v));
      if (k === "section_id" && v) {
        const s = get<Section>(this.db, "SELECT * FROM sections WHERE id = ?", v);
        if (!s || s.project_id !== before.project_id) throw badRequest("Section invalide");
      }
      if (k === "priority" && !["none", "low", "medium", "high", "urgent"].includes(String(v))) throw badRequest("Priorité invalide");
      const dbVal = k === "completed" ? (v ? 1 : 0) : k === "tags" ? JSON.stringify(v) : v;
      const prev = k === "tags" ? JSON.stringify(before.tags) : k === "completed" ? (before.completed ? 1 : 0) : before[k];
      if (prev === dbVal) continue;
      sets.push(`${k} = ?`); vals.push(dbVal); changes.push(k); previous[k] = before[k];
      if (k === "completed") { sets.push("completed_at = ?"); vals.push(v ? now() : null); }
    }
    if (!sets.length) return before;
    sets.push("updated_at = ?"); vals.push(now());
    run(this.db, `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...vals, before.id);
    const after = this.taskRow(before.id);
    for (const k of changes) {
      if (k === "position") continue;
      this.log(actorId, `task.${k}`, { projectId: after.project_id, taskId: after.id, data: { from: previous[k], to: (after as unknown as Row)[k] } });
    }
    if (changes.includes("assignee_id") && after.assignee_id && after.assignee_id !== actorId) this.notifyAssigned(actorId, after);
    if (changes.includes("completed") && after.completed && after.creator_id && after.creator_id !== actorId) {
      this.notify(after.creator_id, { kind: "task.completed", title: `${this.user(actorId).name} a terminé « ${after.title} »`, task_id: after.id, project_id: after.project_id, actor_id: actorId });
    }
    this.bus.emit({ type: "task.updated", actorId, projectId: after.project_id, taskId: after.id, changes, previous });
    return after;
  }

  moveTask(actorId: string, ref: string, to: { section_id: string; before_id?: string | null; after_id?: string | null }) {
    const task = this.taskRow(this.resolveTaskId(ref));
    this.require(actorId, task.project_id, "editor");
    const pos = (id?: string | null) => (id ? get<{ position: number }>(this.db, "SELECT position FROM tasks WHERE id = ?", id)?.position : undefined);
    const a = pos(to.after_id), b = pos(to.before_id);
    let position: number;
    if (a !== undefined && b !== undefined) position = (a + b) / 2;
    else if (a !== undefined) position = a + 1024;
    else if (b !== undefined) position = b - 1024;
    else position = this.endPosition(task.project_id, to.section_id, null);
    return this.updateTask(actorId, task.id, { section_id: to.section_id, position });
  }

  duplicateTask(actorId: string, ref: string, opts: { subtasks?: boolean } = {}): Task {
    const src = this.taskRow(this.resolveTaskId(ref));
    this.require(actorId, src.project_id, "editor");
    const copy = (t: Task, parentId: string | null, title: string) => this.createTask(actorId, {
      project_id: t.project_id, title, description: t.description, section_id: parentId ? null : t.section_id, parent_id: parentId,
      assignee_id: t.assignee_id, priority: t.priority, start_on: t.start_on, due_on: t.due_on, tags: t.tags,
    });
    const created = copy(src, src.parent_id, `Copie de ${src.title}`);
    if (opts.subtasks) {
      for (const sub of all<Row>(this.db, "SELECT * FROM tasks WHERE parent_id = ? ORDER BY position", src.id).map(toTask)) copy(sub, created.id, sub.title);
    }
    return this.taskRow(created.id);
  }

  moveTaskToProject(actorId: string, ref: string, projectId: string): Task {
    const t = this.taskRow(this.resolveTaskId(ref));
    if (t.parent_id) throw badRequest("Une sous-tâche se déplace avec sa tâche parente");
    this.require(actorId, t.project_id, "editor");
    this.require(actorId, projectId, "editor");
    if (t.project_id === projectId) return t;
    const section = get<{ id: string }>(this.db, "SELECT id FROM sections WHERE project_id = ? ORDER BY position LIMIT 1", projectId)?.id ?? null;
    const ids = [t.id];
    for (let i = 0; i < ids.length; i++) all<{ id: string }>(this.db, "SELECT id FROM tasks WHERE parent_id = ?", ids[i]).forEach((r) => ids.push(r.id));
    tx(this.db, () => {
      for (const id of ids) {
        const row = this.taskRow(id);
        const keep = row.assignee_id && this.role(row.assignee_id, projectId) ? row.assignee_id : null;
        run(this.db, "UPDATE tasks SET project_id = ?, assignee_id = ?, updated_at = ? WHERE id = ?", projectId, keep, now(), id);
      }
      run(this.db, "UPDATE tasks SET section_id = ?, position = ? WHERE id = ?", section, this.endPosition(projectId, section, null), t.id);
      run(this.db, "UPDATE activity SET project_id = ? WHERE task_id IN (" + ids.map(() => "?").join(",") + ")", projectId, ...ids);
    });
    this.log(actorId, "task.moved_project", { projectId, taskId: t.id, data: { from: t.project_id, to: projectId } });
    this.bus.emit({ type: "task.deleted", actorId, projectId: t.project_id, taskId: t.id });
    this.bus.emit({ type: "task.updated", actorId, projectId, taskId: t.id, changes: ["project_id"], previous: { project_id: t.project_id } });
    return this.taskRow(t.id);
  }

  deleteTask(actorId: string, ref: string) {
    const task = this.taskRow(this.resolveTaskId(ref));
    this.require(actorId, task.project_id, "editor");
    run(this.db, "DELETE FROM tasks WHERE id = ?", task.id);
    this.log(actorId, "task.deleted", { projectId: task.project_id, data: { title: task.title, number: task.number } });
    this.bus.emit({ type: "task.deleted", actorId, projectId: task.project_id, taskId: task.id });
  }

  // ----------------------------------------------------------- commentaires
  addComment(actorId: string, ref: string, body: string, aiRunId: string | null = null): Comment {
    const task = this.taskRow(this.resolveTaskId(ref));
    this.require(actorId, task.project_id, "commenter");
    const text = body.trim();
    if (!text) throw badRequest("Le commentaire est vide");
    const id = uid("cmt");
    run(this.db, "INSERT INTO comments (id, task_id, author_id, body, ai_run_id, created_at) VALUES (?,?,?,?,?,?)", id, task.id, actorId, text, aiRunId, now());
    this.log(actorId, "comment.created", { projectId: task.project_id, taskId: task.id, data: { excerpt: text.slice(0, 140) } });
    // Mentions : @Prénom
    const mentions = this.listUsers().filter((u) => new RegExp(`@${u.name.split(" ")[0]}\\b`, "i").test(text) && u.id !== actorId).map((u) => u.id);
    const author = this.user(actorId);
    const notified = new Set<string>();
    for (const uidm of mentions) {
      notified.add(uidm);
      if (!this.user(uidm).is_ai) this.notify(uidm, { kind: "mention", title: `${author.name} vous a mentionné sur « ${task.title} »`, body: text.slice(0, 200), task_id: task.id, project_id: task.project_id, actor_id: actorId });
    }
    if (task.assignee_id && task.assignee_id !== actorId && !notified.has(task.assignee_id) && !this.user(task.assignee_id).is_ai) {
      this.notify(task.assignee_id, { kind: "comment", title: `${author.name} a commenté « ${task.title} »`, body: text.slice(0, 200), task_id: task.id, project_id: task.project_id, actor_id: actorId });
    }
    this.bus.emit({ type: "comment.created", actorId, projectId: task.project_id, taskId: task.id, commentId: id, mentions });
    return get<Comment>(this.db, "SELECT * FROM comments WHERE id = ?", id)!;
  }

  private commentRow(id: string) {
    const c = get<Comment>(this.db, "SELECT * FROM comments WHERE id = ?", id);
    if (!c) throw notFound("Commentaire introuvable");
    return { c, task: this.taskRow(c.task_id) };
  }
  updateComment(actorId: string, id: string, body: string): Comment {
    const { c, task } = this.commentRow(id);
    this.require(actorId, task.project_id, "commenter");
    if (c.author_id !== actorId) throw forbidden("Seul l'auteur peut modifier ce commentaire");
    if (!body.trim()) throw badRequest("Le commentaire est vide");
    run(this.db, "UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", body.trim(), now(), id);
    this.bus.emit({ type: "task.updated", actorId, projectId: task.project_id, taskId: task.id, changes: ["comment"], previous: {} });
    return get<Comment>(this.db, "SELECT * FROM comments WHERE id = ?", id)!;
  }
  deleteComment(actorId: string, id: string) {
    const { c, task } = this.commentRow(id);
    const role = this.require(actorId, task.project_id, "commenter");
    if (c.author_id !== actorId && role !== "admin") throw forbidden("Seuls l'auteur et les administrateurs du projet peuvent supprimer ce commentaire");
    run(this.db, "DELETE FROM comments WHERE id = ?", id);
    this.log(actorId, "comment.deleted", { projectId: task.project_id, taskId: task.id, data: { author: c.author_id } });
    this.bus.emit({ type: "task.updated", actorId, projectId: task.project_id, taskId: task.id, changes: ["comment"], previous: {} });
  }

  // ----------------------------------------------------------- notifications
  notify(userId: string, n: { kind: string; title: string; body?: string; task_id?: string | null; project_id?: string | null; approval_id?: string | null; actor_id?: string | null }) {
    run(this.db, `INSERT INTO notifications (id, user_id, kind, title, body, task_id, project_id, approval_id, actor_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, uid("ntf"), userId, n.kind, n.title, n.body ?? "", n.task_id ?? null, n.project_id ?? null, n.approval_id ?? null, n.actor_id ?? null, now());
    this.bus.emit({ type: "notification", userId });
  }
  private notifyAssigned(actorId: string, task: Task) {
    if (!task.assignee_id || this.user(task.assignee_id).is_ai) return;
    this.notify(task.assignee_id, { kind: "assigned", title: `${this.user(actorId).name} vous a assigné « ${task.title} »`, task_id: task.id, project_id: task.project_id, actor_id: actorId });
  }
  listNotifications(userId: string) {
    return all<Row>(this.db, "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", userId).map(toNotif);
  }
  markRead(userId: string, ids: string[] | "all") {
    if (ids === "all") run(this.db, "UPDATE notifications SET read = 1 WHERE user_id = ?", userId);
    else for (const id of ids) run(this.db, "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?", id, userId);
    this.bus.emit({ type: "notification", userId });
  }

  // ----------------------------------------------------------- activité & stats
  log(actorId: string, kind: string, o: { projectId?: string | null; taskId?: string | null; data?: Record<string, unknown> }) {
    run(this.db, "INSERT INTO activity (id, project_id, task_id, actor_id, kind, data, created_at) VALUES (?,?,?,?,?,?,?)",
      uid("act"), o.projectId ?? null, o.taskId ?? null, actorId, kind, JSON.stringify(o.data ?? {}), now());
  }
  projectActivity(actorId: string, projectId: string, limit = 40) {
    this.require(actorId, projectId);
    return all<Row>(this.db, "SELECT * FROM activity WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit).map(toActivity);
  }
  projectStats(actorId: string, projectId: string) {
    this.require(actorId, projectId);
    const tasks = this.listTasks(actorId, { project_id: projectId });
    const t = today();
    const bySection = all<{ id: string; name: string }>(this.db, "SELECT id, name FROM sections WHERE project_id = ? ORDER BY position", projectId)
      .map((s) => ({ ...s, open: tasks.filter((x) => x.section_id === s.id && !x.completed).length, done: tasks.filter((x) => x.section_id === s.id && x.completed).length }));
    const byAssignee = new Map<string, { open: number; done: number; overdue: number }>();
    for (const x of tasks) {
      const k = x.assignee_id ?? "";
      const e = byAssignee.get(k) ?? { open: 0, done: 0, overdue: 0 };
      if (x.completed) e.done++; else { e.open++; if (x.due_on && x.due_on < t) e.overdue++; }
      byAssignee.set(k, e);
    }
    const byPriority = (["urgent", "high", "medium", "low", "none"] as Priority[]).map((p) => ({ priority: p, open: tasks.filter((x) => !x.completed && x.priority === p).length }));
    // Burnup : tâches terminées cumulées sur 14 jours
    const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toISOString().slice(0, 10); });
    const burnup = days.map((d) => ({ day: d, done: tasks.filter((x) => x.completed && (x.completed_at ?? "").slice(0, 10) <= d).length, total: tasks.filter((x) => x.created_at.slice(0, 10) <= d).length }));
    return {
      total: tasks.length, done: tasks.filter((x) => x.completed).length,
      overdue: tasks.filter((x) => !x.completed && x.due_on && x.due_on < t).length,
      due_this_week: tasks.filter((x) => { if (x.completed || !x.due_on) return false; const d = new Date(); d.setDate(d.getDate() + 7); return x.due_on >= t && x.due_on <= d.toISOString().slice(0, 10); }).length,
      unassigned: tasks.filter((x) => !x.completed && !x.assignee_id).length,
      bySection, byPriority, burnup,
      byAssignee: [...byAssignee.entries()].map(([user_id, v]) => ({ user_id: user_id || null, ...v })).sort((a, b) => b.open - a.open),
    };
  }

  // ----------------------------------------------------------- recherche
  search(actorId: string, q: string) {
    const text = q.trim();
    if (!text) return { tasks: [], projects: [] };
    const num = text.match(/^#?(\d+)$/);
    const tasks = num
      ? this.listTasks(actorId, { include_subtasks: true }).filter((t) => t.number === Number(num[1]))
      : this.listTasks(actorId, { text, include_subtasks: true, limit: 20 });
    const projects = this.listProjects(actorId).filter((p) => p.name.toLowerCase().includes(text.toLowerCase())).slice(0, 8);
    return { tasks, projects };
  }
}

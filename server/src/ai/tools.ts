import type { Services, Task, Priority } from "../services.js";
import { all, get, now, run, uid } from "../db.js";
import { badRequest } from "../services.js";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

const taskRef = { type: "string", description: "Numéro de tâche (ex. « #12 » ou « 12 »)" };
const userRef = { type: "string", description: "Id ou prénom d'un membre" };
const date = { type: "string", description: "Date AAAA-MM-JJ" };
const priority = { type: "string", enum: ["none", "low", "medium", "high", "urgent"] };

export const READ_TOOLS: ToolDef[] = [
  {
    name: "list_projects",
    description: "Liste les projets accessibles avec leur avancement (tâches, terminées, en retard). À appeler pour s'orienter.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_project",
    description: "Détail d'un projet : description, statut, sections, membres (id, nom, rôle) et indicateurs clés.",
    input_schema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
  },
  {
    name: "search_tasks",
    description: "Recherche des tâches avec des filtres structurés. Traduis la demande en filtres précis (projet, assigné, en retard, échéance, priorité, texte) au lieu de tout lister. Renvoie une liste courte.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" }, assignee: userRef, unassigned: { type: "boolean" },
        completed: { type: "boolean" }, overdue: { type: "boolean", description: "Non terminées dont l'échéance est passée" },
        due_before: date, due_after: date, priority, text: { type: "string", description: "Mot-clé dans le titre ou la description" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description: "Détail complet d'une tâche : description, section, assigné, échéance, sous-tâches et commentaires récents.",
    input_schema: { type: "object", properties: { task: taskRef }, required: ["task"], additionalProperties: false },
  },
];

export const WRITE_TOOLS: ToolDef[] = [
  {
    name: "create_task",
    description: "Crée une tâche (ou une sous-tâche avec parent). Soumis à validation humaine.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
        section: { type: "string", description: "Nom de la section (colonne)" }, parent: taskRef,
        assignee: userRef, due_on: date, priority,
      },
      required: ["project_id", "title"], additionalProperties: false,
    },
  },
  {
    name: "update_task",
    description: "Modifie une tâche : titre, description, section, assigné, échéance, priorité, terminée. Soumis à validation humaine.",
    input_schema: {
      type: "object",
      properties: {
        task: taskRef, title: { type: "string" }, description: { type: "string" },
        section: { type: "string", description: "Nom de la section cible" }, assignee: userRef,
        due_on: date, priority, completed: { type: "boolean" },
      },
      required: ["task"], additionalProperties: false,
    },
  },
  {
    name: "add_comment",
    description: "Publie un commentaire visible par l'équipe sur une tâche. Mentionne quelqu'un avec @Prénom. Soumis à validation humaine.",
    input_schema: { type: "object", properties: { task: taskRef, body: { type: "string" } }, required: ["task", "body"], additionalProperties: false },
  },
  {
    name: "remember",
    description: "Mémorise une information durable (préférence d'équipe, décision, convention) rattachée à un projet ou une tâche, pour les prochaines fois.",
    input_schema: {
      type: "object",
      properties: { object_type: { type: "string", enum: ["project", "task"] }, object_id: { type: "string", description: "Id du projet ou numéro de tâche" }, content: { type: "string" } },
      required: ["object_type", "object_id", "content"], additionalProperties: false,
    },
  },
];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------
type Input = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export class ToolRunner {
  constructor(private svc: Services) {}

  resolveUser(ref: unknown): string | undefined {
    const r = str(ref)?.trim().replace(/^@/, "");
    if (!r) return undefined;
    const users = this.svc.listUsers();
    const hit = users.find((u) => u.id === r) ?? users.find((u) => u.name.toLowerCase() === r.toLowerCase())
      ?? users.find((u) => u.name.split(" ")[0].toLowerCase() === r.toLowerCase());
    if (!hit) throw badRequest(`Membre « ${r} » introuvable`);
    return hit.id;
  }
  private resolveSection(projectId: string, name: unknown): string | undefined {
    const n = str(name)?.trim().toLowerCase();
    if (!n) return undefined;
    const secs = all<{ id: string; name: string }>(this.svc.db, "SELECT id, name FROM sections WHERE project_id = ?", projectId);
    const hit = secs.find((s) => s.id === n) ?? secs.find((s) => s.name.toLowerCase() === n) ?? secs.find((s) => s.name.toLowerCase().includes(n));
    if (!hit) throw badRequest(`Section « ${name} » introuvable. Sections : ${secs.map((s) => s.name).join(", ")}`);
    return hit.id;
  }

  brief(t: Task) {
    const u = t.assignee_id ? this.svc.user(t.assignee_id) : null;
    const sec = t.section_id ? get<{ name: string }>(this.svc.db, "SELECT name FROM sections WHERE id = ?", t.section_id)?.name : null;
    return {
      task: `#${t.number}`, title: t.title, project_id: t.project_id, section: sec, assignee: u ? u.name : null,
      due_on: t.due_on, priority: t.priority, completed: t.completed,
      ...(t.subtask_count ? { subtasks: `${t.subtask_done}/${t.subtask_count}` } : {}),
    };
  }

  execute(actorId: string, name: string, input: Input): unknown {
    const s = this.svc;
    switch (name) {
      case "list_projects":
        return s.listProjects(actorId).map((p) => ({ project_id: p.id, name: p.name, status: p.status, due_on: p.due_on, tasks: p.task_count, done: p.done_count, overdue: p.overdue_count }));
      case "get_project": {
        const p = s.getProject(actorId, String(input.project_id));
        const st = s.projectStats(actorId, p.id);
        return {
          project_id: p.id, name: p.name, description: p.description, status: p.status, due_on: p.due_on,
          sections: p.sections.map((x) => x.name),
          members: p.members.map((m) => { const u = s.user(m.user_id); return { id: u.id, name: u.name, title: u.title, role: m.role, is_ai: u.is_ai }; }),
          stats: { total: st.total, done: st.done, overdue: st.overdue, due_this_week: st.due_this_week, unassigned: st.unassigned },
        };
      }
      case "search_tasks": {
        const tasks = s.listTasks(actorId, {
          project_id: str(input.project_id), assignee_id: input.unassigned ? null : this.resolveUser(input.assignee),
          completed: typeof input.completed === "boolean" ? input.completed : undefined, overdue: input.overdue === true,
          due_before: str(input.due_before), due_after: str(input.due_after), priority: str(input.priority) as Priority | undefined,
          text: str(input.text), include_subtasks: true, limit: Number(input.limit) || 25,
        });
        return { count: tasks.length, tasks: tasks.map((t) => this.brief(t)) };
      }
      case "get_task": {
        const t = s.getTask(actorId, String(input.task));
        return {
          ...this.brief(t), description: t.description, project: t.project.name,
          parent: t.parent ? `#${t.parent.number} ${t.parent.title}` : null,
          subtasks: t.subtasks.map((x) => this.brief(x)),
          comments: t.comments.slice(-8).map((c) => ({ author: s.user(c.author_id).name, body: c.body.slice(0, 500), at: c.created_at.slice(0, 16) })),
        };
      }
      case "create_task": {
        const projectId = String(input.project_id);
        const t = s.createTask(actorId, {
          project_id: projectId, title: String(input.title ?? ""), description: str(input.description),
          section_id: this.resolveSection(projectId, input.section), parent_id: str(input.parent),
          assignee_id: this.resolveUser(input.assignee), due_on: str(input.due_on), priority: str(input.priority) as Priority | undefined,
        });
        return { created: this.brief(t) };
      }
      case "update_task": {
        const id = s.resolveTaskId(String(input.task));
        const cur = s.getTask(actorId, id);
        const t = s.updateTask(actorId, id, {
          title: str(input.title), description: str(input.description),
          section_id: this.resolveSection(cur.project_id, input.section),
          assignee_id: input.assignee === "" ? null : this.resolveUser(input.assignee),
          due_on: str(input.due_on), priority: str(input.priority) as Priority | undefined,
          completed: typeof input.completed === "boolean" ? input.completed : undefined,
        });
        return { updated: this.brief(t) };
      }
      case "add_comment": {
        const c = s.addComment(actorId, String(input.task), String(input.body ?? ""), str(input.__run_id) ?? null);
        return { commented: true, comment_id: c.id };
      }
      case "remember": {
        const type = input.object_type === "task" ? "task" : "project";
        let objectId = String(input.object_id); let projectId = objectId;
        if (type === "task") { const t = s.getTask(actorId, objectId); objectId = t.id; projectId = t.project_id; }
        else s.require(actorId, projectId);
        run(s.db, "INSERT INTO ai_memories (id, agent_id, object_type, object_id, project_id, content, created_at) VALUES (?,?,?,?,?,?,?)",
          uid("mem"), actorId, type, objectId, projectId, String(input.content ?? ""), now());
        return { remembered: true };
      }
      default:
        throw badRequest(`Outil inconnu : ${name}`);
    }
  }

  /** Phrase lisible pour la carte de validation. */
  describe(actorId: string, name: string, input: Input): string {
    const s = this.svc;
    const taskTitle = (ref: unknown) => { try { const t = s.getTask(actorId, String(ref)); return `#${t.number} « ${t.title} »`; } catch { return String(ref); } };
    const who = (ref: unknown) => { try { const id = this.resolveUser(ref); return id ? s.user(id).name : "personne"; } catch { return String(ref); } };
    switch (name) {
      case "add_comment": return `Commenter ${taskTitle(input.task)}`;
      case "create_task": return input.parent ? `Créer la sous-tâche « ${input.title} » sous ${taskTitle(input.parent)}` : `Créer la tâche « ${input.title} »${input.assignee ? ` pour ${who(input.assignee)}` : ""}`;
      case "update_task": {
        const parts: string[] = [];
        if (input.completed === true) parts.push("la marquer terminée");
        if (input.section) parts.push(`la déplacer vers « ${input.section} »`);
        if (input.assignee) parts.push(`l'assigner à ${who(input.assignee)}`);
        if (input.due_on) parts.push(`changer l'échéance au ${input.due_on}`);
        if (input.priority) parts.push(`priorité ${input.priority}`);
        if (input.title) parts.push(`renommer en « ${input.title} »`);
        if (input.description) parts.push("réécrire la description");
        return `Modifier ${taskTitle(input.task)} : ${parts.join(", ") || "mise à jour"}`;
      }
      case "remember": return "Mémoriser une information pour la suite";
      default: return name;
    }
  }

  memories(agentId: string, projectId: string, taskId?: string) {
    return all<{ content: string }>(this.svc.db,
      `SELECT content FROM ai_memories WHERE agent_id = ? AND project_id = ? AND (object_type = 'project' OR object_id = ?) ORDER BY created_at DESC LIMIT 15`,
      agentId, projectId, taskId ?? "").map((m) => m.content);
  }
}

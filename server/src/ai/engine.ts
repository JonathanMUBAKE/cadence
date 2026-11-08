import { all, get, now, run, uid } from "../db.js";
import type { Bus, DomainEvent } from "../bus.js";
import { badRequest, forbidden, notFound, today, type Services, type User } from "../services.js";
import { READ_TOOLS, WRITE_TOOLS, WRITE_TOOL_NAMES, ToolRunner } from "./tools.js";
import { RefusalError, type AgentMode, type AiProvider, type ContentBlock, type Msg, type TextBlock, type ToolResultBlock, type ToolUseBlock } from "./provider.js";

export type RunKind = "task" | "mention" | "rule" | "assistant";
export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

export interface AiRun {
  id: string; agent_id: string; kind: RunKind; task_id: string | null; project_id: string | null; requested_by: string | null;
  rule_id: string | null; status: RunStatus; summary: string | null; error: string | null; provider: string; created_at: string; finished_at: string | null;
}
export interface AiStep { id: string; run_id: string; seq: number; kind: string; tool: string | null; input: unknown; output: unknown; status: string; created_at: string }
export interface AiApproval {
  id: string; run_id: string; agent_id: string; task_id: string | null; project_id: string | null; tool: string; input: Record<string, unknown>;
  summary: string; status: "pending" | "approved" | "rejected" | "expired"; decided_by: string | null; decided_at: string | null; created_at: string;
}
export interface AiRule {
  id: string; project_id: string; name: string; trigger: "task_created" | "task_moved" | "task_overdue"; section_id: string | null;
  agent_id: string; instructions: string; auto_approve: boolean; enabled: boolean; created_by: string | null; created_at: string;
}

const MAX_ROUNDS = 12;
const trim = (v: unknown, n = 4000) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };
const parse = (s: unknown) => { try { return JSON.parse(String(s)); } catch { return s; } };

interface StartOpts {
  agentId: string; kind: RunKind; taskId?: string | null; projectId?: string | null; requestedBy?: string | null;
  ruleId?: string | null; instructions?: string; autoApprove?: boolean; commentId?: string;
}

export class AiEngine {
  readonly tools: ToolRunner;
  private waiters = new Map<string, (ok: boolean) => void>();
  private controllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private svc: Services, private bus: Bus, public provider: AiProvider) {
    this.tools = new ToolRunner(svc);
    // Toute exécution laissée en suspens par un redémarrage est close proprement.
    run(svc.db, "UPDATE ai_approvals SET status = 'expired' WHERE status = 'pending'");
    run(svc.db, "UPDATE ai_runs SET status = 'failed', error = 'Interrompu par un redémarrage du serveur', finished_at = ? WHERE status IN ('queued','running','waiting_approval')", now());
  }

  // ======================================================================
  // Déclencheurs : assignation, @mention, règles
  // ======================================================================
  attach() {
    const off = this.bus.on((e) => { try { this.onEvent(e); } catch (err) { console.error("[ai] trigger", err); } });
    this.timer = setInterval(() => this.checkOverdueRules(), 60_000);
    this.timer.unref?.();
    return () => { off(); if (this.timer) clearInterval(this.timer); };
  }

  private isAi(id: string | null | undefined) {
    if (!id) return false;
    return !!get<{ is_ai: number }>(this.svc.db, "SELECT is_ai FROM users WHERE id = ?", id)?.is_ai;
  }

  private onEvent(e: DomainEvent) {
    if (!("actorId" in e) || this.isAi(e.actorId)) return; // jamais de boucle IA → IA
    if (e.type === "task.created" || (e.type === "task.updated" && e.changes.includes("assignee_id"))) {
      const t = get<{ assignee_id: string | null }>(this.svc.db, "SELECT assignee_id FROM tasks WHERE id = ?", e.taskId);
      if (t?.assignee_id && this.isAi(t.assignee_id)) {
        this.start({ agentId: t.assignee_id, kind: "task", taskId: e.taskId, projectId: e.projectId, requestedBy: e.actorId });
      }
    }
    if (e.type === "task.created") this.fireRules("task_created", e.projectId, e.taskId, e.actorId);
    if (e.type === "task.updated" && e.changes.includes("section_id")) this.fireRules("task_moved", e.projectId, e.taskId, e.actorId);
    if (e.type === "comment.created") {
      for (const id of e.mentions.filter((m) => this.isAi(m))) {
        this.start({ agentId: id, kind: "mention", taskId: e.taskId, projectId: e.projectId, requestedBy: e.actorId, commentId: e.commentId });
      }
    }
  }

  private fireRules(trigger: AiRule["trigger"], projectId: string, taskId: string, actorId: string) {
    const task = get<{ section_id: string | null; parent_id: string | null }>(this.svc.db, "SELECT section_id, parent_id FROM tasks WHERE id = ?", taskId);
    if (!task || task.parent_id) return;
    for (const r of this.listRulesRaw(projectId).filter((x) => x.enabled && x.trigger === trigger)) {
      if (r.section_id && r.section_id !== task.section_id) continue;
      this.start({ agentId: r.agent_id, kind: "rule", ruleId: r.id, taskId, projectId, requestedBy: actorId, instructions: r.instructions, autoApprove: r.auto_approve });
    }
  }

  checkOverdueRules() {
    const rules = all<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_rules WHERE enabled = 1 AND trigger = 'task_overdue'").map(toRule);
    for (const r of rules) {
      const tasks = all<{ id: string }>(this.svc.db,
        `SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.completed = 0 AND t.parent_id IS NULL AND t.due_on IS NOT NULL AND t.due_on < ?
         AND NOT EXISTS (SELECT 1 FROM ai_runs a WHERE a.rule_id = ? AND a.task_id = t.id)`, r.project_id, today(), r.id);
      for (const t of tasks.slice(0, 5)) {
        this.start({ agentId: r.agent_id, kind: "rule", ruleId: r.id, taskId: t.id, projectId: r.project_id, requestedBy: r.created_by, instructions: r.instructions, autoApprove: r.auto_approve });
      }
    }
  }

  // ======================================================================
  // Exécutions
  // ======================================================================
  start(o: StartOpts): string | null {
    // Une seule exécution active par (agent, tâche)
    if (o.taskId && o.kind !== "assistant") {
      const active = get(this.svc.db, "SELECT id FROM ai_runs WHERE agent_id = ? AND task_id = ? AND status IN ('queued','running','waiting_approval')", o.agentId, o.taskId);
      if (active) return null;
    }
    const id = uid("run");
    run(this.svc.db, `INSERT INTO ai_runs (id, agent_id, kind, task_id, project_id, requested_by, rule_id, status, provider, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, id, o.agentId, o.kind, o.taskId ?? null, o.projectId ?? null, o.requestedBy ?? null, o.ruleId ?? null, "queued", this.provider.name, now());
    this.emitRun(id);
    queueMicrotask(() => { this.execute(id, o).catch((err) => console.error("[ai] run", err)); });
    return id;
  }

  /** Assistant conversationnel : agit avec les droits de l'utilisateur qui pose la question. */
  startAssistant(userId: string, history: { role: "user" | "assistant"; content: string }[], projectId: string | null): string {
    if (!history.length || history[history.length - 1].role !== "user") throw badRequest("La conversation doit se terminer par un message de l'utilisateur");
    if (projectId) this.svc.require(userId, projectId);
    const id = uid("run");
    run(this.svc.db, `INSERT INTO ai_runs (id, agent_id, kind, project_id, requested_by, status, provider, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, "ai_cadence", "assistant", projectId, userId, "queued", this.provider.name, now());
    this.emitRun(id);
    queueMicrotask(() => { this.executeAssistant(id, userId, history.slice(-20), projectId).catch((err) => console.error("[ai] assistant", err)); });
    return id;
  }

  private async execute(runId: string, o: StartOpts) {
    const agent = this.svc.user(o.agentId);
    const ctl = new AbortController();
    this.controllers.set(runId, ctl);
    this.setStatus(runId, "running");
    try {
      if (!o.taskId) throw new Error("Aucune tâche associée");
      let task;
      try { task = this.tools.execute(agent.id, "get_task", { task: o.taskId }); }
      catch (e) { throw new Error(`${agent.name} n'a pas accès à cette tâche : ${(e as Error).message}`); }
      const project = this.tools.execute(agent.id, "get_project", { project_id: o.projectId });
      const memories = this.tools.memories(agent.id, String(o.projectId), o.taskId);
      const comment = o.commentId ? get<{ body: string; author_id: string }>(this.svc.db, "SELECT body, author_id FROM comments WHERE id = ?", o.commentId) : null;
      const requester = o.requestedBy ? this.svc.user(o.requestedBy) : null;

      const context = [
        `Date du jour : ${today()}`,
        requester ? `Demandé par : ${requester.name} (${requester.id})` : "",
        `Projet :\n${JSON.stringify(project)}`,
        `Tâche :\n${JSON.stringify(task)}`,
        memories.length ? `Ce dont tu te souviens sur ce projet :\n- ${memories.join("\n- ")}` : "",
        o.instructions ? `Consigne de la règle qui t'a déclenché :\n${o.instructions}` : "",
        comment ? `${this.svc.user(comment.author_id).name} t'a mentionné dans ce commentaire :\n« ${comment.body} »` : "",
        "",
        o.kind === "mention" ? "Réponds à ce commentaire. Si on te demande une action, fais-la avec tes outils." :
          o.kind === "rule" ? "Applique la consigne de la règle à cette tâche." : "Cette tâche t'est assignée : réalise-la.",
      ].filter(Boolean).join("\n\n");

      const mode: AgentMode = o.kind === "mention" ? "mention" : "teammate";
      const text = await this.loop(runId, {
        system: teammateSystem(agent), actorId: agent.id, approverIds: this.approvers(o, agent.id), autoApprove: !!o.autoApprove,
        messages: [{ role: "user", content: context }], tools: [...READ_TOOLS, ...WRITE_TOOLS], signal: ctl.signal,
        hint: { mode, actorId: agent.id, projectId: o.projectId, taskId: o.taskId, requesterId: o.requestedBy },
      });
      if (text.trim()) this.svc.addComment(agent.id, o.taskId, text, runId);
      this.finish(runId, "done", text);
    } catch (err) {
      this.fail(runId, err);
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async executeAssistant(runId: string, userId: string, history: { role: "user" | "assistant"; content: string }[], projectId: string | null) {
    const ctl = new AbortController();
    this.controllers.set(runId, ctl);
    this.setStatus(runId, "running");
    try {
      const user = this.svc.user(userId);
      const projects = this.svc.listProjects(userId).map((p) => `${p.name} (id ${p.id})`).join(", ");
      const current = projectId ? this.svc.getProject(userId, projectId) : null;
      const system = assistantSystem(user, projects, current ? `${current.name} (id ${current.id})` : null);
      const text = await this.loop(runId, {
        system, actorId: userId, approverIds: [userId], autoApprove: false,
        messages: history.map((m) => ({ role: m.role, content: m.content }) as Msg), tools: [...READ_TOOLS, ...WRITE_TOOLS], signal: ctl.signal,
        hint: { mode: "assistant", actorId: userId, projectId, requesterId: userId },
        onText: (delta) => this.bus.emit({ type: "ai.delta", runId, userId, delta }),
      });
      this.finish(runId, "done", text);
    } catch (err) {
      this.fail(runId, err);
    } finally {
      this.controllers.delete(runId);
    }
  }

  /** Boucle agent : le modèle appelle des outils ; chaque écriture passe par un checkpoint. */
  private async loop(runId: string, o: {
    system: string; actorId: string; approverIds: string[]; autoApprove: boolean; messages: Msg[];
    tools: typeof READ_TOOLS; signal: AbortSignal; hint: Parameters<AiProvider["turn"]>[0]["hint"]; onText?: (d: string) => void;
  }): Promise<string> {
    const messages = o.messages;
    let finalText = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (o.signal.aborted) throw new CancelledError();
      const res = await this.provider.turn({ system: o.system, messages, tools: o.tools, signal: o.signal, hint: o.hint, onText: o.onText });
      messages.push({ role: "assistant", content: res.content });
      const text = res.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (res.stop_reason === "pause_turn") continue;
      if (res.stop_reason !== "tool_use") { finalText = text; break; }
      if (text) this.step(runId, { kind: "thought", output: text, status: "ok" });

      const results: ToolResultBlock[] = [];
      for (const b of res.content.filter((x): x is ToolUseBlock => x.type === "tool_use")) {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const stepId = this.step(runId, { kind: "tool", tool: b.name, input, status: "running" });
        if (WRITE_TOOL_NAMES.has(b.name) && !o.autoApprove) {
          const decision = await this.checkpoint(runId, o.actorId, o.approverIds, b.name, input, o.hint.projectId ?? null, o.hint.taskId ?? null, o.signal);
          if (decision.ok) Object.assign(input, decision.input);
          if (!decision.ok) {
            this.updateStep(stepId, "rejected", "Refusé par un humain");
            results.push({ type: "tool_result", tool_use_id: b.id, content: "Refusé : un humain a refusé cette action au checkpoint. Ne la refais pas, adapte-toi." });
            continue;
          }
        }
        try {
          const out = this.tools.execute(o.actorId, b.name, b.name === "add_comment" ? { ...input, __run_id: runId } : input);
          this.updateStep(stepId, "ok", out);
          results.push({ type: "tool_result", tool_use_id: b.id, content: trim(out) });
        } catch (err) {
          const msg = (err as Error).message;
          this.updateStep(stepId, "error", msg);
          results.push({ type: "tool_result", tool_use_id: b.id, content: `Erreur : ${msg}`, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
      if (round === MAX_ROUNDS - 1) finalText = "J'ai atteint le nombre maximal d'étapes ; voici où j'en suis.";
    }
    return finalText;
  }

  private approvers(o: StartOpts, agentId: string): string[] {
    const ids = new Set<string>();
    if (o.requestedBy && !this.isAi(o.requestedBy)) ids.add(o.requestedBy);
    if (o.projectId) {
      for (const m of this.svc.members(o.projectId)) if ((m.role === "admin") && !this.isAi(m.user_id)) ids.add(m.user_id);
    }
    if (o.taskId) {
      const t = get<{ creator_id: string | null }>(this.svc.db, "SELECT creator_id FROM tasks WHERE id = ?", o.taskId);
      if (t?.creator_id && !this.isAi(t.creator_id)) ids.add(t.creator_id);
    }
    ids.delete(agentId);
    return [...ids];
  }

  private checkpoint(runId: string, actorId: string, approverIds: string[], tool: string, input: Record<string, unknown>, projectId: string | null, taskId: string | null, signal: AbortSignal): Promise<{ ok: boolean; input: Record<string, unknown> }> {
    const id = uid("apr");
    const summary = this.tools.describe(actorId, tool, input);
    run(this.svc.db, `INSERT INTO ai_approvals (id, run_id, agent_id, task_id, project_id, tool, input, summary, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, runId, actorId, taskId, projectId, tool, JSON.stringify(input), summary, "pending", now());
    this.setStatus(runId, "waiting_approval");
    const agent = this.svc.user(actorId);
    const run_ = this.getRun(runId);
    if (run_.kind !== "assistant") {
      for (const u of approverIds) this.svc.notify(u, { kind: "approval", title: `${agent.name} attend votre accord`, body: summary, task_id: taskId, project_id: projectId, approval_id: id, actor_id: actorId });
    }
    this.bus.emit({ type: "ai.approval", approvalId: id, runId, projectId, taskId });
    return new Promise((resolve) => {
      const onAbort = () => { this.waiters.delete(id); run(this.svc.db, "UPDATE ai_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'", id); resolve({ ok: false, input }); };
      signal.addEventListener("abort", onAbort, { once: true });
      // La personne qui valide peut avoir retouché l'action : on relit l'input enregistré.
      this.waiters.set(id, (ok) => { signal.removeEventListener("abort", onAbort); this.setStatus(runId, "running"); resolve({ ok, input: this.getApproval(id).input }); });
    });
  }

  decide(approvalId: string, userId: string, approve: boolean, edits?: Record<string, unknown>) {
    const a = this.getApproval(approvalId);
    if (a.status !== "pending") throw badRequest("Cette demande a déjà été traitée");
    const run_ = this.getRun(a.run_id);
    if (run_.kind === "assistant") { if (run_.requested_by !== userId) throw forbidden("Seule la personne qui a lancé l'assistant peut valider"); }
    else if (a.project_id) this.svc.require(userId, a.project_id, "editor");
    if (edits && approve) {
      const input = { ...a.input, ...edits };
      run(this.svc.db, "UPDATE ai_approvals SET input = ?, summary = ? WHERE id = ?", JSON.stringify(input), this.tools.describe(a.agent_id, a.tool, input), approvalId);
    }
    run(this.svc.db, "UPDATE ai_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", approve ? "approved" : "rejected", userId, now(), approvalId);
    run(this.svc.db, "UPDATE notifications SET read = 1 WHERE approval_id = ?", approvalId);
    this.svc.log(userId, approve ? "ai.approved" : "ai.rejected", { projectId: a.project_id, taskId: a.task_id, data: { summary: a.summary, agent: a.agent_id } });
    const w = this.waiters.get(approvalId);
    this.waiters.delete(approvalId);
    this.bus.emit({ type: "ai.approval", approvalId, runId: a.run_id, projectId: a.project_id, taskId: a.task_id });
    if (w) w(approve);
    else run(this.svc.db, "UPDATE ai_approvals SET status = 'expired' WHERE id = ?", approvalId);
    return this.getApproval(approvalId);
  }

  cancel(runId: string, userId: string) {
    const r = this.getRun(runId);
    if (r.requested_by !== userId && r.project_id) this.svc.require(userId, r.project_id, "editor");
    this.controllers.get(runId)?.abort();
    if (["queued", "running", "waiting_approval"].includes(r.status)) this.finish(runId, "cancelled", null);
  }

  // ======================================================================
  // Actions intelligentes (un seul appel, sortie JSON)
  // ======================================================================
  async suggestSubtasks(userId: string, taskRef: string) {
    const t = this.svc.getTask(userId, taskRef);
    const out = await this.provider.json<{ subtasks: { title: string; days_from_now: number | null }[] }>({
      system: "Tu es un chef de projet expérimenté. Tu découpes le travail en étapes concrètes, actionnables, en français.",
      prompt: `Découpe cette tâche en 3 à 7 sous-tâches concrètes, dans l'ordre. Pour chacune, propose un délai en jours à partir d'aujourd'hui (ou null).\n\nProjet : ${t.project.name}\nTâche : ${t.title}\nDescription : ${t.description || "(aucune)"}\nSous-tâches existantes : ${t.subtasks.map((s) => s.title).join(" ; ") || "(aucune)"}`,
      schema: { type: "object", properties: { subtasks: { type: "array", items: { type: "object", properties: { title: { type: "string" }, days_from_now: { type: ["integer", "null"] } }, required: ["title", "days_from_now"], additionalProperties: false } } }, required: ["subtasks"], additionalProperties: false },
      hint: { kind: "subtasks", data: { title: t.title } },
    });
    return out.subtasks.slice(0, 10).map((s) => ({ title: s.title, due_on: s.days_from_now == null ? null : addDays(s.days_from_now) }));
  }

  async projectStatus(userId: string, projectId: string) {
    const p = this.svc.getProject(userId, projectId);
    const stats = this.svc.projectStats(userId, projectId);
    const overdue = this.svc.listTasks(userId, { project_id: projectId, overdue: true }).slice(0, 15).map((t) => this.tools.brief(t));
    const recent = this.svc.projectActivity(userId, projectId, 25).map((a) => `${a.created_at.slice(0, 10)} ${this.svc.user(a.actor_id).name} ${a.kind} ${JSON.stringify(a.data).slice(0, 120)}`);
    return this.provider.json<{ status: "on_track" | "at_risk" | "off_track"; headline: string; summary: string; risks: string[]; next_steps: string[] }>({
      system: "Tu rédiges des points d'avancement de projet clairs, factuels et brefs, en français, pour une équipe et sa direction.",
      prompt: `Rédige le point d'avancement du projet à partir des données ci-dessous. Statut : on_track, at_risk ou off_track.\n\nProjet : ${p.name} — ${p.description}\nÉchéance : ${p.due_on ?? "aucune"}\nIndicateurs : ${JSON.stringify({ total: stats.total, done: stats.done, overdue: stats.overdue, due_this_week: stats.due_this_week, unassigned: stats.unassigned })}\nTâches en retard : ${JSON.stringify(overdue)}\nActivité récente :\n${recent.join("\n")}`,
      schema: { type: "object", properties: { status: { type: "string", enum: ["on_track", "at_risk", "off_track"] }, headline: { type: "string" }, summary: { type: "string" }, risks: { type: "array", items: { type: "string" } }, next_steps: { type: "array", items: { type: "string" } } }, required: ["status", "headline", "summary", "risks", "next_steps"], additionalProperties: false },
      hint: { kind: "status", data: { stats, overdue } },
    });
  }

  async parseTasks(userId: string, projectId: string, text: string) {
    const p = this.svc.getProject(userId, projectId);
    const members = p.members.map((m) => ({ id: m.user_id, name: this.svc.user(m.user_id).name }));
    const out = await this.provider.json<{ tasks: { title: string; description: string; assignee_id: string | null; due_on: string | null; priority: string; section: string | null }[] }>({
      system: "Tu transformes des notes en vrac (réunion, e-mail, liste) en tâches claires et actionnables, en français.",
      prompt: `Date du jour : ${today()}\nProjet : ${p.name}\nSections : ${p.sections.map((s) => s.name).join(", ")}\nMembres (id, nom) : ${JSON.stringify(members)}\n\nExtrais les tâches de ce texte. Titre court commençant par un verbe. assignee_id = id d'un membre seulement s'il est clairement désigné. due_on au format AAAA-MM-JJ si une date est donnée. priority parmi none, low, medium, high, urgent. section = nom exact d'une section ou null.\n\nTexte :\n${text.slice(0, 8000)}`,
      schema: { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, assignee_id: { type: ["string", "null"] }, due_on: { type: ["string", "null"] }, priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"] }, section: { type: ["string", "null"] } }, required: ["title", "description", "assignee_id", "due_on", "priority", "section"], additionalProperties: false } } }, required: ["tasks"], additionalProperties: false },
      hint: { kind: "parse", data: { text, members } },
    });
    const valid = new Set(members.map((m) => m.id));
    return out.tasks.slice(0, 30).map((t) => ({
      ...t, assignee_id: t.assignee_id && valid.has(t.assignee_id) ? t.assignee_id : null,
      section_id: p.sections.find((s) => s.name.toLowerCase() === (t.section ?? "").toLowerCase())?.id ?? null,
    }));
  }

  async improveDescription(userId: string, taskRef: string) {
    const t = this.svc.getTask(userId, taskRef);
    return this.provider.json<{ description: string }>({
      system: "Tu rédiges des descriptions de tâches nettes : objectif, contexte, critères de réussite. En français, en Markdown léger.",
      prompt: `Réécris la description de cette tâche pour qu'elle soit claire et actionnable. Garde les faits, n'invente pas de détails.\n\nProjet : ${t.project.name}\nTâche : ${t.title}\nDescription actuelle : ${t.description || "(vide)"}\nCommentaires : ${t.comments.slice(-5).map((c) => c.body).join(" | ") || "(aucun)"}`,
      schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"], additionalProperties: false },
      hint: { kind: "describe", data: { title: t.title, description: t.description } },
    });
  }

  // ======================================================================
  // Règles (AI Studio simplifié)
  // ======================================================================
  private listRulesRaw(projectId: string) {
    return all<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_rules WHERE project_id = ? ORDER BY created_at", projectId).map(toRule);
  }
  listRules(userId: string, projectId: string) {
    this.svc.require(userId, projectId);
    return this.listRulesRaw(projectId);
  }
  saveRule(userId: string, input: Partial<AiRule> & { project_id: string }) {
    this.svc.require(userId, input.project_id, "admin");
    const agent = this.svc.user(String(input.agent_id));
    if (!agent.is_ai) throw badRequest("L'agent doit être un coéquipier IA");
    if (!this.svc.role(agent.id, input.project_id)) throw badRequest(`${agent.name} n'est pas membre du projet`);
    if (!input.name?.trim() || !input.instructions?.trim()) throw badRequest("Nom et consigne obligatoires");
    if (!["task_created", "task_moved", "task_overdue"].includes(String(input.trigger))) throw badRequest("Déclencheur invalide");
    if (input.id) {
      const r = this.getRule(input.id);
      if (r.project_id !== input.project_id) throw forbidden();
      run(this.svc.db, "UPDATE ai_rules SET name=?, trigger=?, section_id=?, agent_id=?, instructions=?, auto_approve=?, enabled=? WHERE id=?",
        input.name, input.trigger, input.section_id ?? null, agent.id, input.instructions, input.auto_approve ? 1 : 0, input.enabled === false ? 0 : 1, input.id);
      return this.getRule(input.id);
    }
    const id = uid("rul");
    run(this.svc.db, "INSERT INTO ai_rules (id, project_id, name, trigger, section_id, agent_id, instructions, auto_approve, enabled, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, input.project_id, input.name, input.trigger, input.section_id ?? null, agent.id, input.instructions, input.auto_approve ? 1 : 0, input.enabled === false ? 0 : 1, userId, now());
    return this.getRule(id);
  }
  deleteRule(userId: string, ruleId: string) {
    const r = this.getRule(ruleId);
    this.svc.require(userId, r.project_id, "admin");
    run(this.svc.db, "DELETE FROM ai_rules WHERE id = ?", ruleId);
  }
  getRule(id: string) {
    const r = get<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_rules WHERE id = ?", id);
    if (!r) throw notFound("Règle introuvable");
    return toRule(r);
  }

  // ======================================================================
  // Lecture : exécutions, étapes, validations
  // ======================================================================
  getRun(id: string): AiRun {
    const r = get<AiRun>(this.svc.db, "SELECT * FROM ai_runs WHERE id = ?", id);
    if (!r) throw notFound("Exécution introuvable");
    return r;
  }
  canSeeRun(userId: string, r: AiRun) {
    if (r.kind === "assistant") return r.requested_by === userId;
    return !!(r.project_id && this.svc.role(userId, r.project_id));
  }
  runDetail(userId: string, id: string) {
    const r = this.getRun(id);
    if (!this.canSeeRun(userId, r)) throw forbidden();
    return {
      ...r,
      steps: all<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_steps WHERE run_id = ? ORDER BY seq", id).map((s) => ({ ...s, input: parse(s.input), output: parse(s.output) })) as unknown as AiStep[],
      approvals: all<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_approvals WHERE run_id = ? ORDER BY created_at", id).map(toApproval),
    };
  }
  listRuns(userId: string, f: { taskId?: string; projectId?: string; limit?: number }) {
    const where: string[] = ["kind != 'assistant'"]; const params: unknown[] = [];
    if (f.taskId) { where.push("task_id = ?"); params.push(f.taskId); }
    if (f.projectId) { where.push("project_id = ?"); params.push(f.projectId); }
    const rows = all<AiRun>(this.svc.db, `SELECT * FROM ai_runs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, ...params, f.limit ?? 50);
    return rows.filter((r) => this.canSeeRun(userId, r)).map((r) => ({
      ...r,
      step_count: get<{ n: number }>(this.svc.db, "SELECT COUNT(*) AS n FROM ai_steps WHERE run_id = ?", r.id)?.n ?? 0,
      pending_approvals: get<{ n: number }>(this.svc.db, "SELECT COUNT(*) AS n FROM ai_approvals WHERE run_id = ? AND status = 'pending'", r.id)?.n ?? 0,
    }));
  }
  pendingApprovals(userId: string) {
    return all<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_approvals WHERE status = 'pending' ORDER BY created_at DESC").map(toApproval)
      .filter((a) => { const r = this.getRun(a.run_id); return r.kind === "assistant" ? r.requested_by === userId : !!(a.project_id && ["editor", "admin"].includes(this.svc.role(userId, a.project_id) ?? "")); });
  }
  getApproval(id: string): AiApproval {
    const r = get<Record<string, unknown>>(this.svc.db, "SELECT * FROM ai_approvals WHERE id = ?", id);
    if (!r) throw notFound("Validation introuvable");
    return toApproval(r);
  }

  // ======================================================================
  // Interne
  // ======================================================================
  private step(runId: string, s: { kind: string; tool?: string; input?: unknown; output?: unknown; status: string }) {
    const id = uid("stp");
    const seq = (get<{ m: number | null }>(this.svc.db, "SELECT MAX(seq) AS m FROM ai_steps WHERE run_id = ?", runId)?.m ?? 0) + 1;
    run(this.svc.db, "INSERT INTO ai_steps (id, run_id, seq, kind, tool, input, output, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, runId, seq, s.kind, s.tool ?? null, s.input === undefined ? null : JSON.stringify(s.input), s.output === undefined ? null : trim(s.output, 6000), s.status, now());
    this.emitStep(runId);
    return id;
  }
  private updateStep(id: string, status: string, output: unknown) {
    run(this.svc.db, "UPDATE ai_steps SET status = ?, output = ? WHERE id = ?", status, trim(output, 6000), id);
    const r = get<{ run_id: string }>(this.svc.db, "SELECT run_id FROM ai_steps WHERE id = ?", id);
    if (r) this.emitStep(r.run_id);
  }
  private setStatus(runId: string, status: RunStatus) {
    run(this.svc.db, "UPDATE ai_runs SET status = ? WHERE id = ? AND status NOT IN ('done','failed','cancelled')", status, runId);
    this.emitRun(runId);
  }
  private finish(runId: string, status: RunStatus, summary: string | null) {
    run(this.svc.db, "UPDATE ai_runs SET status = ?, summary = COALESCE(?, summary), finished_at = ? WHERE id = ? AND status NOT IN ('done','failed','cancelled')", status, summary, now(), runId);
    this.emitRun(runId);
  }
  private fail(runId: string, err: unknown) {
    if (err instanceof CancelledError || (err as Error)?.name === "AbortError" || this.controllers.get(runId)?.signal.aborted) return this.finish(runId, "cancelled", null);
    const msg = err instanceof RefusalError ? err.message : describeError(err);
    run(this.svc.db, "UPDATE ai_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status NOT IN ('done','cancelled')", msg, now(), runId);
    this.emitRun(runId);
  }
  private emitRun(runId: string) {
    const r = get<AiRun>(this.svc.db, "SELECT * FROM ai_runs WHERE id = ?", runId);
    if (r) this.bus.emit({ type: "ai.run", runId, projectId: r.project_id, taskId: r.task_id, agentId: r.agent_id, status: r.status });
  }
  private emitStep(runId: string) {
    const r = get<AiRun>(this.svc.db, "SELECT * FROM ai_runs WHERE id = ?", runId);
    if (r) this.bus.emit({ type: "ai.step", runId, projectId: r.project_id, taskId: r.task_id });
  }
}

class CancelledError extends Error {}

function describeError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e?.status === 401) return "Clé API Anthropic invalide ou absente.";
  if (e?.status === 429) return "Limite de requêtes atteinte côté Claude. Réessayez dans un moment.";
  if (e?.status && e.status >= 500) return "Claude est momentanément indisponible. Réessayez.";
  return e?.message ?? String(err);
}

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const toRule = (r: Record<string, unknown>): AiRule => ({ ...(r as unknown as AiRule), auto_approve: !!r.auto_approve, enabled: !!r.enabled });
const toApproval = (r: Record<string, unknown>): AiApproval => ({ ...(r as unknown as AiApproval), input: parse(r.input) as Record<string, unknown> });

function teammateSystem(agent: User) {
  return [
    `Tu es ${agent.name}, ${agent.ai_role ?? "coéquipier IA"}. Tu fais partie de l'équipe dans Cadence, un outil de gestion de projet.`,
    "Tu travailles comme un membre de l'équipe : tu lis le graphe de travail (projets, tâches, sous-tâches, commentaires, membres) avec tes outils, avec tes propres droits d'accès, et tu agis sur les tâches.",
    agent.ai_instructions ? `Consignes permanentes de ton rôle :\n${agent.ai_instructions}` : "",
    "Méthode :",
    "- Appuie-toi uniquement sur ce que renvoient tes outils. Si un accès est refusé, dis-le, n'invente rien.",
    "- Traduis chaque besoin en filtres précis dans search_tasks plutôt que de tout lister.",
    "- Regroupe dans un même tour tous les appels d'outils indépendants (par exemple plusieurs commentaires de relance).",
    "- Chaque écriture (création, modification, commentaire) est soumise à la validation d'un humain. Si une action est refusée, n'insiste pas et adapte ton plan.",
    "- Pour mentionner quelqu'un dans un commentaire, écris @Prénom.",
    "- Utilise remember seulement pour une préférence ou une décision durable que tu viens d'apprendre.",
    "- N'écris pas de texte pendant que tu utilises les outils. Ton message final est un compte rendu en français, court, en puces, sans formule de politesse : il sera publié en commentaire sur la tâche.",
  ].filter(Boolean).join("\n");
}

function assistantSystem(user: User, projects: string, current: string | null) {
  return [
    `Tu es Cadence AI, l'assistant de ${user.name} (id ${user.id}) dans Cadence, un outil de gestion de projet.`,
    "Tu réponds aux questions sur le travail de l'équipe et tu peux agir (créer, modifier, commenter des tâches) au nom de cette personne, avec ses droits.",
    `Projets accessibles : ${projects || "aucun"}.`,
    current ? `Projet ouvert à l'écran : ${current}. Par défaut, les questions portent sur ce projet.` : "",
    `Date du jour : ${today()}.`,
    "Méthode :",
    "- Appuie-toi uniquement sur ce que renvoient tes outils ; si un accès est refusé, dis-le simplement.",
    "- Traduis la question en filtres précis pour search_tasks. Regroupe les appels indépendants dans un même tour.",
    "- Toute écriture est validée par l'utilisateur avant exécution ; si elle est refusée, n'insiste pas.",
    "- Réponds en français, de façon concise et concrète, en citant les numéros de tâches (#12). Utilise des puces quand il y a une liste.",
  ].filter(Boolean).join("\n");
}

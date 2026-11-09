import { uid } from "../db.js";
import type { Bus, DomainEvent } from "../bus.js";
import { badRequest, forbidden, notFound, today, type Services, type User } from "../services.js";
import { READ_TOOLS, WRITE_TOOLS, WRITE_TOOL_NAMES, ToolRunner, type ToolCtx } from "./tools.js";
import { RefusalError, type AgentMode, type AiProvider, type Msg, type TextBlock, type ToolResultBlock, type ToolUseBlock } from "./provider.js";

export type RunKind = "task" | "mention" | "rule" | "assistant";
export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

export interface AiRun {
  id: string; org_id: string | null; agent_id: string; kind: RunKind; task_id: string | null; project_id: string | null; requested_by: string | null;
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
const parse = (s: unknown) => { if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return s; } };

interface StartOpts {
  agentId: string; kind: RunKind; taskId?: string | null; projectId?: string | null; requestedBy?: string | null;
  ruleId?: string | null; instructions?: string; autoApprove?: boolean; commentId?: string;
}

export class AiEngine {
  readonly tools: ToolRunner;
  private waiters = new Map<string, (ok: boolean) => void>();
  private controllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  /** Exécutions en cours de traitement (pour attendre la fin proprement, notamment en test). */
  readonly pending = new Set<Promise<unknown>>();

  constructor(private svc: Services, private bus: Bus, public provider: AiProvider) {
    this.tools = new ToolRunner(svc);
  }

  /** Clôt proprement ce qu'un redémarrage a laissé en suspens. */
  async init() {
    await this.svc.db.query("UPDATE ai_approvals SET status = 'expired' WHERE status = 'pending'");
    await this.svc.db.query("UPDATE ai_runs SET status = 'failed', error = 'Interrompu par un redémarrage du serveur', finished_at = now() WHERE status IN ('queued','running','waiting_approval')");
  }

  /** Arrêt propre : interrompt les exécutions (y compris celles qui attendent une validation) puis attend leur fin. */
  async shutdown(maxMs = 3000) {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.controllers.values()) c.abort();
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, maxMs))]);
  }

  private track<T>(p: Promise<T>) { this.pending.add(p); p.finally(() => this.pending.delete(p)).catch(() => {}); return p; }

  // ======================================================================
  // Déclencheurs : assignation, @mention, règles
  // ======================================================================
  attach() {
    const off = this.bus.on((e) => { this.track(this.onEvent(e).catch((err) => console.error("[ai] déclencheur", err))); });
    this.timer = setInterval(() => { this.track(this.checkOverdueRules().catch((err) => console.error("[ai] règles", err))); }, 60_000);
    this.timer.unref?.();
    return () => { off(); if (this.timer) clearInterval(this.timer); };
  }

  private async isAi(id: string | null | undefined) {
    if (!id) return false;
    return !!(await this.svc.db.one<{ is_ai: boolean }>("SELECT is_ai FROM users WHERE id = $1", [id]))?.is_ai;
  }

  private async onEvent(e: DomainEvent) {
    if (!("actorId" in e) || (await this.isAi(e.actorId))) return; // jamais de boucle IA → IA
    if (e.type === "task.created" || (e.type === "task.updated" && e.changes.includes("assignee_id"))) {
      const t = await this.svc.db.one<{ assignee_id: string | null }>("SELECT assignee_id FROM tasks WHERE id = $1", [e.taskId]);
      if (t?.assignee_id && (await this.isAi(t.assignee_id))) {
        await this.start({ agentId: t.assignee_id, kind: "task", taskId: e.taskId, projectId: e.projectId, requestedBy: e.actorId });
      }
    }
    if (e.type === "task.created") await this.fireRules("task_created", e.projectId, e.taskId, e.actorId);
    if (e.type === "task.updated" && e.changes.includes("section_id")) await this.fireRules("task_moved", e.projectId, e.taskId, e.actorId);
    if (e.type === "comment.created") {
      for (const id of e.mentions) if (await this.isAi(id)) {
        await this.start({ agentId: id, kind: "mention", taskId: e.taskId, projectId: e.projectId, requestedBy: e.actorId, commentId: e.commentId });
      }
    }
  }

  private async fireRules(trigger: AiRule["trigger"], projectId: string, taskId: string, actorId: string) {
    const task = await this.svc.db.one<{ section_id: string | null; parent_id: string | null }>("SELECT section_id, parent_id FROM tasks WHERE id = $1", [taskId]);
    if (!task || task.parent_id) return;
    for (const r of (await this.listRulesRaw(projectId)).filter((x) => x.enabled && x.trigger === trigger)) {
      if (r.section_id && r.section_id !== task.section_id) continue;
      await this.start({ agentId: r.agent_id, kind: "rule", ruleId: r.id, taskId, projectId, requestedBy: actorId, instructions: r.instructions, autoApprove: r.auto_approve });
    }
  }

  async checkOverdueRules() {
    for (const r of await this.svc.db.query<AiRule>("SELECT * FROM ai_rules WHERE enabled AND trigger = 'task_overdue'")) {
      const tasks = await this.svc.db.query<{ id: string }>(
        `SELECT t.id FROM tasks t WHERE t.project_id = $1 AND NOT t.completed AND t.parent_id IS NULL AND t.due_on IS NOT NULL AND t.due_on < $2::date
         AND NOT EXISTS (SELECT 1 FROM ai_runs a WHERE a.rule_id = $3 AND a.task_id = t.id) LIMIT 5`, [r.project_id, today(), r.id]);
      for (const t of tasks) await this.start({ agentId: r.agent_id, kind: "rule", ruleId: r.id, taskId: t.id, projectId: r.project_id, requestedBy: r.created_by, instructions: r.instructions, autoApprove: r.auto_approve });
    }
  }

  // ======================================================================
  // Exécutions
  // ======================================================================
  async start(o: StartOpts): Promise<string | null> {
    if (o.taskId && o.kind !== "assistant") {
      const active = await this.svc.db.one("SELECT id FROM ai_runs WHERE agent_id = $1 AND task_id = $2 AND status IN ('queued','running','waiting_approval')", [o.agentId, o.taskId]);
      if (active) return null;
    }
    const orgId = o.projectId ? await this.svc.orgOfProject(o.projectId) : null;
    const id = uid("run");
    await this.svc.db.query(`INSERT INTO ai_runs (id, org_id, agent_id, kind, task_id, project_id, requested_by, rule_id, status, provider)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9)`, [id, orgId, o.agentId, o.kind, o.taskId ?? null, o.projectId ?? null, o.requestedBy ?? null, o.ruleId ?? null, this.provider.name]);
    await this.emitRun(id);
    setImmediate(() => { this.track(this.execute(id, o, orgId!).catch((err) => console.error("[ai] exécution", err))); });
    return id;
  }

  /** Assistant conversationnel : agit avec les droits de l'utilisateur, dans l'organisation active. */
  async startAssistant(userId: string, orgId: string, history: { role: "user" | "assistant"; content: string }[], projectId: string | null): Promise<string> {
    if (!history.length || history[history.length - 1].role !== "user") throw badRequest("La conversation doit se terminer par un message de l'utilisateur");
    await this.svc.requireOrg(userId, orgId);
    if (projectId) { await this.svc.require(userId, projectId); if ((await this.svc.orgOfProject(projectId)) !== orgId) throw badRequest("Projet hors de l'organisation active"); }
    const id = uid("run");
    await this.svc.db.query(`INSERT INTO ai_runs (id, org_id, agent_id, kind, project_id, requested_by, status, provider) VALUES ($1,$2,'ai_cadence','assistant',$3,$4,'queued',$5)`,
      [id, orgId, projectId, userId, this.provider.name]);
    await this.emitRun(id);
    setImmediate(() => { this.track(this.executeAssistant(id, userId, orgId, history.slice(-20), projectId).catch((err) => console.error("[ai] assistant", err))); });
    return id;
  }

  private async execute(runId: string, o: StartOpts, orgId: string) {
    const agent = await this.svc.user(o.agentId);
    const ctl = new AbortController();
    this.controllers.set(runId, ctl);
    await this.setStatus(runId, "running");
    const ctx: ToolCtx = { actorId: agent.id, orgId };
    try {
      if (!o.taskId || !o.projectId) throw new Error("Aucune tâche associée");
      let task;
      try { task = await this.tools.execute(ctx, "get_task", { task: o.taskId }); }
      catch (e) { throw new Error(`${agent.name} n'a pas accès à cette tâche : ${(e as Error).message}`); }
      const project = await this.tools.execute(ctx, "get_project", { project_id: o.projectId });
      const memories = await this.tools.memories(agent.id, o.projectId, o.taskId);
      const comment = o.commentId ? await this.svc.db.one<{ body: string; author_id: string }>("SELECT body, author_id FROM comments WHERE id = $1", [o.commentId]) : null;
      const requester = o.requestedBy ? await this.svc.userOrNull(o.requestedBy) : null;
      const context = [
        `Date du jour : ${today()}`,
        requester ? `Demandé par : ${requester.name} (${requester.id})` : "",
        `Projet :\n${JSON.stringify(project)}`,
        `Tâche :\n${JSON.stringify(task)}`,
        memories.length ? `Ce dont tu te souviens sur ce projet :\n- ${memories.join("\n- ")}` : "",
        o.instructions ? `Consigne de la règle qui t'a déclenché :\n${o.instructions}` : "",
        comment ? `${(await this.svc.user(comment.author_id)).name} t'a mentionné dans ce commentaire :\n« ${comment.body} »` : "",
        "",
        o.kind === "mention" ? "Réponds à ce commentaire. Si on te demande une action, fais-la avec tes outils." :
          o.kind === "rule" ? "Applique la consigne de la règle à cette tâche." : "Cette tâche t'est assignée : réalise-la.",
      ].filter(Boolean).join("\n\n");
      const mode: AgentMode = o.kind === "mention" ? "mention" : "teammate";
      const text = await this.loop(runId, {
        system: teammateSystem(agent), ctx, approverIds: await this.approvers(o, agent.id), autoApprove: !!o.autoApprove,
        messages: [{ role: "user", content: context }], signal: ctl.signal,
        hint: { mode, actorId: agent.id, projectId: o.projectId, taskId: o.taskId, requesterId: o.requestedBy },
      });
      if (text.trim()) await this.svc.addComment(agent.id, o.taskId, text, runId);
      await this.finish(runId, "done", text);
    } catch (err) {
      await this.fail(runId, err);
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async executeAssistant(runId: string, userId: string, orgId: string, history: { role: "user" | "assistant"; content: string }[], projectId: string | null) {
    const ctl = new AbortController();
    this.controllers.set(runId, ctl);
    await this.setStatus(runId, "running");
    try {
      const user = await this.svc.user(userId);
      const projects = (await this.svc.listProjects(userId, orgId)).map((p) => `${p.name} (clé ${p.key})`).join(", ");
      const current = projectId ? await this.svc.getProject(userId, projectId) : null;
      const system = assistantSystem(user, projects, current ? `${current.name} (clé ${current.key})` : null);
      const text = await this.loop(runId, {
        system, ctx: { actorId: userId, orgId }, approverIds: [userId], autoApprove: false,
        messages: history.map((m) => ({ role: m.role, content: m.content }) as Msg), signal: ctl.signal,
        hint: { mode: "assistant", actorId: userId, projectId, requesterId: userId },
        onText: (delta) => this.bus.emit({ type: "ai.delta", runId, userId, delta }),
      });
      await this.finish(runId, "done", text);
    } catch (err) {
      await this.fail(runId, err);
    } finally {
      this.controllers.delete(runId);
    }
  }

  /** Boucle agent : le modèle appelle des outils ; chaque écriture passe par un checkpoint. */
  private async loop(runId: string, o: {
    system: string; ctx: ToolCtx; approverIds: string[]; autoApprove: boolean; messages: Msg[];
    signal: AbortSignal; hint: Parameters<AiProvider["turn"]>[0]["hint"]; onText?: (d: string) => void;
  }): Promise<string> {
    const messages = o.messages;
    const tools = [...READ_TOOLS, ...WRITE_TOOLS];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (o.signal.aborted) throw new CancelledError();
      const res = await this.provider.turn({ system: o.system, messages, tools, signal: o.signal, hint: o.hint, onText: o.onText });
      messages.push({ role: "assistant", content: res.content });
      const text = res.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (res.stop_reason === "pause_turn") continue;
      if (res.stop_reason !== "tool_use") return text;
      if (text) await this.step(runId, { kind: "thought", output: text, status: "ok" });

      const results: ToolResultBlock[] = [];
      for (const b of res.content.filter((x): x is ToolUseBlock => x.type === "tool_use")) {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const stepId = await this.step(runId, { kind: "tool", tool: b.name, input, status: "running" });
        if (WRITE_TOOL_NAMES.has(b.name) && !o.autoApprove) {
          const decision = await this.checkpoint(runId, o.ctx, o.approverIds, b.name, input, o.hint.projectId ?? null, o.hint.taskId ?? null, o.signal);
          if (!decision.ok) {
            await this.updateStep(stepId, "rejected", "Refusé par un humain");
            results.push({ type: "tool_result", tool_use_id: b.id, content: "Refusé : un humain a refusé cette action au checkpoint. Ne la refais pas, adapte-toi." });
            continue;
          }
          Object.assign(input, decision.input);
        }
        try {
          const out = await this.tools.execute(o.ctx, b.name, b.name === "add_comment" ? { ...input, __run_id: runId } : input);
          await this.updateStep(stepId, "ok", out);
          results.push({ type: "tool_result", tool_use_id: b.id, content: trim(out) });
        } catch (err) {
          const msg = (err as Error).message;
          await this.updateStep(stepId, "error", msg);
          results.push({ type: "tool_result", tool_use_id: b.id, content: `Erreur : ${msg}`, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return "J'ai atteint le nombre maximal d'étapes ; voici où j'en suis.";
  }

  private async approvers(o: StartOpts, agentId: string): Promise<string[]> {
    const ids = new Set<string>();
    if (o.requestedBy && !(await this.isAi(o.requestedBy))) ids.add(o.requestedBy);
    if (o.projectId) for (const m of await this.svc.members(o.projectId)) if (m.role === "admin" && !(await this.isAi(m.user_id))) ids.add(m.user_id);
    if (o.taskId) {
      const t = await this.svc.db.one<{ creator_id: string | null }>("SELECT creator_id FROM tasks WHERE id = $1", [o.taskId]);
      if (t?.creator_id && !(await this.isAi(t.creator_id))) ids.add(t.creator_id);
    }
    ids.delete(agentId);
    return [...ids];
  }

  private async checkpoint(runId: string, ctx: ToolCtx, approverIds: string[], tool: string, input: Record<string, unknown>, projectId: string | null, taskId: string | null, signal: AbortSignal): Promise<{ ok: boolean; input: Record<string, unknown> }> {
    const id = uid("apr");
    const summary = await this.tools.describe(ctx, tool, input);
    await this.svc.db.query(`INSERT INTO ai_approvals (id, run_id, agent_id, task_id, project_id, tool, input, summary, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [id, runId, ctx.actorId, taskId, projectId, tool, JSON.stringify(input), summary]);
    await this.setStatus(runId, "waiting_approval");
    const agent = await this.svc.user(ctx.actorId);
    const run = await this.getRun(runId);
    if (run.kind !== "assistant") {
      for (const u of approverIds) await this.svc.notify(u, ctx.orgId, { kind: "approval", title: `${agent.name} attend votre accord`, body: summary, task_id: taskId, project_id: projectId, approval_id: id, actor_id: ctx.actorId });
    }
    this.bus.emit({ type: "ai.approval", approvalId: id, runId, projectId, taskId });
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiters.delete(id);
        void this.svc.db.query("UPDATE ai_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'", [id]).finally(() => resolve({ ok: false, input }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // La personne qui valide peut avoir retouché l'action : on relit l'input enregistré.
      this.waiters.set(id, (ok) => {
        signal.removeEventListener("abort", onAbort);
        void (async () => { await this.setStatus(runId, "running"); resolve({ ok, input: (await this.getApproval(id)).input }); })();
      });
    });
  }

  async decide(approvalId: string, userId: string, approve: boolean, edits?: Record<string, unknown>) {
    const a = await this.getApproval(approvalId);
    if (a.status !== "pending") throw badRequest("Cette demande a déjà été traitée");
    const run = await this.getRun(a.run_id);
    if (run.kind === "assistant") { if (run.requested_by !== userId) throw forbidden("Seule la personne qui a lancé l'assistant peut valider"); }
    else if (a.project_id) await this.svc.require(userId, a.project_id, "editor");
    if (edits && approve) {
      const input = { ...a.input, ...edits };
      await this.svc.db.query("UPDATE ai_approvals SET input = $1, summary = $2 WHERE id = $3",
        [JSON.stringify(input), await this.tools.describe({ actorId: a.agent_id, orgId: run.org_id ?? "" }, a.tool, input), approvalId]);
    }
    await this.svc.db.query("UPDATE ai_approvals SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3", [approve ? "approved" : "rejected", userId, approvalId]);
    await this.svc.db.query("UPDATE notifications SET read = TRUE WHERE approval_id = $1", [approvalId]);
    await this.svc.log(userId, approve ? "ai.approved" : "ai.rejected", { orgId: run.org_id, projectId: a.project_id, taskId: a.task_id, data: { summary: a.summary, agent: a.agent_id } });
    const w = this.waiters.get(approvalId);
    this.waiters.delete(approvalId);
    this.bus.emit({ type: "ai.approval", approvalId, runId: a.run_id, projectId: a.project_id, taskId: a.task_id });
    if (w) w(approve);
    else await this.svc.db.query("UPDATE ai_approvals SET status = 'expired' WHERE id = $1", [approvalId]);
    return this.getApproval(approvalId);
  }

  async cancel(runId: string, userId: string) {
    const r = await this.getRun(runId);
    if (r.requested_by !== userId && r.project_id) await this.svc.require(userId, r.project_id, "editor");
    else if (r.requested_by !== userId) throw forbidden();
    this.controllers.get(runId)?.abort();
    if (["queued", "running", "waiting_approval"].includes(r.status)) await this.finish(runId, "cancelled", null);
  }

  // ======================================================================
  // Actions intelligentes (un seul appel, sortie JSON)
  // ======================================================================
  async suggestSubtasks(userId: string, taskRef: string) {
    const t = await this.svc.getTask(userId, taskRef);
    const out = await this.provider.json<{ subtasks: { title: string; days_from_now: number | null }[] }>({
      system: "Tu es un chef de projet expérimenté. Tu découpes le travail en étapes concrètes, actionnables, en français.",
      prompt: `Découpe cette tâche en 3 à 7 sous-tâches concrètes, dans l'ordre. Pour chacune, propose un délai en jours à partir d'aujourd'hui (ou null).\n\nProjet : ${t.project.name}\nTâche : ${t.title}\nDescription : ${t.description || "(aucune)"}\nSous-tâches existantes : ${t.subtasks.map((s) => s.title).join(" ; ") || "(aucune)"}`,
      schema: { type: "object", properties: { subtasks: { type: "array", items: { type: "object", properties: { title: { type: "string" }, days_from_now: { type: ["integer", "null"] } }, required: ["title", "days_from_now"], additionalProperties: false } } }, required: ["subtasks"], additionalProperties: false },
      hint: { kind: "subtasks", data: { title: t.title } },
    });
    return out.subtasks.slice(0, 10).map((s) => ({ title: s.title, due_on: s.days_from_now == null ? null : addDays(s.days_from_now) }));
  }

  async projectStatus(userId: string, projectId: string) {
    const p = await this.svc.getProject(userId, projectId);
    const stats = await this.svc.projectStats(userId, projectId);
    const overdue = []; for (const t of (await this.svc.listTasks(userId, { project_id: projectId, overdue: true })).slice(0, 15)) overdue.push(await this.tools.brief(t));
    const recent = [];
    for (const a of await this.svc.projectActivity(userId, projectId, 25)) recent.push(`${a.created_at.slice(0, 10)} ${(await this.svc.userOrNull(a.actor_id))?.name ?? "?"} ${a.kind} ${JSON.stringify(a.data).slice(0, 120)}`);
    return this.provider.json<{ status: "on_track" | "at_risk" | "off_track"; headline: string; summary: string; risks: string[]; next_steps: string[] }>({
      system: "Tu rédiges des points d'avancement de projet clairs, factuels et brefs, en français, pour une équipe et sa direction.",
      prompt: `Rédige le point d'avancement du projet à partir des données ci-dessous. Statut : on_track, at_risk ou off_track.\n\nProjet : ${p.name} — ${p.description}\nÉchéance : ${p.due_on ?? "aucune"}\nIndicateurs : ${JSON.stringify({ total: stats.total, done: stats.done, overdue: stats.overdue, due_this_week: stats.due_this_week, unassigned: stats.unassigned })}\nTâches en retard : ${JSON.stringify(overdue)}\nActivité récente :\n${recent.join("\n")}`,
      schema: { type: "object", properties: { status: { type: "string", enum: ["on_track", "at_risk", "off_track"] }, headline: { type: "string" }, summary: { type: "string" }, risks: { type: "array", items: { type: "string" } }, next_steps: { type: "array", items: { type: "string" } } }, required: ["status", "headline", "summary", "risks", "next_steps"], additionalProperties: false },
      hint: { kind: "status", data: { stats, overdue } },
    });
  }

  async parseTasks(userId: string, projectId: string, text: string) {
    const p = await this.svc.getProject(userId, projectId);
    const members = []; for (const m of p.members) members.push({ id: m.user_id, name: (await this.svc.user(m.user_id)).name });
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
    const t = await this.svc.getTask(userId, taskRef);
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
  private async listRulesRaw(projectId: string) {
    return this.svc.db.query<AiRule>("SELECT * FROM ai_rules WHERE project_id = $1 ORDER BY created_at", [projectId]);
  }
  async listRules(userId: string, projectId: string) {
    await this.svc.require(userId, projectId);
    return this.listRulesRaw(projectId);
  }
  async saveRule(userId: string, input: Partial<AiRule> & { project_id: string }) {
    await this.svc.require(userId, input.project_id, "admin");
    const agent = await this.svc.user(String(input.agent_id));
    if (!agent.is_ai) throw badRequest("L'agent doit être un coéquipier IA");
    if (!(await this.svc.projectRole(agent.id, input.project_id))) throw badRequest(`${agent.name} n'a pas accès au projet`);
    if (!input.name?.trim() || !input.instructions?.trim()) throw badRequest("Nom et consigne obligatoires");
    if (!["task_created", "task_moved", "task_overdue"].includes(String(input.trigger))) throw badRequest("Déclencheur invalide");
    if (input.id) {
      const r = await this.getRule(input.id);
      if (r.project_id !== input.project_id) throw forbidden();
      await this.svc.db.query("UPDATE ai_rules SET name=$1, trigger=$2, section_id=$3, agent_id=$4, instructions=$5, auto_approve=$6, enabled=$7 WHERE id=$8",
        [input.name, input.trigger, input.section_id ?? null, agent.id, input.instructions, !!input.auto_approve, input.enabled !== false, input.id]);
      return this.getRule(input.id);
    }
    const id = uid("rul");
    await this.svc.db.query("INSERT INTO ai_rules (id, project_id, name, trigger, section_id, agent_id, instructions, auto_approve, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, input.project_id, input.name, input.trigger, input.section_id ?? null, agent.id, input.instructions, !!input.auto_approve, input.enabled !== false, userId]);
    return this.getRule(id);
  }
  async deleteRule(userId: string, ruleId: string) {
    const r = await this.getRule(ruleId);
    await this.svc.require(userId, r.project_id, "admin");
    await this.svc.db.query("DELETE FROM ai_rules WHERE id = $1", [ruleId]);
  }
  async getRule(id: string) {
    const r = await this.svc.db.one<AiRule>("SELECT * FROM ai_rules WHERE id = $1", [id]);
    if (!r) throw notFound("Règle introuvable");
    return r;
  }

  // ======================================================================
  // Lecture : exécutions, étapes, validations
  // ======================================================================
  async getRun(id: string): Promise<AiRun> {
    const r = await this.svc.db.one<AiRun>("SELECT * FROM ai_runs WHERE id = $1", [id]);
    if (!r) throw notFound("Exécution introuvable");
    return r;
  }
  async canSeeRun(userId: string, r: AiRun) {
    if (r.kind === "assistant") return r.requested_by === userId;
    return !!(r.project_id && (await this.svc.projectRole(userId, r.project_id)));
  }
  async runDetail(userId: string, id: string) {
    const r = await this.getRun(id);
    if (!(await this.canSeeRun(userId, r))) throw forbidden();
    return {
      ...r,
      steps: (await this.svc.db.query<AiStep>("SELECT * FROM ai_steps WHERE run_id = $1 ORDER BY seq", [id])).map((s) => ({ ...s, output: parse(s.output) })),
      approvals: await this.svc.db.query<AiApproval>("SELECT * FROM ai_approvals WHERE run_id = $1 ORDER BY created_at", [id]),
    };
  }
  async listRuns(userId: string, f: { orgId: string; taskId?: string; projectId?: string; limit?: number }) {
    const where = ["kind <> 'assistant'", "org_id = $1"]; const params: unknown[] = [f.orgId];
    if (f.taskId) { params.push(f.taskId); where.push(`task_id = $${params.length}`); }
    if (f.projectId) { params.push(f.projectId); where.push(`project_id = $${params.length}`); }
    params.push(f.limit ?? 50);
    const rows = await this.svc.db.query<AiRun & { step_count: number; pending_approvals: number }>(`SELECT r.*,
        (SELECT count(*)::int FROM ai_steps s WHERE s.run_id = r.id) AS step_count,
        (SELECT count(*)::int FROM ai_approvals a WHERE a.run_id = r.id AND a.status = 'pending') AS pending_approvals
      FROM ai_runs r WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    const readable = new Set(await this.svc.readableProjectIds(userId, f.orgId, true));
    return rows.filter((r) => r.project_id && readable.has(r.project_id));
  }
  async pendingApprovals(userId: string, orgId: string) {
    const rows = await this.svc.db.query<AiApproval & { kind: string; requested_by: string | null }>(`SELECT a.*, r.kind, r.requested_by FROM ai_approvals a JOIN ai_runs r ON r.id = a.run_id
      WHERE a.status = 'pending' AND r.org_id = $1 ORDER BY a.created_at DESC`, [orgId]);
    const out: AiApproval[] = [];
    for (const a of rows) {
      if (a.kind === "assistant" ? a.requested_by === userId : a.project_id && ["editor", "admin"].includes((await this.svc.projectRole(userId, a.project_id)) ?? "")) {
        const { kind: _k, requested_by: _r, ...rest } = a; void _k; void _r; out.push(rest);
      }
    }
    return out;
  }
  async getApproval(id: string): Promise<AiApproval> {
    const r = await this.svc.db.one<AiApproval>("SELECT * FROM ai_approvals WHERE id = $1", [id]);
    if (!r) throw notFound("Validation introuvable");
    return r;
  }

  // ======================================================================
  // Interne
  // ======================================================================
  private async step(runId: string, s: { kind: string; tool?: string; input?: unknown; output?: unknown; status: string }) {
    const id = uid("stp");
    await this.svc.db.query(`INSERT INTO ai_steps (id, run_id, seq, kind, tool, input, output, status)
      VALUES ($1,$2,(SELECT coalesce(max(seq),0)+1 FROM ai_steps WHERE run_id = $2),$3,$4,$5,$6,$7)`,
      [id, runId, s.kind, s.tool ?? null, s.input === undefined ? null : JSON.stringify(s.input), s.output === undefined ? null : trim(s.output, 6000), s.status]);
    await this.emitStep(runId);
    return id;
  }
  private async updateStep(id: string, status: string, output: unknown) {
    const r = await this.svc.db.one<{ run_id: string }>("UPDATE ai_steps SET status = $1, output = $2 WHERE id = $3 RETURNING run_id", [status, trim(output, 6000), id]);
    if (r) await this.emitStep(r.run_id);
  }
  private async setStatus(runId: string, status: RunStatus) {
    await this.svc.db.query("UPDATE ai_runs SET status = $1 WHERE id = $2 AND status NOT IN ('done','failed','cancelled')", [status, runId]);
    await this.emitRun(runId);
  }
  private async finish(runId: string, status: RunStatus, summary: string | null) {
    await this.svc.db.query("UPDATE ai_runs SET status = $1, summary = coalesce($2, summary), finished_at = now() WHERE id = $3 AND status NOT IN ('done','failed','cancelled')", [status, summary, runId]);
    await this.emitRun(runId);
  }
  private async fail(runId: string, err: unknown) {
    if (err instanceof CancelledError || (err as Error)?.name === "AbortError" || this.controllers.get(runId)?.signal.aborted) return this.finish(runId, "cancelled", null);
    const msg = err instanceof RefusalError ? err.message : describeError(err);
    await this.svc.db.query("UPDATE ai_runs SET status = 'failed', error = $1, finished_at = now() WHERE id = $2 AND status NOT IN ('done','cancelled')", [msg, runId]);
    await this.emitRun(runId);
  }
  private async emitRun(runId: string) {
    const r = await this.svc.db.one<AiRun>("SELECT * FROM ai_runs WHERE id = $1", [runId]);
    if (r) this.bus.emit({ type: "ai.run", runId, projectId: r.project_id, taskId: r.task_id, agentId: r.agent_id, status: r.status });
  }
  private async emitStep(runId: string) {
    const r = await this.svc.db.one<AiRun>("SELECT * FROM ai_runs WHERE id = $1", [runId]);
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

function teammateSystem(agent: User) {
  return [
    `Tu es ${agent.name}, ${agent.ai_role ?? "coéquipier IA"}. Tu fais partie de l'équipe dans Cadence, un outil de gestion de projet.`,
    "Tu travailles comme un membre de l'équipe : tu lis le graphe de travail (projets, tâches, sous-tâches, commentaires, membres) avec tes outils, avec tes propres droits d'accès, et tu agis sur les tâches.",
    agent.ai_instructions ? `Consignes permanentes de ton rôle :\n${agent.ai_instructions}` : "",
    "Méthode :",
    "- Appuie-toi uniquement sur ce que renvoient tes outils. Si un accès est refusé, dis-le, n'invente rien.",
    "- Désigne les tâches par leur clé (par exemple APP-12) et les projets par leur clé (APP).",
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
    "Tu réponds aux questions sur le travail de l'équipe et tu peux agir (créer, modifier, commenter des tâches) au nom de cette personne, avec ses droits, dans son organisation active.",
    `Projets accessibles : ${projects || "aucun"}.`,
    current ? `Projet ouvert à l'écran : ${current}. Par défaut, les questions portent sur ce projet.` : "",
    `Date du jour : ${today()}.`,
    "Méthode :",
    "- Appuie-toi uniquement sur ce que renvoient tes outils ; si un accès est refusé, dis-le simplement.",
    "- Traduis la question en filtres précis pour search_tasks. Regroupe les appels indépendants dans un même tour.",
    "- Toute écriture est validée par l'utilisateur avant exécution ; si elle est refusée, n'insiste pas.",
    "- Réponds en français, de façon concise et concrète, en citant les clés des tâches (APP-12). Utilise des puces quand il y a une liste.",
  ].filter(Boolean).join("\n");
}

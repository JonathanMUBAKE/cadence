import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { z } from "zod";
import { openDb, get, all, type DB } from "./db.js";
import { Bus, type DomainEvent } from "./bus.js";
import { HttpError, Services, forbidden } from "./services.js";
import { AiEngine } from "./ai/engine.js";
import { AnthropicProvider, MODEL, type AiProvider } from "./ai/provider.js";
import { DemoProvider } from "./ai/demo.js";
import { seedIfEmpty } from "./seed.js";

export interface AppOptions { dbPath?: string; provider?: AiProvider | "auto" | "demo"; webDist?: string; seed?: boolean; demoDelayMs?: number; logger?: boolean }

declare module "fastify" { interface FastifyRequest { userId: string } }

const COOKIE = "cadence_uid";

export async function buildApp(opts: AppOptions = {}) {
  const db: DB = openDb(opts.dbPath ?? ":memory:");
  const bus = new Bus();
  const svc = new Services(db, bus);
  if (opts.seed !== false) seedIfEmpty(svc);
  const provider: AiProvider = typeof opts.provider === "object" ? opts.provider
    : opts.provider === "demo" || !process.env.ANTHROPIC_API_KEY ? new DemoProvider(svc, opts.demoDelayMs) : new AnthropicProvider();
  const ai = new AiEngine(svc, bus, provider);
  const detach = ai.attach();

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cookie, { secret: process.env.COOKIE_SECRET || "cadence-dev-secret-change-me" });
  app.addHook("onClose", async () => { detach(); db.close(); });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "Requête invalide", details: err.issues });
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.status(500).send({ error: "Erreur interne" });
  });

  // ------------------------------------------------------------------ authentification (espace de démo)
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.cookies[COOKIE];
    const un = raw ? req.unsignCookie(raw) : null;
    const id = un?.valid ? un.value : null;
    if (!id || !get(db, "SELECT id FROM users WHERE id = ? AND is_ai = 0", id)) return reply.status(401).send({ error: "Non connecté" });
    req.userId = id;
  };

  app.post("/api/auth/login", async (req, reply) => {
    const { user_id } = z.object({ user_id: z.string() }).parse(req.body);
    const u = svc.user(user_id);
    if (u.is_ai) throw forbidden("Un coéquipier IA ne peut pas se connecter");
    reply.setCookie(COOKIE, u.id, { path: "/", httpOnly: true, sameSite: "lax", signed: true, maxAge: 60 * 60 * 24 * 30 });
    return u;
  });
  app.post("/api/auth/logout", async (_req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });
  app.get("/api/auth/users", async () => svc.listUsers().filter((u) => !u.is_ai));

  // Toutes les autres routes /api sont authentifiées
  app.register(async (r) => {
    r.addHook("preHandler", auth);
    const me = (req: FastifyRequest) => req.userId;
    const Priority = z.enum(["none", "low", "medium", "high", "urgent"]);
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

    r.get("/api/me", async (req) => svc.user(me(req)));
    r.get("/api/users", async () => svc.listUsers());

    // ---------------------------------------------------------------- projets
    r.get("/api/projects", async (req) => svc.listProjects(me(req), { archived: (req.query as { archived?: string }).archived === "true" }));
    r.post("/api/projects", async (req) => svc.createProject(me(req), z.object({
      name: z.string().min(1).max(120), description: z.string().max(5000).optional(), color: z.string().optional(), icon: z.string().optional(), due_on: date.optional(),
    }).parse(req.body)));
    r.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => svc.getProject(me(req), req.params.id));
    r.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => svc.updateProject(me(req), req.params.id, z.object({
      name: z.string().min(1).max(120).optional(), description: z.string().max(5000).optional(), color: z.string().optional(), icon: z.string().optional(),
      status: z.enum(["on_track", "at_risk", "off_track", "done"]).optional(), due_on: date.optional(), archived: z.boolean().optional(),
    }).parse(req.body)));
    r.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => { svc.deleteProject(me(req), req.params.id, z.object({ confirm: z.string() }).parse(req.body ?? {}).confirm); return { ok: true }; });
    r.put<{ Params: { id: string; userId: string } }>("/api/projects/:id/members/:userId", async (req) =>
      svc.setMember(me(req), req.params.id, req.params.userId, z.object({ role: z.enum(["viewer", "commenter", "editor", "admin"]).nullable() }).parse(req.body).role));
    r.get<{ Params: { id: string } }>("/api/projects/:id/tasks", async (req) => svc.listTasks(me(req), { project_id: req.params.id }));
    r.get<{ Params: { id: string } }>("/api/projects/:id/stats", async (req) => svc.projectStats(me(req), req.params.id));
    r.get<{ Params: { id: string } }>("/api/projects/:id/activity", async (req) => svc.projectActivity(me(req), req.params.id, 60));
    r.get<{ Params: { id: string } }>("/api/projects/:id/updates", async (req) => {
      svc.require(me(req), req.params.id);
      return all<Record<string, unknown>>(db, "SELECT * FROM activity WHERE project_id = ? AND kind = 'project.update' ORDER BY created_at DESC LIMIT 20", req.params.id)
        .map((a) => ({ ...a, data: JSON.parse(String(a.data)) }));
    });
    r.post<{ Params: { id: string } }>("/api/projects/:id/updates", async (req) => {
      const body = z.object({ status: z.enum(["on_track", "at_risk", "off_track"]), headline: z.string().min(1), summary: z.string(), risks: z.array(z.string()), next_steps: z.array(z.string()), ai: z.boolean().optional() }).parse(req.body);
      svc.updateProject(me(req), req.params.id, { status: body.status });
      svc.log(me(req), "project.update", { projectId: req.params.id, data: body });
      for (const m of svc.members(req.params.id)) if (m.user_id !== me(req) && !svc.user(m.user_id).is_ai)
        svc.notify(m.user_id, { kind: "project.update", title: `Nouveau point d'avancement : ${body.headline}`, body: body.summary, project_id: req.params.id, actor_id: me(req) });
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>("/api/projects/:id/sections", async (req) => svc.createSection(me(req), req.params.id, z.object({ name: z.string().max(80) }).parse(req.body).name));
    r.patch<{ Params: { id: string } }>("/api/sections/:id", async (req) => svc.updateSection(me(req), req.params.id, z.object({ name: z.string().max(80).optional(), position: z.number().optional() }).parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/sections/:id/move", async (req) => svc.moveSection(me(req), req.params.id, z.object({ direction: z.enum(["left", "right"]) }).parse(req.body).direction));
    r.delete<{ Params: { id: string } }>("/api/sections/:id", async (req) => { svc.deleteSection(me(req), req.params.id); return { ok: true }; });

    // ---------------------------------------------------------------- tâches
    const TaskBody = z.object({
      project_id: z.string(), title: z.string().min(1).max(300), description: z.string().max(20000).optional(), section_id: z.string().nullable().optional(),
      parent_id: z.string().nullable().optional(), assignee_id: z.string().nullable().optional(), priority: Priority.optional(),
      start_on: date.optional(), due_on: date.optional(), tags: z.array(z.string().max(40)).max(12).optional(),
    });
    r.get("/api/tasks", async (req) => {
      const q = z.object({ assignee: z.string().optional(), completed: z.enum(["true", "false"]).optional(), project_id: z.string().optional(), overdue: z.enum(["true"]).optional(), subtasks: z.enum(["true"]).optional() }).parse(req.query);
      return svc.listTasks(me(req), {
        assignee_id: q.assignee === "me" ? me(req) : q.assignee, completed: q.completed === undefined ? undefined : q.completed === "true",
        project_id: q.project_id, overdue: q.overdue === "true", include_subtasks: q.subtasks === "true",
      });
    });
    r.post("/api/tasks", async (req) => svc.createTask(me(req), TaskBody.parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/projects/:id/tasks/bulk", async (req) => {
      const { tasks } = z.object({ tasks: z.array(TaskBody.omit({ project_id: true })).min(1).max(50) }).parse(req.body);
      return tasks.map((t) => svc.createTask(me(req), { ...t, project_id: req.params.id }));
    });
    r.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) => svc.getTask(me(req), req.params.id));
    r.patch<{ Params: { id: string } }>("/api/tasks/:id", async (req) => svc.updateTask(me(req), req.params.id, TaskBody.omit({ project_id: true, parent_id: true }).partial().extend({ completed: z.boolean().optional() }).parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/move", async (req) => svc.moveTask(me(req), req.params.id, z.object({ section_id: z.string(), before_id: z.string().nullable().optional(), after_id: z.string().nullable().optional() }).parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/duplicate", async (req) => svc.duplicateTask(me(req), req.params.id, z.object({ subtasks: z.boolean().optional() }).parse(req.body ?? {})));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/move-project", async (req) => svc.moveTaskToProject(me(req), req.params.id, z.object({ project_id: z.string() }).parse(req.body).project_id));
    r.patch<{ Params: { id: string } }>("/api/comments/:id", async (req) => svc.updateComment(me(req), req.params.id, z.object({ body: z.string().min(1).max(10000) }).parse(req.body).body));
    r.delete<{ Params: { id: string } }>("/api/comments/:id", async (req) => { svc.deleteComment(me(req), req.params.id); return { ok: true }; });
    r.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req) => { svc.deleteTask(me(req), req.params.id); return { ok: true }; });
    r.post<{ Params: { id: string } }>("/api/tasks/:id/comments", async (req) => svc.addComment(me(req), req.params.id, z.object({ body: z.string().min(1).max(10000) }).parse(req.body).body));

    // ---------------------------------------------------------------- boîte de réception & recherche
    r.get("/api/notifications", async (req) => svc.listNotifications(me(req)));
    r.post("/api/notifications/read", async (req) => { const b = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }).parse(req.body); svc.markRead(me(req), b.all ? "all" : b.ids ?? []); return { ok: true }; });
    r.get("/api/search", async (req) => svc.search(me(req), z.object({ q: z.string().default("") }).parse(req.query).q));

    // ---------------------------------------------------------------- IA
    r.get("/api/ai/status", async () => ({ provider: provider.name, model: provider.name === "anthropic" ? MODEL : null }));
    r.get("/api/ai/agents", async () => svc.agents().filter((a) => a.id !== "ai_cadence"));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/ai/run", async (req) => {
      const { agent_id, instructions } = z.object({ agent_id: z.string(), instructions: z.string().max(4000).optional() }).parse(req.body);
      const t = svc.getTask(me(req), req.params.id);
      svc.require(me(req), t.project_id, "editor");
      const agent = svc.user(agent_id);
      if (!agent.is_ai) throw forbidden("Ce membre n'est pas un coéquipier IA");
      if (!svc.role(agent.id, t.project_id)) throw forbidden(`${agent.name} n'est pas membre de ce projet. Ajoutez-le dans les membres du projet.`);
      return { run_id: ai.start({ agentId: agent.id, kind: "task", taskId: t.id, projectId: t.project_id, requestedBy: me(req), instructions }) };
    });
    r.post("/api/ai/chat", async (req) => {
      const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20000) })).min(1).max(40), project_id: z.string().nullable().optional() }).parse(req.body);
      return { run_id: ai.startAssistant(me(req), b.messages, b.project_id ?? null) };
    });
    r.get("/api/ai/runs", async (req) => {
      const q = z.object({ task_id: z.string().optional(), project_id: z.string().optional() }).parse(req.query);
      return ai.listRuns(me(req), { taskId: q.task_id, projectId: q.project_id });
    });
    r.get<{ Params: { id: string } }>("/api/ai/runs/:id", async (req) => ai.runDetail(me(req), req.params.id));
    r.post<{ Params: { id: string } }>("/api/ai/runs/:id/cancel", async (req) => { ai.cancel(req.params.id, me(req)); return { ok: true }; });
    r.get("/api/ai/approvals", async (req) => ai.pendingApprovals(me(req)));
    r.post<{ Params: { id: string } }>("/api/ai/approvals/:id", async (req) => {
      const b = z.object({ approve: z.boolean(), edits: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
      return ai.decide(req.params.id, me(req), b.approve, b.edits);
    });
    r.post<{ Params: { id: string } }>("/api/tasks/:id/ai/subtasks", async (req) => ({ subtasks: await ai.suggestSubtasks(me(req), req.params.id) }));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/ai/description", async (req) => ai.improveDescription(me(req), req.params.id));
    r.post<{ Params: { id: string } }>("/api/projects/:id/ai/status", async (req) => ai.projectStatus(me(req), req.params.id));
    r.post<{ Params: { id: string } }>("/api/projects/:id/ai/parse", async (req) => ({ tasks: await ai.parseTasks(me(req), req.params.id, z.object({ text: z.string().min(1).max(20000) }).parse(req.body).text) }));
    r.get<{ Params: { id: string } }>("/api/projects/:id/ai/rules", async (req) => ai.listRules(me(req), req.params.id));
    r.post<{ Params: { id: string } }>("/api/projects/:id/ai/rules", async (req) => ai.saveRule(me(req), { ...z.object({
      id: z.string().optional(), name: z.string().min(1).max(120), trigger: z.enum(["task_created", "task_moved", "task_overdue"]), section_id: z.string().nullable().optional(),
      agent_id: z.string(), instructions: z.string().min(1).max(4000), auto_approve: z.boolean().optional(), enabled: z.boolean().optional(),
    }).parse(req.body), project_id: req.params.id }));
    r.delete<{ Params: { id: string; ruleId: string } }>("/api/projects/:id/ai/rules/:ruleId", async (req) => { ai.deleteRule(me(req), req.params.ruleId); return { ok: true }; });

    // ---------------------------------------------------------------- temps réel (SSE)
    r.get("/api/events", (req, reply) => {
      const userId = me(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ type: "hello" });
      const off = bus.on((e) => { const out = route(e, userId); if (out) send(out); });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.raw.on("close", () => { off(); clearInterval(ping); });
    });
  });

  /** Ne relaie un événement qu'aux personnes qui ont le droit de le voir. */
  function route(e: DomainEvent, userId: string): Record<string, unknown> | null {
    if (e.type === "notification") return e.userId === userId ? { type: "notification" } : null;
    if (e.type === "ai.delta") return e.userId === userId ? { type: "ai.delta", runId: e.runId, delta: e.delta } : null;
    if (e.type === "ai.run" || e.type === "ai.step" || e.type === "ai.approval") {
      const r = get<{ kind: string; requested_by: string | null }>(db, "SELECT kind, requested_by FROM ai_runs WHERE id = ?", e.runId);
      if (r?.kind === "assistant") return r.requested_by === userId ? { type: e.type, runId: e.runId } : null;
      if (!e.projectId || !svc.role(userId, e.projectId)) return null;
      return { type: e.type, runId: e.runId, projectId: e.projectId, taskId: e.taskId, status: (e as { status?: string }).status };
    }
    if (e.type === "project.deleted") return e.members.includes(userId) ? { type: e.type, projectId: e.projectId } : null;
    if (!svc.role(userId, e.projectId)) return null;
    return { type: e.type, projectId: e.projectId, taskId: "taskId" in e ? e.taskId : null, actorId: e.actorId };
  }

  // ------------------------------------------------------------------ front-end compilé
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Route inconnue" });
      return reply.sendFile("index.html");
    });
  }

  return { app, db, svc, ai, bus, provider };
}

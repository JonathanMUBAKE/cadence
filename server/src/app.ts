import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { z } from "zod";
import { openDb, type Db } from "./db.js";
import { Bus, type DomainEvent } from "./bus.js";
import { HttpError, Services, forbidden } from "./services.js";
import { AiEngine } from "./ai/engine.js";
import { AnthropicProvider, MODEL, type AiProvider } from "./ai/provider.js";
import { DemoProvider } from "./ai/demo.js";
import { seedIfEmpty } from "./seed.js";

export interface AppOptions {
  databaseUrl?: string; dataDir?: string; provider?: AiProvider | "auto" | "demo"; webDist?: string;
  seed?: boolean; demoDelayMs?: number; logger?: boolean;
}

declare module "fastify" { interface FastifyRequest { userId: string; orgId: string } }

const COOKIE = "cadence_uid";
const ORG_COOKIE = "cadence_org";

export async function buildApp(opts: AppOptions = {}) {
  const db: Db = await openDb({ url: opts.databaseUrl, dataDir: opts.dataDir });
  const bus = new Bus();
  const svc = new Services(db, bus);
  if (opts.seed !== false) await seedIfEmpty(svc);
  const provider: AiProvider = typeof opts.provider === "object" ? opts.provider
    : opts.provider === "demo" || !process.env.ANTHROPIC_API_KEY ? new DemoProvider(svc, opts.demoDelayMs) : new AnthropicProvider();
  const ai = new AiEngine(svc, bus, provider);
  await ai.init();
  const detach = ai.attach();

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cookie, { secret: process.env.COOKIE_SECRET || "cadence-dev-secret-change-me" });
  app.addHook("onClose", async () => { detach(); await ai.shutdown(); await db.close(); });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "Requête invalide", details: err.issues });
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.code === "23505") return reply.status(409).send({ error: "Cet élément existe déjà" });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.status(500).send({ error: "Erreur interne" });
  });

  const cookieOpts = { path: "/", httpOnly: true, sameSite: "lax" as const, signed: true, maxAge: 60 * 60 * 24 * 30 };
  const unsign = (req: FastifyRequest, name: string) => { const raw = req.cookies[name]; const u = raw ? req.unsignCookie(raw) : null; return u?.valid ? u.value : null; };

  // ------------------------------------------------------------------ authentification (espace de démo)
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = unsign(req, COOKIE);
    if (!id || !(await db.one("SELECT id FROM users WHERE id = $1 AND NOT is_ai", [id]))) return reply.status(401).send({ error: "Non connecté" });
    req.userId = id;
    const orgs = await svc.orgsOf(id);
    const wanted = unsign(req, ORG_COOKIE);
    req.orgId = orgs.find((o) => o.id === wanted)?.id ?? orgs[0]?.id ?? "";
  };

  app.post("/api/auth/login", async (req, reply) => {
    const { user_id } = z.object({ user_id: z.string() }).parse(req.body);
    const u = await svc.user(user_id);
    if (u.is_ai) throw forbidden("Un coéquipier IA ne peut pas se connecter");
    reply.setCookie(COOKIE, u.id, cookieOpts);
    reply.clearCookie(ORG_COOKIE, { path: "/" });
    return u;
  });
  app.post("/api/auth/logout", async (_req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); reply.clearCookie(ORG_COOKIE, { path: "/" }); return { ok: true }; });
  app.get("/api/auth/users", async () => db.query("SELECT * FROM users WHERE NOT is_ai ORDER BY name"));

  app.register(async (r) => {
    r.addHook("preHandler", auth);
    const me = (req: FastifyRequest) => req.userId;
    const org = (req: FastifyRequest) => req.orgId;
    const Priority = z.enum(["none", "low", "medium", "high", "urgent"]);
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
    const Role = z.enum(["viewer", "commenter", "editor", "admin"]);

    r.get("/api/me", async (req) => ({ ...(await svc.user(me(req))), org_id: org(req), orgs: await svc.orgsOf(me(req)) }));
    r.get("/api/users", async (req) => svc.usersOf(org(req)));

    // ---------------------------------------------------------------- organisations, entités, équipes
    r.post("/api/orgs", async (req, reply) => {
      const o = await svc.createOrg(me(req), z.object({ name: z.string().min(1).max(120), domains: z.array(z.string()).optional() }).parse(req.body));
      reply.setCookie(ORG_COOKIE, o.id, cookieOpts);
      return o;
    });
    r.post<{ Params: { id: string } }>("/api/orgs/:id/switch", async (req, reply) => {
      await svc.requireOrg(me(req), req.params.id);
      reply.setCookie(ORG_COOKIE, req.params.id, cookieOpts);
      return { ok: true };
    });
    r.patch("/api/org", async (req) => { await svc.updateOrg(me(req), org(req), z.object({ name: z.string().min(1).max(120).optional(), domains: z.array(z.string()).optional() }).parse(req.body)); return { ok: true }; });
    r.put<{ Params: { userId: string } }>("/api/org/members/:userId", async (req) => {
      await svc.setOrgMember(me(req), org(req), req.params.userId, z.object({ role: z.enum(["owner", "admin", "member", "guest"]).nullable() }).parse(req.body).role);
      return { ok: true };
    });
    r.put<{ Params: { userId: string } }>("/api/org/members/:userId/unit", async (req) => {
      await svc.setMemberUnit(me(req), org(req), req.params.userId, z.object({ unit_id: z.string().nullable() }).parse(req.body).unit_id);
      return { ok: true };
    });
    r.get("/api/org/units", async (req) => svc.units(me(req), org(req)));
    const UnitBody = z.object({ name: z.string().min(1).max(120), kind: z.string().max(40).optional(), parent_id: z.string().nullable().optional(), manager_id: z.string().nullable().optional() });
    r.post("/api/org/units", async (req) => ({ id: await svc.createUnit(me(req), org(req), UnitBody.parse(req.body)) }));
    r.patch<{ Params: { id: string } }>("/api/units/:id", async (req) => { await svc.updateUnit(me(req), req.params.id, UnitBody.partial().parse(req.body)); return { ok: true }; });
    r.delete<{ Params: { id: string } }>("/api/units/:id", async (req) => { await svc.deleteUnit(me(req), req.params.id); return { ok: true }; });

    const TeamBody = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).optional(), visibility: z.enum(["public", "request", "private"]).optional(), unit_id: z.string().nullable().optional(), color: z.string().optional() });
    r.get("/api/teams", async (req) => svc.teams(me(req), org(req)));
    r.post("/api/teams", async (req) => svc.createTeam(me(req), org(req), TeamBody.parse(req.body)));
    r.get<{ Params: { id: string } }>("/api/teams/:id", async (req) => svc.team(me(req), req.params.id));
    r.patch<{ Params: { id: string } }>("/api/teams/:id", async (req) => { await svc.updateTeam(me(req), req.params.id, TeamBody.partial().parse(req.body)); return { ok: true }; });
    r.put<{ Params: { id: string; userId: string } }>("/api/teams/:id/members/:userId", async (req) => {
      await svc.setTeamMember(me(req), req.params.id, req.params.userId, z.object({ role: z.enum(["lead", "member"]).nullable() }).parse(req.body).role);
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>("/api/teams/:id/join", async (req) => ({ result: await svc.joinTeam(me(req), req.params.id) }));
    r.post<{ Params: { id: string } }>("/api/team-requests/:id", async (req) => { await svc.decideTeamRequest(me(req), req.params.id, z.object({ approve: z.boolean() }).parse(req.body).approve); return { ok: true }; });

    // ---------------------------------------------------------------- projets
    r.get("/api/projects", async (req) => svc.listProjects(me(req), org(req), { archived: (req.query as { archived?: string }).archived === "true" }));
    r.post("/api/projects", async (req) => svc.createProject(me(req), org(req), z.object({
      name: z.string().min(1).max(120), description: z.string().max(5000).optional(), color: z.string().optional(), icon: z.string().optional(), due_on: date.optional(),
      team_id: z.string().nullable().optional(), key: z.string().max(10).optional(), access: z.enum(["team", "private"]).optional(), sections: z.array(z.string().max(80)).max(20).optional(),
    }).parse(req.body)));
    r.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => svc.getProject(me(req), req.params.id));
    r.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => svc.updateProject(me(req), req.params.id, z.object({
      name: z.string().min(1).max(120).optional(), description: z.string().max(5000).optional(), color: z.string().optional(), icon: z.string().optional(),
      status: z.enum(["on_track", "at_risk", "off_track", "done"]).optional(), due_on: date.optional(), archived: z.boolean().optional(),
      team_id: z.string().nullable().optional(), access: z.enum(["team", "private"]).optional(),
    }).parse(req.body)));
    r.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => { await svc.deleteProject(me(req), req.params.id, z.object({ confirm: z.string() }).parse(req.body ?? {}).confirm); return { ok: true }; });
    r.put<{ Params: { id: string; userId: string } }>("/api/projects/:id/members/:userId", async (req) =>
      svc.setMember(me(req), req.params.id, req.params.userId, z.object({ role: Role.nullable() }).parse(req.body).role));
    r.get<{ Params: { id: string } }>("/api/projects/:id/tasks", async (req) => svc.listTasks(me(req), { project_id: req.params.id }));
    r.get<{ Params: { id: string } }>("/api/projects/:id/stats", async (req) => svc.projectStats(me(req), req.params.id));
    r.get<{ Params: { id: string } }>("/api/projects/:id/activity", async (req) => svc.projectActivity(me(req), req.params.id, 60));
    r.get<{ Params: { id: string } }>("/api/projects/:id/updates", async (req) => {
      await svc.require(me(req), req.params.id);
      return db.query("SELECT * FROM activity WHERE project_id = $1 AND kind = 'project.update' ORDER BY created_at DESC LIMIT 20", [req.params.id]);
    });
    r.post<{ Params: { id: string } }>("/api/projects/:id/updates", async (req) => {
      const body = z.object({ status: z.enum(["on_track", "at_risk", "off_track"]), headline: z.string().min(1), summary: z.string(), risks: z.array(z.string()), next_steps: z.array(z.string()), ai: z.boolean().optional() }).parse(req.body);
      await svc.updateProject(me(req), req.params.id, { status: body.status });
      await svc.log(me(req), "project.update", { projectId: req.params.id, data: body });
      for (const m of await svc.members(req.params.id)) if (m.user_id !== me(req) && !(await svc.user(m.user_id)).is_ai)
        await svc.notify(m.user_id, await svc.orgOfProject(req.params.id), { kind: "project.update", title: `Nouveau point d'avancement : ${body.headline}`, body: body.summary, project_id: req.params.id, actor_id: me(req) });
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>("/api/projects/:id/sections", async (req) => svc.createSection(me(req), req.params.id, z.object({ name: z.string().max(80) }).parse(req.body).name));
    r.patch<{ Params: { id: string } }>("/api/sections/:id", async (req) => svc.updateSection(me(req), req.params.id, z.object({ name: z.string().max(80).optional(), position: z.number().optional() }).parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/sections/:id/move", async (req) => svc.moveSection(me(req), req.params.id, z.object({ direction: z.enum(["left", "right"]) }).parse(req.body).direction));
    r.delete<{ Params: { id: string } }>("/api/sections/:id", async (req) => { await svc.deleteSection(me(req), req.params.id); return { ok: true }; });

    // ---------------------------------------------------------------- tâches
    const TaskBody = z.object({
      project_id: z.string(), title: z.string().min(1).max(300), description: z.string().max(20000).optional(), section_id: z.string().nullable().optional(),
      parent_id: z.string().nullable().optional(), assignee_id: z.string().nullable().optional(), priority: Priority.optional(),
      start_on: date.optional(), due_on: date.optional(), tags: z.array(z.string().max(40)).max(12).optional(),
    });
    r.get("/api/tasks", async (req) => {
      const q = z.object({ assignee: z.string().optional(), completed: z.enum(["true", "false"]).optional(), project_id: z.string().optional(), overdue: z.enum(["true"]).optional(), subtasks: z.enum(["true"]).optional() }).parse(req.query);
      return svc.listTasks(me(req), {
        org_id: org(req), assignee_id: q.assignee === "me" ? me(req) : q.assignee, completed: q.completed === undefined ? undefined : q.completed === "true",
        project_id: q.project_id, overdue: q.overdue === "true", include_subtasks: q.subtasks === "true",
      });
    });
    r.post("/api/tasks", async (req) => svc.createTask(me(req), TaskBody.parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/projects/:id/tasks/bulk", async (req) => {
      const { tasks } = z.object({ tasks: z.array(TaskBody.omit({ project_id: true })).min(1).max(50) }).parse(req.body);
      const out = []; for (const t of tasks) out.push(await svc.createTask(me(req), { ...t, project_id: req.params.id }));
      return out;
    });
    r.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) => svc.getTask(me(req), req.params.id));
    r.patch<{ Params: { id: string } }>("/api/tasks/:id", async (req) => svc.updateTask(me(req), req.params.id, TaskBody.omit({ project_id: true, parent_id: true }).partial().extend({ completed: z.boolean().optional() }).parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/move", async (req) => svc.moveTask(me(req), req.params.id, z.object({ section_id: z.string(), before_id: z.string().nullable().optional(), after_id: z.string().nullable().optional() }).parse(req.body)));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/duplicate", async (req) => svc.duplicateTask(me(req), req.params.id, z.object({ subtasks: z.boolean().optional() }).parse(req.body ?? {})));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/move-project", async (req) => svc.moveTaskToProject(me(req), req.params.id, z.object({ project_id: z.string() }).parse(req.body).project_id));
    r.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req) => { await svc.deleteTask(me(req), req.params.id); return { ok: true }; });
    r.post<{ Params: { id: string } }>("/api/tasks/:id/comments", async (req) => svc.addComment(me(req), req.params.id, z.object({ body: z.string().min(1).max(10000) }).parse(req.body).body));
    r.patch<{ Params: { id: string } }>("/api/comments/:id", async (req) => svc.updateComment(me(req), req.params.id, z.object({ body: z.string().min(1).max(10000) }).parse(req.body).body));
    r.delete<{ Params: { id: string } }>("/api/comments/:id", async (req) => { await svc.deleteComment(me(req), req.params.id); return { ok: true }; });

    // ---------------------------------------------------------------- boîte de réception & recherche
    r.get("/api/notifications", async (req) => svc.listNotifications(me(req), org(req)));
    r.post("/api/notifications/read", async (req) => { const b = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }).parse(req.body); await svc.markRead(me(req), org(req), b.all ? "all" : b.ids ?? []); return { ok: true }; });
    r.get("/api/search", async (req) => svc.search(me(req), org(req), z.object({ q: z.string().default("") }).parse(req.query).q));

    // ---------------------------------------------------------------- IA
    r.get("/api/ai/status", async () => ({ provider: provider.name, model: provider.name === "anthropic" ? MODEL : null }));
    r.get("/api/ai/agents", async (req) => svc.agents(org(req)));
    r.post<{ Params: { id: string } }>("/api/tasks/:id/ai/run", async (req) => {
      const { agent_id, instructions } = z.object({ agent_id: z.string(), instructions: z.string().max(4000).optional() }).parse(req.body);
      const t = await svc.getTask(me(req), req.params.id);
      await svc.require(me(req), t.project_id, "editor");
      const agent = await svc.user(agent_id);
      if (!agent.is_ai) throw forbidden("Ce membre n'est pas un coéquipier IA");
      if (!(await svc.projectRole(agent.id, t.project_id))) throw forbidden(`${agent.name} n'a pas accès à ce projet. Ajoutez-le aux membres du projet.`);
      return { run_id: await ai.start({ agentId: agent.id, kind: "task", taskId: t.id, projectId: t.project_id, requestedBy: me(req), instructions }) };
    });
    r.post("/api/ai/chat", async (req) => {
      const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20000) })).min(1).max(40), project_id: z.string().nullable().optional() }).parse(req.body);
      return { run_id: await ai.startAssistant(me(req), org(req), b.messages, b.project_id ?? null) };
    });
    r.get("/api/ai/runs", async (req) => {
      const q = z.object({ task_id: z.string().optional(), project_id: z.string().optional() }).parse(req.query);
      return ai.listRuns(me(req), { orgId: org(req), taskId: q.task_id, projectId: q.project_id });
    });
    r.get<{ Params: { id: string } }>("/api/ai/runs/:id", async (req) => ai.runDetail(me(req), req.params.id));
    r.post<{ Params: { id: string } }>("/api/ai/runs/:id/cancel", async (req) => { await ai.cancel(req.params.id, me(req)); return { ok: true }; });
    r.get("/api/ai/approvals", async (req) => ai.pendingApprovals(me(req), org(req)));
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
    r.delete<{ Params: { id: string; ruleId: string } }>("/api/projects/:id/ai/rules/:ruleId", async (req) => { await ai.deleteRule(me(req), req.params.ruleId); return { ok: true }; });

    // ---------------------------------------------------------------- temps réel (SSE)
    r.get("/api/events", (req, reply) => {
      const userId = me(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ type: "hello" });
      const off = bus.on((e) => { route(e, userId).then((out) => { if (out) send(out); }, () => {}); });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.raw.on("close", () => { off(); clearInterval(ping); });
    });
  });

  /** Ne relaie un événement qu'aux personnes qui ont le droit de le voir. */
  async function route(e: DomainEvent, userId: string): Promise<Record<string, unknown> | null> {
    if (e.type === "notification") return e.userId === userId ? { type: "notification" } : null;
    if (e.type === "ai.delta") return e.userId === userId ? { type: "ai.delta", runId: e.runId, delta: e.delta } : null;
    if (e.type === "org.changed") return (await svc.orgRole(userId, e.orgId)) ? { type: e.type, orgId: e.orgId } : null;
    if (e.type === "project.deleted") return e.members.includes(userId) ? { type: e.type, projectId: e.projectId } : null;
    if (e.type === "ai.run" || e.type === "ai.step" || e.type === "ai.approval") {
      const run = await db.one<{ kind: string; requested_by: string | null }>("SELECT kind, requested_by FROM ai_runs WHERE id = $1", [e.runId]);
      if (run?.kind === "assistant") return run.requested_by === userId ? { type: e.type, runId: e.runId } : null;
      if (!e.projectId || !(await svc.projectRole(userId, e.projectId))) return null;
      return { type: e.type, runId: e.runId, projectId: e.projectId, taskId: e.taskId, status: (e as { status?: string }).status };
    }
    if (!(await svc.projectRole(userId, e.projectId))) return null;
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

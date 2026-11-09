import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  expect(res.statusCode).toBe(200);
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
}
async function api(user: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[user] } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const waitFor = async <T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 4000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const projectId = async (name: string) => (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const orgId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;

beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_hugo", "u_theo"]) await login(u);
});
afterEach(async () => { await ctx.app.close(); });

describe("authentification et droits", () => {
  it("refuse les requêtes sans session", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("n'expose que les projets dont on est membre", async () => {
    const alice = (await api("u_alice", "GET", "/api/projects")).body.map((p: { name: string }) => p.name);
    const karim = (await api("u_karim", "GET", "/api/projects")).body.map((p: { name: string }) => p.name);
    expect(alice).toContain("RH · Recrutements 2027");
    expect(karim).not.toContain("RH · Recrutements 2027");
    const hr = await projectId("RH");
    expect((await api("u_karim", "GET", `/api/projects/${hr}`)).status).toBe(403);
  });

  it("un lecteur ne peut pas modifier une tâche", async () => {
    const app = await projectId("Application mobile");
    const [task] = (await api("u_hugo", "GET", `/api/projects/${app}/tasks`)).body;
    const res = await api("u_hugo", "PATCH", `/api/tasks/${task.id}`, { title: "Piraté" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/n'a pas le droit de modifier/);
  });
});

describe("tâches", () => {
  it("crée, déplace, commente et termine une tâche", async () => {
    const pid = await projectId("Application mobile");
    const proj = (await api("u_alice", "GET", `/api/projects/${pid}`)).body;
    const created = await api("u_alice", "POST", "/api/tasks", { project_id: pid, title: "Nouvelle tâche", assignee_id: "u_karim", due_on: "2030-01-15", priority: "high" });
    expect(created.status).toBe(200);
    expect(created.body.section_id).toBe(proj.sections[0].id);

    const target = proj.sections[2];
    const moved = await api("u_alice", "POST", `/api/tasks/${created.body.id}/move`, { section_id: target.id });
    expect(moved.body.section_id).toBe(target.id);

    await api("u_alice", "POST", `/api/tasks/${created.body.id}/comments`, { body: "@Karim tu peux regarder ?" });
    const notifs = (await api("u_karim", "GET", "/api/notifications")).body;
    expect(notifs.some((n: { kind: string }) => n.kind === "mention")).toBe(true);
    expect(notifs.some((n: { kind: string }) => n.kind === "assigned")).toBe(true);

    const done = await api("u_karim", "PATCH", `/api/tasks/${created.body.id}`, { completed: true });
    expect(done.body.completed).toBe(true);
    const detail = (await api("u_alice", "GET", `/api/tasks/${created.body.key}`)).body;
    expect(detail.activity.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(["task.created", "task.section_id", "task.completed", "comment.created"]));
  });

  it("refuse d'assigner quelqu'un qui n'est pas membre du projet", async () => {
    const pid = await projectId("RH");
    const res = await api("u_alice", "POST", "/api/tasks", { project_id: pid, title: "Test", assignee_id: "u_karim" });
    expect(res.status).toBe(400);
  });

  it("calcule les indicateurs du projet", async () => {
    const stats = (await api("u_alice", "GET", `/api/projects/${await projectId("Application mobile")}/stats`)).body;
    expect(stats.total).toBeGreaterThan(10);
    expect(stats.overdue).toBeGreaterThanOrEqual(2);
    expect(stats.burnup).toHaveLength(14);
  });
});

describe("coéquipier IA", () => {
  it("assigner une tâche à Atlas lance un agent qui attend les validations", async () => {
    const pid = await projectId("Application mobile");
    const tasks = (await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body;
    const weekly = tasks.find((t: { title: string }) => t.title.startsWith("Point d'avancement"));
    await api("u_alice", "PATCH", `/api/tasks/${weekly.id}`, { assignee_id: "ai_atlas" });

    const approvals = await waitFor(async () => (await api("u_alice", "GET", "/api/ai/approvals")).body as { id: string; tool: string; summary: string }[], (a) => a.length > 0);
    expect(approvals[0].summary).toMatch(/Commenter|Créer/);
    // Un lecteur ne peut pas valider
    expect((await api("u_hugo", "POST", `/api/ai/approvals/${approvals[0].id}`, { approve: true })).status).toBe(403);

    // On refuse la première action, on accepte toutes les suivantes
    let first = true;
    const [run] = (await api("u_alice", "GET", `/api/ai/runs?task_id=${weekly.id}`)).body;
    await waitFor(async () => {
      const pending = (await api("u_alice", "GET", "/api/ai/approvals")).body as { id: string }[];
      for (const a of pending) { await api("u_alice", "POST", `/api/ai/approvals/${a.id}`, { approve: !first }); first = false; }
      return (await api("u_alice", "GET", `/api/ai/runs/${run.id}`)).body;
    }, (r) => r.status === "done", 8000);

    const detail = (await api("u_alice", "GET", `/api/ai/runs/${run.id}`)).body;
    expect(detail.steps.some((s: { status: string }) => s.status === "rejected")).toBe(true);
    expect(detail.steps.some((s: { tool: string; status: string }) => s.tool === "add_comment" && s.status === "ok")).toBe(true);
    const task = (await api("u_alice", "GET", `/api/tasks/${weekly.id}`)).body;
    expect(task.comments.at(-1).author_id).toBe("ai_atlas");
    expect(task.subtasks.length).toBe(3);
  });

  it("l'IA ne voit pas les projets auxquels elle n'a pas accès", async () => {
    const hr = await projectId("RH");
    const c = { actorId: "ai_atlas", orgId: await orgId() };
    await expect(ctx.ai.tools.execute(c, "get_project", { project_id: hr })).rejects.toThrow(/n'a pas le droit/);
    const res = await ctx.ai.tools.execute(c, "search_tasks", { text: "rémunération" }) as { count: number };
    expect(res.count).toBe(0);
  });

  it("une règle déclenche Nova à la création d'une tâche dans le Backlog", async () => {
    const pid = await projectId("Application mobile");
    const backlog = (await api("u_alice", "GET", `/api/projects/${pid}`)).body.sections.find((s: { name: string }) => s.name === "Backlog");
    const t = (await api("u_alice", "POST", "/api/tasks", { project_id: pid, title: "Bug : crash au lancement", section_id: backlog.id })).body;
    const runs = await waitFor(async () => (await api("u_alice", "GET", `/api/ai/runs?task_id=${t.id}`)).body as { agent_id: string; kind: string }[], (r) => r.length > 0);
    expect(runs[0]).toMatchObject({ agent_id: "ai_nova", kind: "rule" });
  });

  it("l'assistant agit avec les droits de l'utilisateur et demande validation avant d'écrire", async () => {
    const pid = await projectId("Application mobile");
    const { run_id } = (await api("u_karim", "POST", "/api/ai/chat", { project_id: pid, messages: [{ role: "user", content: "Crée une tâche Préparer la démo client" }] })).body;
    const [approval] = await waitFor(async () => (await api("u_karim", "GET", "/api/ai/approvals")).body as { id: string }[], (a) => a.length > 0);
    expect((await api("u_alice", "POST", `/api/ai/approvals/${approval.id}`, { approve: true })).status).toBe(403);
    await api("u_karim", "POST", `/api/ai/approvals/${approval.id}`, { approve: true });
    const done = await waitFor(async () => (await api("u_karim", "GET", `/api/ai/runs/${run_id}`)).body, (r) => r.status === "done");
    expect(done.summary).toMatch(/créée/);
    // La conversation est privée
    expect((await api("u_alice", "GET", `/api/ai/runs/${run_id}`)).status).toBe(403);
  });

  it("propose des sous-tâches, un point d'avancement et des tâches extraites d'un texte", async () => {
    const pid = await projectId("Application mobile");
    const [task] = (await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body;
    expect((await api("u_alice", "POST", `/api/tasks/${task.id}/ai/subtasks`)).body.subtasks.length).toBeGreaterThan(2);
    const status = (await api("u_alice", "POST", `/api/projects/${pid}/ai/status`)).body;
    expect(["on_track", "at_risk", "off_track"]).toContain(status.status);
    const parsed = (await api("u_alice", "POST", `/api/projects/${pid}/ai/parse`, { text: "Karim corrige le crash demain\nChloé refait l'icône, urgent" })).body.tasks;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].assignee_id).toBe("u_karim");
    expect(parsed[1].priority).toBe("urgent");
  });
});

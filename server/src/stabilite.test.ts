import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { localDate } from "./services.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
}
async function api(user: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[user] } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const projectId = async (name: string) =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const orgId = async () =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const firstTask = async (pid: string) =>
  (await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body[0] as { id: string; key: string };

beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_chloe"]) await login(u);
});
afterEach(async () => {
  await ctx.app.close();
});

describe("stabilité", () => {
  it("mentionne un prénom finissant par une lettre accentuée, sans confondre les prénoms", async () => {
    const t = await firstTask(await projectId("Application mobile"));
    await api("u_alice", "POST", `/api/tasks/${t.id}/comments`, { body: "@Chloé tu peux regarder ?" });
    expect(
      (await api("u_chloe", "GET", "/api/notifications")).body.filter((n: { kind: string }) => n.kind === "mention"),
    ).toHaveLength(1);
    await api("u_alice", "POST", `/api/tasks/${t.id}/comments`, { body: "@Chloéa n'existe pas" });
    expect(
      (await api("u_chloe", "GET", "/api/notifications")).body.filter((n: { kind: string }) => n.kind === "mention"),
    ).toHaveLength(1);
  });

  it("refuse une date impossible avec un message clair, sur les tâches et les projets", async () => {
    const pid = await projectId("Application mobile");
    const t = await firstTask(pid);
    for (const due_on of ["2026-13-45", "2026-02-31"]) {
      const res = await api("u_alice", "PATCH", `/api/tasks/${t.id}`, { due_on });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Date invalide/);
    }
    expect((await api("u_alice", "PATCH", `/api/projects/${pid}`, { due_on: "2026-13-45" })).status).toBe(400);
    expect(
      (await api("u_alice", "POST", "/api/tasks", { project_id: pid, title: "T", due_on: "2026-00-10" })).status,
    ).toBe(400);
    expect((await api("u_alice", "PATCH", `/api/tasks/${t.id}`, { due_on: "2028-02-29" })).body.due_on).toBe(
      "2028-02-29",
    );
  });

  it("répond 404 pour un membre inexistant", async () => {
    expect((await api("u_alice", "PUT", "/api/org/members/u_fantome", { role: "member" })).status).toBe(404);
  });

  it("compte les retards de la même façon dans la liste et le tableau de bord", async () => {
    const pid = await projectId("Application mobile");
    const t = await firstTask(pid);
    await ctx.svc.createTask("u_alice", {
      project_id: pid,
      parent_id: t.id,
      title: "Sous-tâche en retard",
      due_on: "2020-01-01",
    });
    const summary = (await api("u_alice", "GET", "/api/projects")).body.find((p: { id: string }) => p.id === pid);
    expect(summary.overdue_count).toBe((await api("u_alice", "GET", `/api/projects/${pid}/stats`)).body.overdue);
  });

  it("ne coupe plus un gros projet à 500 tâches", async () => {
    const p = await ctx.svc.createProject("u_alice", await orgId(), { name: "Gros projet", key: "GROS" });
    await ctx.db.query(
      "INSERT INTO tasks (id, number, project_id, section_id, title, position) SELECT 'x' || g, g, $1, $2, 'T' || g, g FROM generate_series(1, 620) g",
      [p.id, p.sections[0].id],
    );
    expect((await api("u_alice", "GET", `/api/projects/${p.id}/stats`)).body.total).toBe(620);
    expect((await api("u_alice", "GET", `/api/projects/${p.id}/tasks`)).body).toHaveLength(620);
  });

  it("résout une clé dans l'organisation active quand deux organisations ont la même", async () => {
    const pid = await projectId("Application mobile");
    const key = (await api("u_alice", "GET", `/api/projects/${pid}`)).body.key as string;
    const org2 = (await api("u_alice", "POST", "/api/orgs", { name: "Org Test" })).body as { id: string };
    const other = await ctx.svc.createProject("u_alice", org2.id, { name: "Doublon", key });
    const t2 = await ctx.svc.createTask("u_alice", { project_id: other.id, title: "Tâche de l'autre organisation" });
    await login("u_alice");
    expect((await api("u_alice", "GET", `/api/tasks/${key}-1`)).body.project_id).toBe(pid);
    const out = (await ctx.ai.tools.execute({ actorId: "u_alice", orgId: org2.id }, "get_task", { task: t2.key })) as {
      title: string;
    };
    expect(out.title).toBe("Tâche de l'autre organisation");
  });

  it("annule l'exécution IA et sa validation quand le projet est supprimé", async () => {
    const p = await ctx.svc.createProject("u_alice", await orgId(), { name: "Ephemere", key: "EPHM" });
    await api("u_alice", "PUT", `/api/projects/${p.id}/members/ai_atlas`, { role: "editor" });
    const t = await ctx.svc.createTask("u_alice", { project_id: p.id, title: "Tâche", assignee_id: "ai_atlas" });
    const run = () =>
      ctx.db.one<{ id: string; status: string }>("SELECT id, status FROM ai_runs WHERE task_id = $1", [t.id]);
    const { id } = (await waitFor(run, (r) => r?.status === "waiting_approval")) as { id: string };
    await api("u_alice", "DELETE", `/api/projects/${p.id}`, { confirm: "Ephemere" });
    await waitFor(run, (r) => r?.status === "cancelled");
    await waitFor(
      () => ctx.db.query<{ status: string }>("SELECT status FROM ai_approvals WHERE run_id = $1", [id]),
      (a) => a.every((x) => x.status === "expired"),
    );
  });

  it("annule l'exécution IA quand sa tâche est supprimée", async () => {
    const pid = await projectId("Application mobile");
    const t = await ctx.svc.createTask("u_alice", { project_id: pid, title: "Tâche", assignee_id: "ai_atlas" });
    const run = () => ctx.db.one<{ status: string }>("SELECT status FROM ai_runs WHERE task_id = $1", [t.id]);
    await waitFor(run, (r) => r?.status === "waiting_approval");
    await api("u_alice", "DELETE", `/api/tasks/${t.id}`);
    await waitFor(run, (r) => r?.status === "cancelled");
  });

  it("refuse une règle IA liée à la section d'un autre projet", async () => {
    const other = (await api("u_alice", "GET", `/api/projects/${await projectId("Campagne de lancement")}`)).body
      .sections[0].id;
    const res = await api("u_alice", "POST", `/api/projects/${await projectId("Application mobile")}/ai/rules`, {
      name: "x",
      trigger: "task_created",
      section_id: other,
      agent_id: "ai_atlas",
      instructions: "y",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Section/);
  });

  it("une tâche ne peut pas perdre sa section", async () => {
    const t = await firstTask(await projectId("Application mobile"));
    expect((await api("u_alice", "PATCH", `/api/tasks/${t.id}`, { section_id: null })).status).toBe(400);
  });

  it("une longue liste de résultats reste exploitable par l'assistant", async () => {
    const p = await ctx.svc.createProject("u_alice", await orgId(), { name: "Charge", key: "CHRG" });
    for (let i = 0; i < 30; i++)
      await ctx.svc.createTask("u_alice", {
        project_id: p.id,
        title: `Tâche ${i} avec un titre assez long pour remplir le résultat`,
        due_on: "2020-02-02",
        assignee_id: "u_alice",
        priority: "high",
      });
    const { run_id } = (
      await api("u_alice", "POST", "/api/ai/chat", {
        project_id: p.id,
        messages: [{ role: "user", content: "Qu'est-ce qui est en retard ?" }],
      })
    ).body;
    expect(
      (
        await waitFor(
          async () => (await api("u_alice", "GET", `/api/ai/runs/${run_id}`)).body,
          (r) => r.status === "done" || r.status === "failed",
        )
      ).status,
    ).toBe("done");
  });

  it("donne la date du calendrier local, pas la date UTC", () => {
    const d = new Date(2026, 2, 1, 0, 30);
    expect(localDate(d)).toBe("2026-03-01");
  });
});

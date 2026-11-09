import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

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
const waitFor = async <T,>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const projectId = async (name: string) => (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const orgId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const seeded = async (pid: string) => (await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body[0] as { id: string; title: string };
const kinds = async (pid: string) => (await ctx.db.query<{ kind: string }>("SELECT kind FROM activity WHERE project_id = $1", [pid])).map((a) => a.kind);

beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_theo", "u_hugo", "u_ines"]) await login(u);
});
afterEach(async () => { await ctx.app.close(); });

describe("suppressions : seuls l'auteur et les administrateurs", () => {
  it("un éditeur ne supprime pas la tâche d'un autre ; son auteur et l'administrateur le peuvent", async () => {
    const pid = await projectId("Application mobile");
    const other = await seeded(pid);
    await ctx.svc.setMember("u_alice", pid, "u_chloe", "editor");
    await login("u_chloe");
    const res = await api("u_theo", "DELETE", `/api/tasks/${other.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/auteur/);
    expect((await api("u_alice", "GET", `/api/tasks/${other.id}`)).status).toBe(200);
    const mine = (await api("u_theo", "POST", "/api/tasks", { project_id: pid, title: "La mienne" })).body;
    expect((await api("u_chloe", "DELETE", `/api/tasks/${mine.id}`)).status).toBe(403);
    expect((await api("u_theo", "DELETE", `/api/tasks/${mine.id}`)).status).toBe(200);
    expect((await api("u_alice", "DELETE", `/api/tasks/${other.id}`)).status).toBe(200);
  });

  it("un lecteur ne supprime rien, même une tâche qu'il aurait créée", async () => {
    const pid = await projectId("Application mobile");
    const t = (await api("u_karim", "POST", "/api/tasks", { project_id: pid, title: "Temp" })).body;
    await ctx.svc.setMember("u_alice", pid, "u_karim", "viewer");
    await ctx.db.query("DELETE FROM team_members WHERE user_id = 'u_karim'");
    expect((await api("u_karim", "DELETE", `/api/tasks/${t.id}`)).status).toBe(403);
  });

  it("sortir la tâche d'un autre vers un autre projet est soumis à la même règle", async () => {
    const dest = await projectId("Application mobile");
    const pid = await projectId("Campagne de lancement");
    await ctx.svc.setMember("u_alice", pid, "u_karim", "editor");
    const other = await seeded(pid);
    expect((await api("u_karim", "POST", `/api/tasks/${other.id}/move-project`, { project_id: dest })).status).toBe(403);
    const mine = (await api("u_karim", "POST", "/api/tasks", { project_id: pid, title: "La mienne" })).body;
    expect((await api("u_karim", "POST", `/api/tasks/${mine.id}/move-project`, { project_id: dest })).status).toBe(200);
  });

  it("seul un administrateur supprime une section, et c'est journalisé", async () => {
    const pid = await projectId("Application mobile");
    const [section] = (await api("u_alice", "GET", `/api/projects/${pid}`)).body.sections;
    expect((await api("u_theo", "DELETE", `/api/sections/${section.id}`)).status).toBe(403);
    expect((await api("u_alice", "DELETE", `/api/sections/${section.id}`)).status).toBe(200);
    expect(await kinds(pid)).toContain("section.deleted");
  });

  it("seul un administrateur archive un projet ; un éditeur peut toujours le renommer", async () => {
    const pid = await projectId("Application mobile");
    expect((await api("u_theo", "PATCH", `/api/projects/${pid}`, { archived: true })).status).toBe(403);
    expect((await api("u_theo", "PATCH", `/api/projects/${pid}`, { name: "Application mobile v3" })).status).toBe(200);
    expect((await api("u_alice", "PATCH", `/api/projects/${pid}`, { archived: true })).status).toBe(200);
    expect(await kinds(pid)).toContain("project.archived");
  });

  it("la suppression d'une règle IA et d'une entité est journalisée", async () => {
    const pid = await projectId("Application mobile");
    const [rule] = (await api("u_alice", "GET", `/api/projects/${pid}/ai/rules`)).body;
    await api("u_alice", "DELETE", `/api/projects/${pid}/ai/rules/${rule.id}`);
    expect(await kinds(pid)).toContain("rule.deleted");
    const id = (await api("u_alice", "POST", "/api/org/units", { name: "Vide", kind: "Service", parent_id: (await api("u_alice", "GET", "/api/org/units")).body[0].id })).body.id;
    expect((await api("u_karim", "DELETE", `/api/units/${id}`)).status).toBe(403);
    await api("u_alice", "DELETE", `/api/units/${id}`);
    expect((await ctx.db.query<{ kind: string }>("SELECT kind FROM activity WHERE org_id = $1", [await orgId()])).map((a) => a.kind)).toContain("unit.deleted");
  });
});

describe("actions IA", () => {
  it("un lecteur ne déclenche pas d'action IA payante", async () => {
    const pid = await projectId("Application mobile");
    const t = await seeded(pid);
    for (const [url, body] of [[`/api/tasks/${t.id}/ai/subtasks`, {}], [`/api/tasks/${t.id}/ai/description`, {}], [`/api/projects/${pid}/ai/status`, {}], [`/api/projects/${pid}/ai/parse`, { text: "Faire ceci" }]] as const) {
      expect((await api("u_hugo", "POST", url, body)).status).toBe(403);
      expect((await api("u_karim", "POST", url, body)).status).toBe(200);
    }
  });

  it("retoucher une validation ne peut pas changer sa cible", async () => {
    const pid = await projectId("Application mobile");
    const t = (await api("u_alice", "POST", "/api/tasks", { project_id: pid, title: "Tâche IA", assignee_id: "ai_atlas" })).body;
    const [a] = await waitFor(async () => (await api("u_alice", "GET", "/api/ai/approvals")).body as { id: string; input: Record<string, unknown>; task_id: string }[], (x) => x.some((y) => y.task_id === t.id));
    const before = a.input;
    const edited = (await api("u_alice", "POST", `/api/ai/approvals/${a.id}`, { approve: true, edits: { task: "RH-1", project_id: "RH", parent: "RH-1", object_id: "RH", __run_id: "x", title: "Titre retouché", body: "Texte retouché" } })).body;
    for (const k of ["task", "project_id", "parent", "object_id"]) expect(edited.input[k]).toEqual(before[k]);
    expect(edited.input.__run_id).toBeUndefined();
    expect(edited.input.title ?? edited.input.body).toMatch(/retouché/);
  });
});

describe("annuaire et équipes", () => {
  it("un invité ne voit que les personnes de ses projets", async () => {
    const org = await orgId();
    const app = await projectId("Application mobile");
    await ctx.db.query("DELETE FROM team_members WHERE user_id = 'u_karim'");
    await ctx.db.query("DELETE FROM memberships WHERE user_id = 'u_karim' AND project_id <> $1", [app]);
    await ctx.svc.setMember("u_alice", app, "u_karim", "commenter");
    await api("u_alice", "PUT", "/api/org/members/u_karim", { role: "guest" });
    const seen = (await api("u_karim", "GET", "/api/users")).body.map((u: { id: string }) => u.id) as string[];
    const expected = new Set([...(await ctx.svc.members(app)).map((m) => m.user_id), "u_karim"]);
    expect(new Set(seen)).toEqual(expected);
    expect(seen.length).toBeLessThan((await ctx.svc.usersOf(org)).length);
    expect((await api("u_alice", "GET", "/api/users")).body.length).toBe((await ctx.svc.usersOf(org)).length);
  });

  it("une équipe garde un responsable quand on rétrograde le dernier", async () => {
    const t = (await api("u_alice", "POST", "/api/teams", { name: "Test" })).body;
    await api("u_alice", "PUT", `/api/teams/${t.id}/members/u_karim`, { role: "member" });
    const res = await api("u_alice", "PUT", `/api/teams/${t.id}/members/u_alice`, { role: "member" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/responsable/);
    await api("u_alice", "PUT", `/api/teams/${t.id}/members/u_karim`, { role: "lead" });
    expect((await api("u_alice", "PUT", `/api/teams/${t.id}/members/u_alice`, { role: "member" })).status).toBe(200);
  });
});

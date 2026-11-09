import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function api(who: string, method: Method, url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who] } });
  let body = null; try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body };
}
async function start(provider: AppOptions["provider"] = "demo") {
  ctx = await buildApp({ provider, demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_theo", "u_ines", "u_hugo"]) cookies[u] = String(([] as string[]).concat((await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: u } })).headers["set-cookie"] as string)[0]).split(";")[0];
}
const appId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE '%Application mobile%'"))!.id;
const newTask = async (who = "u_alice") => (await api(who, "POST", "/api/tasks", { project_id: await appId(), title: "T" })).body as { id: string; key: string; section_id: string };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = async (name: string) => (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { name: string }) => p.name === name) as { id: string; is_system: boolean; permissions: string[] };
afterEach(async () => { await ctx.app.close(); });

describe("R-02 : une lecture n'écrit jamais", () => {
  const configure = () => api("u_alice", "PUT", "/api/org/mail", { domain: "nova.test", smtp: { host: "127.0.0.1", port: 1, security: "none" } });
  it("lire les adresses de service ne crée rien", async () => {
    await start(); await configure();
    await ctx.db.query("DELETE FROM service_addresses");
    expect((await api("u_karim", "GET", "/api/org/mail/addresses")).status).toBe(200);
    expect((await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM service_addresses"))!.n).toBe(0);
  });
  it("une équipe créée reçoit son adresse sans attendre une lecture", async () => {
    await start(); await configure();
    await api("u_alice", "POST", "/api/teams", { name: "Nouvelle équipe" });
    expect(JSON.stringify((await api("u_alice", "GET", "/api/org/mail/addresses")).body)).toContain("nouvelle-equipe@");
  });
});

describe("R-03 : le droit de commenter couvre toute la vie du commentaire", () => {
  it("sans ce droit, on ne modifie ni ne supprime", async () => {
    await start();
    const t = await newTask();
    const c = (await api("u_theo", "POST", `/api/tasks/${t.id}/comments`, { body: "à moi" })).body as { id: string };
    await api("u_alice", "PUT", "/api/org/members/u_theo/permissions", { overrides: { "tasks.comment": false } });
    expect((await api("u_theo", "PATCH", `/api/comments/${c.id}`, { body: "changé" })).status).toBe(403);
    expect((await api("u_theo", "DELETE", `/api/comments/${c.id}`)).status).toBe(403);
  });
});

describe("R-04 : un administrateur n'agit pas sur un autre administrateur", () => {
  async function twoAdmins() {
    await start();
    await api("u_alice", "PUT", "/api/org/members/u_theo", { role: "admin" });
    await api("u_alice", "PUT", "/api/org/members/u_ines", { role: "admin" });
  }
  it("ni retrait, ni changement de profil, ni exception", async () => {
    await twoAdmins();
    expect((await api("u_theo", "PUT", "/api/org/members/u_ines", { role: null })).status).toBe(403);
    expect((await api("u_theo", "PUT", "/api/org/members/u_ines", { role: "member" })).status).toBe(403);
    expect((await api("u_theo", "PUT", "/api/org/members/u_ines/profile", { profile_id: (await profile("Membre")).id })).status).toBe(403);
    expect((await api("u_theo", "PUT", "/api/org/members/u_ines/permissions", { overrides: { "tasks.create": false } })).status).toBe(403);
  });
  it("le propriétaire garde la main, et un administrateur agit sur un membre", async () => {
    await twoAdmins();
    expect((await api("u_theo", "PUT", "/api/org/members/u_hugo", { role: "guest" })).status).toBe(200);
    expect((await api("u_alice", "PUT", "/api/org/members/u_ines", { role: "member" })).status).toBe(200);
  });
});

describe("R-05 : un projet archivé est en lecture seule", () => {
  async function archived() {
    await start();
    const p = (await api("u_alice", "POST", "/api/projects", { name: "Ancien" })).body as { id: string; name: string };
    const t = (await api("u_alice", "POST", "/api/tasks", { project_id: p.id, title: "T" })).body as { id: string };
    await api("u_alice", "PATCH", `/api/projects/${p.id}`, { archived: true });
    return { p, t };
  }
  it("refuse les écritures et garde la lecture", async () => {
    const { p, t } = await archived();
    expect((await api("u_alice", "POST", "/api/tasks", { project_id: p.id, title: "U" })).status).toBe(409);
    expect((await api("u_alice", "PATCH", `/api/tasks/${t.id}`, { title: "V" })).status).toBe(409);
    expect((await api("u_alice", "POST", `/api/tasks/${t.id}/comments`, { body: "x" })).status).toBe(409);
    expect((await api("u_alice", "PATCH", `/api/projects/${p.id}`, { description: "x" })).status).toBe(409);
    expect((await api("u_alice", "GET", `/api/tasks/${t.id}`)).status).toBe(200);
  });
  it("permet de restaurer ou de supprimer", async () => {
    const { p } = await archived();
    expect((await api("u_alice", "PATCH", `/api/projects/${p.id}`, { archived: false })).status).toBe(200);
    expect((await api("u_alice", "POST", "/api/tasks", { project_id: p.id, title: "U" })).status).toBe(200);
    await api("u_alice", "PATCH", `/api/projects/${p.id}`, { archived: true });
    expect((await api("u_alice", "DELETE", `/api/projects/${p.id}`, { confirm: p.name })).status).toBe(200);
  });
});

describe("R-06 et S-06 : règles IA", () => {
  const ruleRuns = async (ruleId: string) => (await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM ai_runs WHERE rule_id = $1", [ruleId]))!.n;
  const rule = async (extra: Record<string, unknown> = {}) => (await api("u_alice", "POST", `/api/projects/${await appId()}/ai/rules`, { name: "R", trigger: "task_created", agent_id: "ai_atlas", instructions: "x", ...extra })).body as { id: string };

  it("une règle s'arrête si sa créatrice perd le droit de déléguer", async () => {
    await start();
    await api("u_alice", "PUT", "/api/org/members/u_ines", { role: "admin" });
    await api("u_alice", "PUT", `/api/projects/${await appId()}/members/u_ines`, { role: "admin" });
    const r = (await api("u_ines", "POST", `/api/projects/${await appId()}/ai/rules`, { name: "R", trigger: "task_created", agent_id: "ai_atlas", instructions: "x" })).body as { id: string };
    await newTask(); await wait(300);
    expect(await ruleRuns(r.id)).toBe(1);
    await api("u_alice", "PUT", "/api/org/members/u_ines/permissions", { overrides: { "ai.delegate": false } });
    await newTask(); await wait(300);
    expect(await ruleRuns(r.id)).toBe(1);
  });
  it("une règle est plafonnée par heure", async () => {
    await start();
    const r = await rule();
    const run = await ctx.db.one<{ org_id: string }>("SELECT org_id FROM projects WHERE id = $1", [await appId()]);
    await ctx.db.query("INSERT INTO ai_runs (id, org_id, agent_id, kind, status, provider, rule_id) SELECT 'r' || g, $1, 'ai_atlas', 'rule', 'done', 'demo', $2 FROM generate_series(1, 30) g", [run!.org_id, r.id]);
    await newTask(); await wait(300);
    expect(await ruleRuns(r.id)).toBe(30);
  });
  it("la validation automatique ne couvre jamais la modification d'une tâche", async () => {
    let target = "";
    const provider = {
      name: "stub",
      async turn({ messages }: { messages: { content: unknown }[] }) {
        const last = messages[messages.length - 1].content;
        if (Array.isArray(last) && last.some((b: { type: string }) => b.type === "tool_result")) return { stop_reason: "end_turn", content: [{ type: "text", text: "fini" }] };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "update_task", input: { task: target, title: "Réécrit" } }] };
      },
    };
    await start(provider as never);
    const victim = await newTask(); target = victim.key;
    await rule({ auto_approve: true, trigger: "task_created" });
    await newTask(); await wait(500);
    expect((await api("u_alice", "GET", `/api/tasks/${victim.id}`)).body.title).toBe("T");
    expect((await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM ai_approvals WHERE tool = 'update_task' AND status = 'pending'"))!.n).toBeGreaterThan(0);
  });
});

describe("R-07 : profil système Lecture seule", () => {
  it("existe partout, ne s'efface pas, et n'autorise aucune écriture", async () => {
    await start();
    const p = await profile("Lecture seule");
    expect(p).toMatchObject({ is_system: true, permissions: [] });
    expect((await api("u_alice", "DELETE", `/api/org/profiles/${p.id}`)).status).toBe(400);
    await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: p.id });
    expect((await api("u_theo", "POST", "/api/projects", { name: "X" })).status).toBe(403);
    const created = (await api("u_alice", "POST", "/api/orgs", { name: "Nouvelle" })).body as { id: string };
    expect(await ctx.db.one("SELECT 1 FROM access_profiles WHERE org_id = $1 AND name = 'Lecture seule' AND is_system", [created.id])).toBeTruthy();
  });
});

describe("T-05 et R-08 : identifiants cohérents", () => {
  it("un déplacement ignore une tâche voisine d'un autre projet", async () => {
    await start();
    const own = (await api("u_alice", "POST", "/api/projects", { name: "Autre" })).body as { id: string; sections: { id: string }[] };
    const mine = (await api("u_alice", "POST", "/api/tasks", { project_id: own.id, title: "M" })).body as { id: string };
    const foreign = await newTask();
    await ctx.db.query("UPDATE tasks SET position = 987654 WHERE id = $1", [foreign.id]);
    const moved = await api("u_alice", "POST", `/api/tasks/${mine.id}/move`, { section_id: own.sections[1].id, after_id: foreign.id });
    expect(moved.status).toBe(200);
    expect(Number(moved.body.position)).not.toBe(987654 + 1024);
  });
  it("une règle ne se supprime que par l'adresse de son projet", async () => {
    await start();
    const r = (await api("u_alice", "POST", `/api/projects/${await appId()}/ai/rules`, { name: "R", trigger: "task_moved", agent_id: "ai_atlas", instructions: "x" })).body as { id: string };
    const other = (await api("u_alice", "POST", "/api/projects", { name: "Autre" })).body as { id: string };
    expect((await api("u_alice", "DELETE", `/api/projects/${other.id}/ai/rules/${r.id}`)).status).toBe(404);
    expect((await api("u_alice", "DELETE", `/api/projects/${await appId()}/ai/rules/${r.id}`)).status).toBe(200);
  });
});

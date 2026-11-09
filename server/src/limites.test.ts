import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};
const cookieOf = (res: { headers: Record<string, unknown> }) => String(([] as unknown[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0];
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function api(who: string | null, method: Method, url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: who ? { cookie: cookies[who] ?? who } : {} });
  let body = null; try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body, headers: res.headers };
}
async function start(limits?: AppOptions["limits"], users = ["u_alice", "u_karim"]) {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0, limits });
  for (const u of users) cookies[u] = cookieOf(await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: u } }));
}
const orgId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const appId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE '%Application mobile%'"))!.id;
const chat = () => api("u_alice", "POST", "/api/ai/chat", { messages: [{ role: "user", content: "x" }] });
afterEach(async () => { await ctx.app.close(); });

describe("A-02 : limites de débit et quotas", () => {
  it("limite les anonymes", async () => {
    await start({ anonymousPerMinute: 3 });
    const all = []; for (let i = 0; i < 5; i++) all.push((await api(null, "GET", "/api/me")).status);
    expect(all).toEqual([401, 401, 401, 429, 429]);
  });
  it("limite une session sans gêner les autres", async () => {
    await start({ sessionPerMinute: 2 });
    const all = []; for (let i = 0; i < 3; i++) all.push((await api("u_alice", "GET", "/api/me")).status);
    expect(all).toEqual([200, 200, 429]);
    expect((await api("u_karim", "GET", "/api/me")).status).toBe(200);
  });
  it("limite les appels à l'IA par personne", async () => {
    await start({ aiPerMinute: 2 });
    expect([(await chat()).status, (await chat()).status, (await chat()).status]).toEqual([200, 200, 429]);
  });
  it("plafonne les exécutions IA par organisation", async () => {
    await start({ aiRunsPerHour: 3 });
    const org = await orgId();
    await ctx.db.query("INSERT INTO ai_runs (id, org_id, agent_id, kind, status, provider) SELECT 'r' || g, $1, 'ai_cadence', 'assistant', 'done', 'demo' FROM generate_series(1, 3) g", [org]);
    const r = await chat();
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/quota/i);
  });
  it("plafonne les invitations par organisation", async () => {
    await start({ invitationsPerHour: 2 });
    const profile = (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { name: string }) => p.name === "Membre").id;
    const send = async (n: number) => (await api("u_alice", "POST", "/api/org/invitations", { email: `p${n}@x.test`, name: "P", profile_id: profile })).status;
    expect([await send(1), await send(2), await send(3)]).toEqual([200, 200, 429]);
  });
  it("plafonne les connexions temps réel d'une personne", async () => {
    await start({ ssePerUser: 1 });
    const addr = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const ctl = new AbortController();
    const first = await fetch(`${addr}/api/events`, { headers: { cookie: cookies.u_alice }, signal: ctl.signal });
    expect(first.status).toBe(200);
    expect((await fetch(`${addr}/api/events`, { headers: { cookie: cookies.u_alice } })).status).toBe(429);
    ctl.abort();
    await new Promise((r) => setTimeout(r, 100));
    const again = new AbortController();
    expect((await fetch(`${addr}/api/events`, { headers: { cookie: cookies.u_alice }, signal: again.signal })).status).toBe(200);
    again.abort();
  });
});

describe("T-04 : pas de repli silencieux sur une autre organisation", () => {
  async function removedFromActiveOrg() {
    await start();
    const created = await api("u_alice", "POST", "/api/orgs", { name: "Org C" });
    await ctx.svc.addOrgMember(created.body.id, "u_karim", "owner");
    const sw = await api("u_karim", "POST", `/api/orgs/${created.body.id}/switch`);
    const stale = `${cookies.u_karim}; ${cookieOf(sw)}`;
    await ctx.db.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = 'u_karim'", [created.body.id]);
    return stale;
  }
  it("refuse l'écriture et efface l'organisation périmée", async () => {
    const stale = await removedFromActiveOrg();
    const before = (await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM teams"))!.n;
    const r = await api(stale, "POST", "/api/teams", { name: "Mauvais tenant" });
    expect(r.status).toBe(409);
    expect(String(r.headers["set-cookie"])).toMatch(/cadence_org=;/);
    expect((await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM teams"))!.n).toBe(before);
  });
  it("laisse lire le profil pour que l'interface se rétablisse", async () => {
    const stale = await removedFromActiveOrg();
    expect((await api(stale, "GET", "/api/me")).status).toBe(200);
  });
  it("une personne hors organisation ne rattache pas un inconnu à une entité", async () => {
    await start();
    expect((await api("u_alice", "PUT", "/api/org/members/inconnu/unit", { unit_id: null })).status).toBe(404);
  });
});

describe("T-03 : la base protège les frontières entre organisations", () => {
  async function other() {
    await start();
    const org = (await api("u_alice", "POST", "/api/orgs", { name: "Z" })).body.id as string;
    await ctx.db.query("INSERT INTO projects (id, org_id, key, name, owner_id) VALUES ('prj_z', $1, 'ZZ', 'Z', 'u_alice')", [org]);
    await ctx.db.query("INSERT INTO sections (id, project_id, name, position) VALUES ('sec_z', 'prj_z', 's', 1)");
    await ctx.db.query("INSERT INTO teams (id, org_id, name) VALUES ('tem_z', $1, 'Z')", [org]);
    return org;
  }
  const refused = async (sql: string, params: unknown[] = []) => { await expect(ctx.db.query(sql, params)).rejects.toThrow(); };

  it("renseigne l'organisation sans faire confiance à l'appelant", async () => {
    const org = await other();
    expect((await ctx.db.one<{ org_id: string }>("SELECT org_id FROM sections WHERE id = 'sec_z'"))!.org_id).toBe(org);
    await ctx.db.query("INSERT INTO sections (id, project_id, name, position, org_id) VALUES ('sec_y', 'prj_z', 'y', 2, $1)", [await orgId()]);
    expect((await ctx.db.one<{ org_id: string }>("SELECT org_id FROM sections WHERE id = 'sec_y'"))!.org_id).toBe(org);
  });
  it("refuse une tâche dans la section d'une autre organisation", async () => {
    await other();
    const t = (await ctx.db.one<{ id: string }>("SELECT id FROM tasks WHERE project_id = $1 LIMIT 1", [await appId()]))!.id;
    await refused("UPDATE tasks SET section_id = 'sec_z' WHERE id = $1", [t]);
  });
  it("refuse un projet rattaché à l'équipe d'une autre organisation", async () => {
    await other();
    await refused("UPDATE projects SET team_id = 'tem_z' WHERE id = $1", [await appId()]);
  });
  it("refuse une sous-tâche sous une tâche d'une autre organisation", async () => {
    await other();
    const t = (await ctx.db.one<{ id: string }>("SELECT id FROM tasks WHERE project_id = $1 LIMIT 1", [await appId()]))!.id;
    await refused("INSERT INTO tasks (id, number, project_id, section_id, parent_id, title, creator_id, position) VALUES ('t_z', 1, 'prj_z', 'sec_z', $1, 'x', 'u_alice', 1)", [t]);
  });
  it("garde le fonctionnement normal : déplacement et suppression", async () => {
    await start();
    const app = await appId();
    const p = (await api("u_alice", "POST", "/api/projects", { name: "Cible" })).body as { id: string; name: string };
    const t = (await api("u_alice", "POST", "/api/tasks", { project_id: app, title: "Mobile" })).body as { id: string };
    await api("u_alice", "POST", `/api/tasks/${t.id}/comments`, { body: "Conservé" });
    expect((await api("u_alice", "POST", `/api/tasks/${t.id}/move-project`, { project_id: p.id })).status).toBe(200);
    expect((await api("u_alice", "GET", `/api/tasks/${t.id}`)).body.comments).toHaveLength(1);
    expect((await api("u_alice", "DELETE", `/api/projects/${p.id}`, { confirm: p.name })).status).toBe(200);
  });
});

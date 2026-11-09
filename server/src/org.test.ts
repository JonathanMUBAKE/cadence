import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};
const orgCookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
  delete orgCookies[user];
}
async function api(user: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const cookie = [cookies[user], orgCookies[user]].filter(Boolean).join("; ");
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie } });
  const set = res.headers["set-cookie"];
  if (set)
    for (const c of ([] as string[]).concat(set)) if (c.startsWith("cadence_org=")) orgCookies[user] = c.split(";")[0];
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const one = async <T>(sql: string, p: unknown[] = []) => (await ctx.db.one<T>(sql, p))!;
const unitId = async (name: string) =>
  (await one<{ id: string }>("SELECT id FROM org_units WHERE name = $1", [name])).id;
const teamId = async (name: string) => (await one<{ id: string }>("SELECT id FROM teams WHERE name = $1", [name])).id;
const projectByKey = async (key: string) =>
  (await one<{ id: string }>("SELECT id FROM projects WHERE key = $1", [key])).id;

beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_hugo", "u_theo", "u_chloe"]) await login(u);
});
afterEach(async () => {
  await ctx.app.close();
});

describe("hiérarchie des entités", () => {
  it("renvoie l'organigramme en profondeur, dans l'ordre", async () => {
    const units = (await api("u_alice", "GET", "/api/org/units")).body as { name: string; depth: number }[];
    expect(units[0]).toMatchObject({ name: "Nova Mobile", depth: 0 });
    const inge = units.findIndex((u) => u.name === "Ingénierie");
    expect(units[inge].depth).toBe(2);
    expect(units.slice(inge + 1, inge + 3).map((u) => u.name)).toEqual(["Mobile", "Qualité"]);
  });
  it("refuse de placer une entité sous l'une de ses descendantes", async () => {
    const res = await api("u_alice", "PATCH", `/api/units/${await unitId("Ingénierie")}`, {
      parent_id: await unitId("Mobile"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/propres sous-entités/);
  });
  it("refuse de supprimer une entité non vide, accepte une entité vide", async () => {
    const res = await api("u_alice", "DELETE", `/api/units/${await unitId("Ingénierie")}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 sous-entité/);
    const { id } = (
      await api("u_alice", "POST", "/api/org/units", {
        name: "Data",
        kind: "Service",
        parent_id: await unitId("Ingénierie"),
      })
    ).body;
    expect((await api("u_alice", "DELETE", `/api/units/${id}`)).status).toBe(200);
  });
  it("seul un administrateur modifie l'organigramme", async () => {
    expect((await api("u_karim", "POST", "/api/org/units", { name: "Pirate" })).status).toBe(403);
  });
});

describe("droits effectifs en cascade", () => {
  it("le responsable d'une entité voit les projets de sa branche, sauf ceux d'une équipe privée", async () => {
    const team = await teamId("Équipe Mobile");
    await api("u_karim", "PATCH", `/api/teams/${team}`, { visibility: "request" });
    const p = (await api("u_karim", "POST", "/api/projects", { name: "Outils internes", key: "TOOL", team_id: team }))
      .body;
    expect((await api("u_hugo", "GET", `/api/projects/${p.id}`)).status).toBe(403);
    await api("u_alice", "PATCH", `/api/units/${await unitId("Ingénierie")}`, { manager_id: "u_hugo" });
    const seen = await api("u_hugo", "GET", `/api/projects/${p.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.role).toBe("viewer");
    await api("u_karim", "PATCH", `/api/teams/${team}`, { visibility: "private" });
    expect((await api("u_hugo", "GET", `/api/projects/${p.id}`)).status).toBe(403);
  });
  it("les membres d'une équipe deviennent éditeurs de ses projets, le chef d'équipe administrateur", async () => {
    const team = await teamId("Équipe Mobile");
    const p = (await api("u_karim", "POST", "/api/projects", { name: "Outils internes", key: "TOOL", team_id: team }))
      .body;
    expect((await api("u_theo", "GET", `/api/projects/${p.id}`)).body.role).toBe("editor");
    await api("u_alice", "PUT", `/api/projects/${p.id}/members/u_karim`, { role: null });
    expect((await api("u_karim", "GET", `/api/projects/${p.id}`)).body.role).toBe("admin");
  });
  it("un projet à accès privé n'est visible que de ses membres explicites", async () => {
    const team = await teamId("Équipe Mobile");
    const p = (
      await api("u_karim", "POST", "/api/projects", {
        name: "Confidentiel",
        key: "SECRET",
        team_id: team,
        access: "private",
      })
    ).body;
    expect((await api("u_theo", "GET", `/api/projects/${p.id}`)).status).toBe(403);
  });
  it("demande d'adhésion à une équipe « sur demande » puis accès au projet après acceptation", async () => {
    const marketing = await teamId("Marketing");
    const camp = await projectByKey("CAMP");
    expect((await api("u_karim", "GET", `/api/projects/${camp}`)).status).toBe(403);
    expect((await api("u_karim", "POST", `/api/teams/${marketing}/join`)).body.result).toBe("requested");
    const notifs = (await api("u_hugo", "GET", "/api/notifications")).body as { kind: string }[];
    expect(notifs.some((n) => n.kind === "team.request")).toBe(true);
    const team = (await api("u_hugo", "GET", `/api/teams/${marketing}`)).body;
    expect(team.requests).toHaveLength(1);
    await api("u_hugo", "POST", `/api/team-requests/${team.requests[0].id}`, { approve: true });
    expect((await api("u_karim", "GET", `/api/projects/${camp}`)).body.role).toBe("editor");
  });
  it("une équipe privée est invisible et non rejoignable pour les non-membres", async () => {
    const rh = await teamId("RH");
    expect(((await api("u_karim", "GET", "/api/teams")).body as { name: string }[]).map((t) => t.name)).not.toContain(
      "RH",
    );
    expect((await api("u_karim", "POST", `/api/teams/${rh}/join`)).status).toBe(403);
  });
});

describe("organisations multiples", () => {
  it("cloisonne les données entre organisations", async () => {
    const idv = await projectByKey("IDV");
    expect((await api("u_karim", "GET", `/api/projects/${idv}`)).status).toBe(403);
    const me = (await api("u_alice", "GET", "/api/me")).body;
    expect(me.orgs.map((o: { name: string }) => o.name)).toEqual(["Nova Mobile", "Studio Lumen"]);
    expect(((await api("u_alice", "GET", "/api/projects")).body as { key: string }[]).map((p) => p.key)).not.toContain(
      "IDV",
    );
    expect((await api("u_alice", "GET", "/api/search?q=Moodboard")).body.tasks).toHaveLength(0);
    const studio = me.orgs.find((o: { name: string }) => o.name === "Studio Lumen").id;
    await api("u_alice", "POST", `/api/orgs/${studio}/switch`);
    expect(((await api("u_alice", "GET", "/api/projects")).body as { key: string }[]).map((p) => p.key)).toEqual([
      "IDV",
    ]);
    expect((await api("u_alice", "GET", "/api/search?q=Moodboard")).body.tasks).toHaveLength(1);
    expect(((await api("u_alice", "GET", "/api/users")).body as { id: string }[]).map((u) => u.id).sort()).toEqual([
      "u_alice",
      "u_hugo",
    ]);
  });
  it("on ne peut pas basculer vers une organisation dont on n'est pas membre", async () => {
    const studio = (await one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Studio Lumen'")).id;
    expect((await api("u_karim", "POST", `/api/orgs/${studio}/switch`)).status).toBe(403);
  });
  it("un invité n'accède qu'aux projets partagés explicitement", async () => {
    const studio = (await one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Studio Lumen'")).id;
    await api("u_hugo", "POST", `/api/orgs/${studio}/switch`);
    await ctx.svc.addOrgMember(studio, "u_theo", "guest");
    const idv = await projectByKey("IDV");
    expect((await api("u_theo", "GET", `/api/projects/${idv}`)).status).toBe(403);
    await api("u_hugo", "PUT", `/api/projects/${idv}/members/u_theo`, { role: "commenter" });
    expect((await api("u_theo", "GET", `/api/projects/${idv}`)).body.role).toBe("commenter");
  });
  it("empêche de retirer le dernier propriétaire", async () => {
    const res = await api("u_alice", "PUT", "/api/org/members/u_alice", { role: "member" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dernier propriétaire/);
  });
});

describe("clés de projet et numérotation", () => {
  it("numérote les tâches par projet et les retrouve par clé", async () => {
    const t = (
      await api("u_alice", "POST", "/api/tasks", { project_id: await projectByKey("WEB"), title: "Nouvelle page" })
    ).body;
    expect(t.key).toBe("WEB-6");
    expect((await api("u_alice", "GET", "/api/tasks/WEB-6")).body.title).toBe("Nouvelle page");
  });
  it("refuse une clé déjà prise ou mal formée et en propose une automatiquement", async () => {
    expect((await api("u_alice", "POST", "/api/projects", { name: "Doublon", key: "APP" })).status).toBe(400);
    expect((await api("u_alice", "POST", "/api/projects", { name: "Mauvais", key: "1A" })).status).toBe(400);
    const auto = (await api("u_alice", "POST", "/api/projects", { name: "Programme Fidélité" })).body;
    expect(auto.key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
  });
  it("attribue des numéros uniques à des créations simultanées", async () => {
    const pid = await projectByKey("WEB");
    const created = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => api("u_alice", "POST", "/api/tasks", { project_id: pid, title: `Parallèle ${i}` })),
    );
    const keys = created.map((c) => c.body.key);
    expect(new Set(keys).size).toBe(5);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
}
const put = async (user: string, url: string, payload: unknown) => {
  const res = await ctx.app.inject({
    method: "PUT",
    url,
    payload: payload as never,
    headers: { cookie: cookies[user] },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const orgId = async () =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;

describe("sécurité de l'organisation et de la connexion", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    for (const u of ["u_alice", "u_karim", "u_hugo"]) await login(u);
    await put("u_alice", "/api/org/members/u_karim", { role: "owner" });
    await put("u_alice", "/api/org/members/u_hugo", { role: "admin" });
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("un administrateur ne peut ni rétrograder ni retirer un propriétaire", async () => {
    const org = await orgId();
    for (const role of ["member", "admin", null]) {
      const res = await put("u_hugo", "/api/org/members/u_karim", { role });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/propriétaire/);
    }
    expect(await ctx.svc.orgRole("u_karim", org)).toBe("owner");
  });

  it("un propriétaire peut rétrograder un autre propriétaire, jamais le dernier", async () => {
    const org = await orgId();
    expect((await put("u_alice", "/api/org/members/u_karim", { role: "member" })).status).toBe(200);
    expect(await ctx.svc.orgRole("u_karim", org)).toBe("member");
    expect((await put("u_alice", "/api/org/members/u_alice", { role: "member" })).status).toBe(400);
  });

  it("la liste des profils de connexion n'expose aucune donnée personnelle", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/users" });
    expect(res.statusCode).toBe(200);
    const users = JSON.parse(res.body) as Record<string, unknown>[];
    expect(users.find((u) => u.id === "u_alice")).toMatchObject({ name: "Alice Martin", title: "Head of Product" });
    for (const u of users) {
      expect(u).not.toHaveProperty("email");
      expect(u).not.toHaveProperty("ai_instructions");
    }
  });
});

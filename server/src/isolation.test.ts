import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { startupProblems } from "./secrets.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const GOOD = "cheval-agrafe-batterie-42";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const INFO = { ip: "1.1.1.1", userAgent: "test" };
const VICTIM = "directrice@client.test";
const cookies: Record<string, string> = {};

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(([] as unknown[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0];
async function demo(user: string) {
  cookies[user] = cookieOf(
    await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } }),
  );
}
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function api(who: string | null, method: Method, url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    payload: payload as never,
    headers: who ? { cookie: cookies[who] ?? who } : {},
  });
  let body = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers };
}
const login = (email: string, password: string) => api(null, "POST", "/api/auth/login", { email, password });
const tokenOf = (text: string) => new URLSearchParams(/#token=[\w-]+/.exec(text)![0].slice(1)).get("token")!;
const orgId = async () =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const projectId = async (name: string) =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const profileId = async (name: string) =>
  (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { name: string }) => p.name === name).id as string;
const memberRole = async (email: string, org: string) =>
  (
    await ctx.db.one<{ role: string }>(
      "SELECT om.role FROM org_members om JOIN users u ON u.id = om.user_id WHERE lower(u.email) = $1 AND om.org_id = $2",
      [email, org],
    )
  )?.role;
async function otherOrg() {
  const b = await api("u_hugo", "POST", "/api/orgs", { name: "Autre organisation" });
  cookies.other = `${cookies.u_hugo}; ${cookieOf(b)}`;
  await ctx.db.query("DELETE FROM org_members WHERE user_id = 'u_hugo' AND org_id = $1", [await orgId()]);
  return b.body.id as string;
}
const inviteFromA = async (email = VICTIM, profile = "Membre") =>
  api("u_alice", "POST", "/api/org/invitations", { email, name: "Directrice", profile_id: await profileId(profile) });
const inviteFromB = (org: string, email = VICTIM) =>
  api("other", "POST", "/api/org/invitations", { email, name: "Directrice", profile_id: `prf_member_${org}` });
/** Une plateforme avec SMTP : on capture ce qui partirait dans la boîte du titulaire. */
function withPlatformMail() {
  vi.stubEnv("SMTP_URL", "smtp://plateforme.test");
  return vi.spyOn(ctx.provisioning as never, "deliver").mockResolvedValue(true as never) as unknown as {
    mock: { calls: string[][] };
  };
}
const mailTo = (spy: { mock: { calls: string[][] } }, email = VICTIM) =>
  spy.mock.calls.filter((c) => c[0] === email).at(-1)!;
function setup(users = ["u_alice", "u_karim", "u_theo", "u_hugo", "u_ines"]) {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    for (const u of users) await demo(u);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await ctx.app.close();
  });
}

describe("A-01 : anonymes refusés avant la lecture du corps", () => {
  setup([]);
  it("répond 401 sans attendre la fin de l'envoi", async () => {
    const addr = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = new URL(addr);
    const status = await new Promise<number | null>((resolve) => {
      const q = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/tasks/x/attachments?name=a.txt",
          method: "POST",
          headers: { "content-type": "application/octet-stream", "content-length": 20 * 1024 * 1024 },
        },
        (res) => {
          resolve(res.statusCode ?? null);
          res.resume();
        },
      );
      q.on("error", () => undefined);
      q.write(Buffer.alloc(1024));
      setTimeout(() => {
        resolve(null);
        q.destroy();
      }, 1500);
    });
    expect(status).toBe(401);
    expect((ctx.app.server.address() as AddressInfo).port).toBeGreaterThan(0);
  });
});

describe("R-01 : un rôle explicite plafonne les droits venus d'une équipe", () => {
  setup();
  async function teamProject() {
    const team = (await api("u_alice", "POST", "/api/teams", { name: "Publique", visibility: "public" })).body as {
      id: string;
    };
    const project = (
      await api("u_alice", "POST", "/api/projects", { name: "Projet d'équipe", team_id: team.id, access: "team" })
    ).body as { id: string };
    await ctx.db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id <> 'u_alice'", [team.id]);
    return { team, project };
  }
  const roleOn = async (who: string, id: string) => (await api(who, "GET", `/api/projects/${id}`)).body.role as string;

  it("un lecteur explicite qui rejoint l'équipe reste lecteur", async () => {
    const { team, project } = await teamProject();
    await api("u_alice", "PUT", `/api/projects/${project.id}/members/u_hugo`, { role: "viewer" });
    expect((await api("u_hugo", "POST", `/api/teams/${team.id}/join`)).body).toEqual({ result: "joined" });
    expect((await api("u_hugo", "POST", "/api/tasks", { project_id: project.id, title: "x" })).status).toBe(403);
    expect(await roleOn("u_hugo", project.id)).toBe("viewer");
  });

  it("un responsable d'équipe limité explicitement sur un projet est plafonné", async () => {
    const { team, project } = await teamProject();
    await api("u_alice", "PUT", `/api/teams/${team.id}/members/u_theo`, { role: "lead" });
    expect(await roleOn("u_theo", project.id)).toBe("admin");
    await api("u_alice", "PUT", `/api/projects/${project.id}/members/u_theo`, { role: "commenter" });
    expect(await roleOn("u_theo", project.id)).toBe("commenter");
  });

  it("un membre d'équipe sans rôle explicite garde les droits de l'équipe", async () => {
    const { team, project } = await teamProject();
    await api("u_hugo", "POST", `/api/teams/${team.id}/join`);
    expect(await roleOn("u_hugo", project.id)).toBe("editor");
  });

  it("un administrateur d'organisation n'est pas plafonné", async () => {
    const { project } = await teamProject();
    await api("u_alice", "PUT", "/api/org/members/u_ines", { role: "admin" });
    await api("u_alice", "PUT", `/api/projects/${project.id}/members/u_ines`, { role: "viewer" });
    expect(await roleOn("u_ines", project.id)).toBe("admin");
  });

  it("rejoindre une équipe exige le droit teams.join", async () => {
    const { team } = await teamProject();
    const p = (
      await api("u_alice", "POST", "/api/org/profiles", {
        name: "Sans aucun droit",
        base_role: "member",
        permissions: [],
      })
    ).body;
    await api("u_alice", "PUT", "/api/org/members/u_hugo/profile", { profile_id: p.id });
    const refused = await api("u_hugo", "POST", `/api/teams/${team.id}/join`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/profil/);
    await api("u_alice", "PUT", "/api/org/members/u_hugo/permissions", { overrides: { "teams.join": true } });
    expect((await api("u_hugo", "POST", `/api/teams/${team.id}/join`)).status).toBe(200);
  });
});

describe("T-01 : une invitation ne donne rien sans l'accord du titulaire", () => {
  setup();

  it("le lien part vers le titulaire et n'est jamais montré à l'organisation", async () => {
    const spy = withPlatformMail();
    const send = vi.spyOn(ctx.mail, "send");
    const r = await inviteFromA();
    expect(r.body.sent).toBe(true);
    expect(r.body.link).toBeUndefined();
    expect(mailTo(spy)[2]).toContain("#token=");
    expect(send).not.toHaveBeenCalled();
  });

  it("le scénario de pré-appropriation échoue", async () => {
    const spy = withPlatformMail();
    const orgB = await otherOrg();
    const fromB = await inviteFromB(orgB);
    expect(fromB.body.link).toBeUndefined();
    expect((await inviteFromA(VICTIM, "Administrateur")).body.link).toBeUndefined();
    const org = await orgId();
    expect(await memberRole(VICTIM, org)).toBeUndefined();
    // Seule la titulaire reçoit les liens : elle active celui de l'organisation A
    expect(
      (await api(null, "POST", "/api/auth/activate", { token: tokenOf(mailTo(spy)[2]), password: GOOD })).status,
    ).toBe(200);
    expect(await memberRole(VICTIM, org)).toBe("admin");
    expect(await memberRole(VICTIM, orgB)).toBeUndefined();
  });

  it("une invitation de plus reste en attente après l'activation, jusqu'à son acceptation", async () => {
    const spy = withPlatformMail();
    const orgB = await otherOrg();
    await inviteFromB(orgB);
    const firstLink = mailTo(spy)[2];
    await inviteFromA();
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(firstLink), password: GOOD })).status).toBe(
      200,
    );
    const c = cookieOf(await login(VICTIM, GOOD));
    const pending = (await api(c, "GET", "/api/invitations")).body as { id: string; org_name: string }[];
    expect(pending.map((i) => i.org_name)).toEqual(["Nova Mobile"]);
    expect(await memberRole(VICTIM, await orgId())).toBeUndefined();
    expect((await api(c, "POST", `/api/invitations/${pending[0].id}/accept`)).status).toBe(200);
    expect(await memberRole(VICTIM, await orgId())).toBe("member");
    expect((await api(c, "GET", "/api/invitations")).body).toEqual([]);
  });

  it("un compte actif est prévenu, mais rien n'est rattaché sans son accord", async () => {
    const spy = withPlatformMail();
    const orgB = await otherOrg();
    const r = await inviteFromB(orgB, "karim@cadence.app");
    expect(r.status).toBe(200);
    expect(await memberRole("karim@cadence.app", orgB)).toBeUndefined();
    expect(mailTo(spy, "karim@cadence.app")[2]).not.toContain("#token=");
    await demo("u_karim");
    expect(
      (await api("u_karim", "GET", "/api/notifications")).body.some((n: { kind: string }) => n.kind === "org.invite"),
    ).toBe(true);
    const [inv] = (await api("u_karim", "GET", "/api/invitations")).body as { id: string }[];
    expect((await api("u_karim", "POST", `/api/invitations/${inv.id}/decline`)).status).toBe(200);
    expect(await memberRole("karim@cadence.app", orgB)).toBeUndefined();
    expect((await api("u_karim", "POST", `/api/invitations/${inv.id}/accept`)).status).toBe(404);
  });

  it("seul le titulaire de l'adresse peut accepter", async () => {
    withPlatformMail();
    const orgB = await otherOrg();
    const id = (await inviteFromB(orgB, "karim@cadence.app")).body.invitation_id as string;
    expect((await api("u_theo", "POST", `/api/invitations/${id}/accept`)).status).toBe(404);
    expect((await api("other", "POST", `/api/invitations/${id}/accept`)).status).toBe(404);
    expect(await memberRole("karim@cadence.app", orgB)).toBeUndefined();
    expect((await api("u_karim", "POST", `/api/invitations/${id}/accept`)).status).toBe(200);
    expect((await api("u_karim", "POST", `/api/invitations/${id}/accept`)).status).toBe(404);
    expect(await memberRole("karim@cadence.app", orgB)).toBe("member");
  });

  it("une invitation annulée ou expirée ne s'accepte plus", async () => {
    withPlatformMail();
    const orgB = await otherOrg();
    const id = (await inviteFromB(orgB, "karim@cadence.app")).body.invitation_id as string;
    await ctx.db.query("UPDATE org_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect((await api("u_karim", "GET", "/api/invitations")).body).toEqual([]);
    expect((await api("u_karim", "POST", `/api/invitations/${id}/accept`)).status).toBe(404);
    await ctx.db.query("UPDATE org_invitations SET expires_at = now() + interval '1 hour' WHERE id = $1", [id]);
    await api("other", "DELETE", `/api/org/invitations/${id}`);
    expect((await api("u_karim", "POST", `/api/invitations/${id}/accept`)).status).toBe(404);
  });

  it("la réponse ne révèle pas si un compte existe", async () => {
    withPlatformMail();
    const orgB = await otherOrg();
    await ctx.db.query("UPDATE users SET platform_role = 'super_admin' WHERE id = 'u_alice'");
    await ctx.provisioning.suspend("u_alice", "u_ines", INFO);
    const shape = async (email: string) => {
      const { invitation_id: _i, ...rest } = (await inviteFromB(orgB, email)).body;
      void _i;
      return rest;
    };
    const [unknown, active, suspended] = [
      await shape("inconnu@client.test"),
      await shape("karim@cadence.app"),
      await shape("ines@cadence.app"),
    ];
    expect(active).toEqual(unknown);
    expect(suspended).toEqual(unknown);
  });

  it("refuse une seconde invitation en attente pour la même adresse", async () => {
    withPlatformMail();
    await inviteFromA();
    expect((await inviteFromA()).status).toBe(400);
  });

  it("exige le SMTP de la plateforme dès que le serveur n'est plus local", () => {
    const base = { PUBLIC_URL: "https://c.test" };
    expect(startupProblems(base, { host: "0.0.0.0", databaseUrl: false })).toEqual([expect.stringMatching(/SMTP_URL/)]);
    expect(startupProblems({ ...base, SMTP_URL: "smtps://x" }, { host: "0.0.0.0", databaseUrl: false })).toEqual([]);
    expect(startupProblems({}, { host: "127.0.0.1", databaseUrl: false })).toEqual([]);
  });
});

describe("T-02 : une organisation n'agit pas sur un compte qui ne lui appartient pas", () => {
  setup();

  it("l'ancienne route de rôle n'ajoute personne", async () => {
    const orgB = await otherOrg();
    const r = await api("other", "PUT", "/api/org/members/u_karim", { role: "guest" });
    expect(r.status).toBe(404);
    expect(await ctx.svc.orgRole("u_karim", orgB)).toBeNull();
    expect(
      (await api("other", "GET", "/api/users")).body.some((u: { email: string }) => u.email === "karim@cadence.app"),
    ).toBe(false);
  });

  it("un coéquipier IA d'une autre organisation ne se rattache pas", async () => {
    const orgB = await otherOrg();
    expect((await api("other", "PUT", "/api/org/members/ai_atlas", { role: "member" })).status).toBe(404);
    expect(await ctx.svc.orgRole("ai_atlas", orgB)).toBeNull();
    expect((await api("other", "PUT", "/api/users/ai_atlas/avatar", { data_url: PNG })).status).toBe(403);
  });

  it("une photo humaine ne se change que par son titulaire, même par un administrateur", async () => {
    expect((await api("u_karim", "PUT", "/api/users/u_karim/avatar", { data_url: PNG })).status).toBe(200);
    expect((await api("u_alice", "DELETE", "/api/users/u_karim/avatar")).status).toBe(403);
    expect((await api("u_alice", "PUT", "/api/users/u_karim/avatar", { data_url: PNG })).status).toBe(403);
    expect((await api("u_karim", "DELETE", "/api/users/u_karim/avatar")).status).toBe(200);
  });

  it("l'administrateur garde la main sur la photo des coéquipiers IA de son organisation", async () => {
    expect((await api("u_alice", "PUT", "/api/users/ai_atlas/avatar", { data_url: PNG })).status).toBe(200);
    expect((await api("u_karim", "PUT", "/api/users/ai_atlas/avatar", { data_url: PNG })).status).toBe(403);
  });

  it("un membre existant change toujours de rôle", async () => {
    expect((await api("u_alice", "PUT", "/api/org/members/u_theo", { role: "guest" })).status).toBe(200);
    expect(await ctx.svc.orgRole("u_theo", await orgId())).toBe("guest");
    void projectId;
  });
});

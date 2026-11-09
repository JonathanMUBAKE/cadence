import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { totpCode } from "./auth/totp.js";
import { hashPassword, verifyPassword, passwordProblem } from "./auth/password.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const GOOD = "cheval-agrafe-batterie-42";
const cookies: Record<string, string> = {};

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(([] as unknown[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0];
async function demo(user: string) {
  cookies[user] = cookieOf(
    await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } }),
  );
}
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function api(
  who: string | null,
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await ctx.app.inject({
    method,
    url,
    payload: payload as never,
    headers: { ...(who ? { cookie: cookies[who] ?? who } : {}), ...headers },
  });
  let body = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers, res };
}
const login = (email: string, password: string) => api(null, "POST", "/api/auth/login", { email, password });
const tokenOf = (link: string) => new URLSearchParams(new URL(link, "http://x").hash.slice(1)).get("token")!;
const orgId = async () =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const projectId = async (name: string) =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const profileId = async (name: string) =>
  (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { name: string }) => p.name === name).id as string;

async function invite(email = "nadia@exemple.test", profile?: string) {
  const r = await api("u_alice", "POST", "/api/org/invitations", {
    email,
    name: "Nadia Keita",
    profile_id: profile ?? (await profileId("Membre")),
  });
  expect(r.status).toBe(200);
  return r.body as { invitation_id: string; sent: boolean; link: string };
}
const userIdOf = async (email: string) =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]))!.id;
async function activated(email = "nadia@exemple.test", profile?: string) {
  const i = await invite(email, profile);
  expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(200);
  const l = await login(email, GOOD);
  expect(l.status).toBe(200);
  cookies[email] = cookieOf(l);
  return userIdOf(email);
}

describe("mots de passe", () => {
  it("hache avec un sel unique et vérifie", async () => {
    const [a, b] = [await hashPassword(GOOD), await hashPassword(GOOD)];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword("autre-mot-de-passe-long", a)).toBe(false);
  });
  it("applique une politique fondée sur la longueur et les mots de passe courants", () => {
    expect(passwordProblem("court", {})).toMatch(/12/);
    expect(passwordProblem("motdepasse123456", {})).toMatch(/courant/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", {})).toMatch(/courant/);
    expect(passwordProblem("nadia.keita.2026!", { email: "nadia.keita@x.test" })).toMatch(/adresse/);
    expect(passwordProblem(GOOD, { email: "n@x.test", name: "Nadia" })).toBeNull();
  });
});

describe("connexion", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    await demo("u_alice");
    await demo("u_karim");
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("n'expose jamais les secrets d'un compte", async () => {
    await activated();
    for (const url of ["/api/users", "/api/me"])
      expect(JSON.stringify((await api("u_alice", "GET", url)).body)).not.toMatch(
        /password_hash|totp_secret|recovery_codes/,
      );
  });

  it("répond à l'identique pour une adresse inconnue et un mauvais mot de passe", async () => {
    await activated();
    const [a, b] = [
      await login("nadia@exemple.test", "mauvais-mot-de-passe"),
      await login("personne@exemple.test", "mauvais-mot-de-passe"),
    ];
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it("verrouille le compte après plusieurs échecs, même avec le bon mot de passe ensuite", async () => {
    await activated();
    for (let i = 0; i < 5; i++) await login("nadia@exemple.test", "mauvais-mot-de-passe");
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(401);
    await ctx.db.query(
      "UPDATE users SET locked_until = now() - interval '1 minute' WHERE email = 'nadia@exemple.test'",
    );
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(200);
  });

  it("limite les essais par adresse IP", async () => {
    await ctx.db.query(
      "INSERT INTO login_attempts (id, email, ip, success) SELECT 'x' || g, 'e' || g, '127.0.0.1', FALSE FROM generate_series(1, 40) g",
    );
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(429);
  });

  it("pose un cookie de session opaque, inaccessible au JavaScript, et ne stocke que son empreinte", async () => {
    await activated();
    const l = await login("nadia@exemple.test", GOOD);
    const raw = String(([] as unknown[]).concat(l.headers["set-cookie"])[0]);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    const token = raw.split(";")[0].split("=")[1];
    expect(await ctx.db.one("SELECT 1 FROM sessions WHERE id = $1", [token])).toBeUndefined();
  });

  it("déconnecte réellement : la session révoquée ne sert plus", async () => {
    await activated();
    const c = cookies["nadia@exemple.test"];
    expect((await api(c, "GET", "/api/me")).status).toBe(200);
    await api(c, "POST", "/api/auth/logout");
    expect((await api(c, "GET", "/api/me")).status).toBe(401);
  });

  it("une session expirée ou inactive trop longtemps ne sert plus", async () => {
    await activated();
    const c = cookies["nadia@exemple.test"];
    await ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '8 days'");
    expect((await api(c, "GET", "/api/me")).status).toBe(401);
  });

  it("liste ses sessions et en révoque une autre", async () => {
    await activated();
    const other = cookieOf(await login("nadia@exemple.test", GOOD));
    const list = (await api(other, "GET", "/api/auth/sessions")).body as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    await api(other, "DELETE", `/api/auth/sessions/${list.find((s) => !s.current)!.id}`);
    expect((await api(cookies["nadia@exemple.test"], "GET", "/api/me")).status).toBe(401);
    expect((await api(other, "GET", "/api/me")).status).toBe(200);
  });

  it("changer son mot de passe exige l'actuel et ferme les autres sessions", async () => {
    await activated();
    const other = cookieOf(await login("nadia@exemple.test", GOOD));
    const c = cookies["nadia@exemple.test"];
    expect(
      (
        await api(c, "POST", "/api/auth/password", {
          current: "faux-mot-de-passe-12",
          password: "nouveau-mot-de-passe-solide",
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(c, "POST", "/api/auth/password", { current: GOOD, password: "nouveau-mot-de-passe-solide" })).status,
    ).toBe(200);
    expect((await api(other, "GET", "/api/me")).status).toBe(401);
    expect((await api(c, "GET", "/api/me")).status).toBe(200);
  });

  it("réinitialise par lien à usage unique, sans révéler si l'adresse existe", async () => {
    await activated();
    const c = cookies["nadia@exemple.test"];
    const [a, b] = [
      await api(null, "POST", "/api/auth/forgot", { email: "nadia@exemple.test" }),
      await api(null, "POST", "/api/auth/forgot", { email: "inconnu@exemple.test" }),
    ];
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(JSON.stringify(a.body)).not.toMatch(/token/);
    const u = (await ctx.db.one<{ id: string }>("SELECT id FROM users WHERE email = 'nadia@exemple.test'"))!;
    const link = (await ctx.provisioning.resetLink(u.id)).link;
    const body = { token: tokenOf(link), password: "encore-un-nouveau-mot-de-passe" };
    expect((await api(null, "POST", "/api/auth/reset", body)).status).toBe(200);
    expect((await api(null, "POST", "/api/auth/reset", body)).status).toBe(400);
    expect((await api(c, "GET", "/api/me")).status).toBe(401);
    expect((await login("nadia@exemple.test", "encore-un-nouveau-mot-de-passe")).status).toBe(200);
  });

  it("refuse une origine étrangère et pose les en-têtes de sécurité", async () => {
    const bad = await api(
      "u_alice",
      "POST",
      "/api/tasks",
      { project_id: "x", title: "T" },
      { origin: "https://pirate.example", host: "localhost:4000" },
    );
    expect(bad.status).toBe(403);
    const ok = await api("u_alice", "GET", "/api/me");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(ok.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("politique de sécurité du contenu", () => {
  it("autorise le script de thème, même avec des fins de ligne Windows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-csp-"));
    const script = "\n  console.log(1);\n";
    writeFileSync(join(dir, "index.html"), `<!doctype html>\r\n<script>${script.replace(/\n/g, "\r\n")}</script>\r\n`);
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0, webDist: dir });
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/login" });
      expect(String(res.headers["content-security-policy"])).toContain(
        `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
      );
    } finally {
      await ctx.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mode démo", () => {
  afterEach(async () => {
    await ctx.app.close();
  });
  it("sans mode démo, ni liste des profils ni connexion sans mot de passe", async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0, demoLogin: false });
    expect((await api(null, "GET", "/api/auth/users")).status).toBe(404);
    expect((await api(null, "POST", "/api/auth/login", { user_id: "u_alice" })).status).toBe(400);
    expect((await api(null, "GET", "/api/auth/config")).body).toMatchObject({ demo: false, registration: "invite" });
  });
});

describe("invitations", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    await demo("u_alice");
    await demo("u_karim");
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("seule une personne autorisée invite ; le lien sert une fois et l'accès suit", async () => {
    expect(
      (
        await api("u_karim", "POST", "/api/org/invitations", {
          email: "a@b.test",
          name: "A",
          profile_id: await profileId("Membre"),
        })
      ).status,
    ).toBe(403);
    const i = await invite();
    expect(i.sent).toBe(false);
    expect((await api(null, "POST", "/api/auth/token", { token: tokenOf(i.link) })).body).toMatchObject({
      kind: "invite",
      email: "nadia@exemple.test",
    });
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(401);
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: "court" })).status).toBe(
      400,
    );
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(
      200,
    );
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(
      400,
    );
    const c = cookieOf(await login("nadia@exemple.test", GOOD));
    expect((await api(c, "GET", "/api/me")).body.orgs[0].name).toBe("Nova Mobile");
  });

  it("une invitation expirée ne sert plus, et l'empreinte seule est stockée", async () => {
    const i = await invite();
    expect(await ctx.db.one("SELECT 1 FROM auth_tokens WHERE token_hash = $1", [tokenOf(i.link)])).toBeUndefined();
    await ctx.db.query("UPDATE auth_tokens SET expires_at = now() - interval '1 hour'");
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(
      400,
    );
  });

  it("annule une invitation en attente", async () => {
    const i = await invite();
    expect((await api("u_alice", "GET", "/api/org/invitations")).body).toHaveLength(1);
    const id = await userIdOf("nadia@exemple.test");
    await api("u_alice", "DELETE", `/api/org/invitations/${i.invitation_id}`);
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(
      400,
    );
    expect(await ctx.db.one("SELECT 1 FROM users WHERE id = $1", [id])).toBeUndefined();
  });
});

describe("double authentification", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    await demo("u_alice");
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  async function enroll() {
    await activated();
    const c = cookies["nadia@exemple.test"];
    const setup = (await api(c, "POST", "/api/auth/mfa/setup")).body as { secret: string; qr: string; uri: string };
    expect(setup.uri).toContain("otpauth://totp/");
    expect(setup.qr).toMatch(/^data:image\/png/);
    expect((await api(c, "POST", "/api/auth/mfa/confirm", { code: "000000" })).status).toBe(400);
    const done = await api(c, "POST", "/api/auth/mfa/confirm", { code: totpCode(setup.secret) });
    expect(done.status).toBe(200);
    expect(done.body.recovery_codes).toHaveLength(10);
    return { secret: setup.secret, recovery: done.body.recovery_codes as string[], cookie: c };
  }

  it("exige le code après le mot de passe, et la session reste inutilisable avant", async () => {
    const { secret } = await enroll();
    await ctx.db.query("UPDATE users SET totp_last_step = NULL WHERE email = 'nadia@exemple.test'");
    const step1 = await login("nadia@exemple.test", GOOD);
    expect(step1.body).toEqual({ status: "mfa" });
    const pending = cookieOf(step1);
    expect((await api(pending, "GET", "/api/me")).status).toBe(401);
    expect((await api(pending, "POST", "/api/auth/mfa", { code: "123456" })).status).toBe(401);
    expect((await api(pending, "POST", "/api/auth/mfa", { code: totpCode(secret) })).status).toBe(200);
    expect((await api(pending, "GET", "/api/me")).status).toBe(200);
  });

  it("refuse de réutiliser un même code", async () => {
    const { secret } = await enroll();
    await ctx.db.query("UPDATE users SET totp_last_step = NULL WHERE email = 'nadia@exemple.test'");
    const code = totpCode(secret);
    expect(
      (await api(cookieOf(await login("nadia@exemple.test", GOOD)), "POST", "/api/auth/mfa", { code })).status,
    ).toBe(200);
    expect(
      (await api(cookieOf(await login("nadia@exemple.test", GOOD)), "POST", "/api/auth/mfa", { code })).status,
    ).toBe(401);
  });

  it("un code de secours sert une seule fois", async () => {
    const { recovery } = await enroll();
    expect(
      (await api(cookieOf(await login("nadia@exemple.test", GOOD)), "POST", "/api/auth/mfa", { code: recovery[0] }))
        .status,
    ).toBe(200);
    expect(
      (await api(cookieOf(await login("nadia@exemple.test", GOOD)), "POST", "/api/auth/mfa", { code: recovery[0] }))
        .status,
    ).toBe(401);
  });

  it("trop d'essais ferment l'étape de vérification", async () => {
    await enroll();
    const p = cookieOf(await login("nadia@exemple.test", GOOD));
    for (let i = 0; i < 5; i++) await api(p, "POST", "/api/auth/mfa", { code: "000000" });
    expect((await api(p, "POST", "/api/auth/mfa", { code: "000000" })).status).toBe(401);
    expect(await ctx.db.one("SELECT 1 FROM sessions WHERE mfa_pending AND revoked_at IS NULL")).toBeUndefined();
  });

  it("désactiver la double authentification exige le mot de passe", async () => {
    const { cookie, secret } = await enroll();
    expect(
      (await api(cookie, "POST", "/api/auth/mfa/disable", { password: "faux-mot-de-passe-12", code: totpCode(secret) }))
        .status,
    ).toBe(400);
    expect(
      (await api(cookie, "POST", "/api/auth/mfa/disable", { password: GOOD, code: totpCode(secret) })).status,
    ).toBe(200);
    expect((await login("nadia@exemple.test", GOOD)).body).toMatchObject({ status: "ok" });
  });
});

describe("administrateur système", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    await demo("u_alice");
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  async function superAdmin() {
    const link = await ctx.provisioning.bootstrapLink();
    expect(link).toBeTruthy();
    const res = await api(null, "POST", "/api/auth/activate", {
      token: tokenOf(link!),
      password: GOOD,
      name: "Admin Système",
      email: "root@exemple.test",
    });
    expect(res.status).toBe(200);
    const c = cookieOf(await login("root@exemple.test", GOOD));
    cookies.root = c;
    return c;
  }

  it("ne se crée qu'une fois, et personne d'autre n'accède à la console", async () => {
    await superAdmin();
    expect(await ctx.provisioning.bootstrapLink()).toBeNull();
    expect((await api("root", "GET", "/api/admin/users")).status).toBe(200);
    expect((await api("u_alice", "GET", "/api/admin/users")).status).toBe(403);
    expect((await api(null, "GET", "/api/admin/users")).status).toBe(401);
  });

  it("le propriétaire d'une organisation n'a aucun droit sur la plateforme", async () => {
    expect((await api("u_alice", "PATCH", "/api/admin/settings", { registration: "approval" })).status).toBe(403);
  });

  it("hors mode démo, seul l'administrateur système crée des organisations", async () => {
    await ctx.app.close();
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0, demoLogin: false, seed: false });
    const c = await superAdmin();
    const created = await api(c, "POST", "/api/orgs", { name: "Première organisation" });
    expect(created.status).toBe(200);
    const i = await api(
      c,
      "POST",
      "/api/org/invitations",
      { email: "n@x.test", name: "Nadia", profile_id: `prf_member_${created.body.id}` },
      { cookie: `${c}; ${cookieOf(created)}` },
    );
    expect(i.status).toBe(200);
    await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.body.link), password: GOOD });
    expect(
      (await api(cookieOf(await login("n@x.test", GOOD)), "POST", "/api/orgs", { name: "Interdite" })).status,
    ).toBe(403);
  });

  it("les demandes d'accès sont fermées par défaut", async () => {
    expect((await api(null, "POST", "/api/auth/request-access", { name: "X", email: "x@y.test" })).status).toBe(403);
  });

  it("une demande d'accès ne donne rien avant validation, puis passe par une invitation", async () => {
    await superAdmin();
    await api("root", "PATCH", "/api/admin/settings", { registration: "approval" });
    expect((await api(null, "GET", "/api/auth/config")).body.registration).toBe("approval");
    expect(
      (
        await api(null, "POST", "/api/auth/request-access", {
          name: "Sara Diallo",
          email: "sara@exemple.test",
          note: "Équipe Mobile",
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(null, "POST", "/api/auth/request-access", { name: "Autre", email: "sara@exemple.test" })).status,
    ).toBe(200);
    expect((await login("sara@exemple.test", GOOD)).status).toBe(401);
    const users = (await api("root", "GET", "/api/admin/users")).body as {
      id: string;
      email: string;
      status: string;
      name: string;
    }[];
    const sara = users.find((u) => u.email === "sara@exemple.test")!;
    expect(sara).toMatchObject({ status: "pending", name: "Sara Diallo" });
    const org = await orgId();
    const approved = await api("root", "POST", `/api/admin/users/${sara.id}/approve`, {
      org_id: org,
      profile_id: `prf_member_${org}`,
    });
    expect(approved.status).toBe(200);
    await api(null, "POST", "/api/auth/activate", { token: tokenOf(approved.body.link), password: GOOD });
    const c = cookieOf(await login("sara@exemple.test", GOOD));
    expect((await api(c, "GET", "/api/me")).body.orgs.map((o: { id: string }) => o.id)).toEqual([org]);
  });

  it("une demande refusée reste sans accès", async () => {
    await superAdmin();
    await api("root", "PATCH", "/api/admin/settings", { registration: "approval" });
    await api(null, "POST", "/api/auth/request-access", { name: "Sara", email: "sara@exemple.test" });
    const sara = (await api("root", "GET", "/api/admin/users")).body.find(
      (u: { email: string }) => u.email === "sara@exemple.test",
    );
    await api("root", "POST", `/api/admin/users/${sara.id}/reject`);
    expect((await ctx.db.one<{ status: string }>("SELECT status FROM users WHERE id = $1", [sara.id]))!.status).toBe(
      "rejected",
    );
  });

  it("suspendre coupe immédiatement l'accès, et le dernier administrateur est protégé", async () => {
    await superAdmin();
    const id = await activated();
    const c = cookies["nadia@exemple.test"];
    expect((await api("root", "POST", `/api/admin/users/${id}/suspend`)).status).toBe(200);
    expect((await api(c, "GET", "/api/me")).status).toBe(401);
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(401);
    await api("root", "POST", `/api/admin/users/${id}/reactivate`);
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(200);
    const me = (await api("root", "GET", "/api/me")).body;
    expect((await api("root", "POST", `/api/admin/users/${me.id}/suspend`)).status).toBe(400);
    expect((await api("root", "PUT", `/api/admin/users/${me.id}/platform-role`, { super_admin: false })).status).toBe(
      400,
    );
  });

  it("garde une trace des événements de sécurité", async () => {
    await superAdmin();
    await login("root@exemple.test", "mauvais-mot-de-passe");
    const kinds = (await api("root", "GET", "/api/admin/events")).body.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["login.failed", "login.success", "account.activated"]));
  });
});

describe("profils et droits à cocher", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    for (const u of ["u_alice", "u_karim", "u_theo", "u_hugo"]) await demo(u);
  });
  afterEach(async () => {
    await ctx.app.close();
  });
  const task = async (who: string, pid: string, title = "T") =>
    api(who, "POST", "/api/tasks", { project_id: pid, title });

  it("expose le catalogue des droits et les profils système", async () => {
    const groups = (await api("u_alice", "GET", "/api/org/permissions")).body as {
      group: string;
      items: { key: string; label: string }[];
    }[];
    expect(groups.flatMap((g) => g.items.map((i) => i.key))).toEqual(
      expect.arrayContaining(["tasks.delete", "projects.create", "org.profiles"]),
    );
    expect((await api("u_alice", "GET", "/api/org/profiles")).body.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(["Propriétaire", "Administrateur", "Membre", "Invité"]),
    );
    expect((await api("u_karim", "GET", "/api/org/profiles")).status).toBe(403);
  });

  it("crée un profil et y affecte quelqu'un : ses droits suivent immédiatement", async () => {
    const pid = await projectId("Application mobile");
    const profile = (
      await api("u_alice", "POST", "/api/org/profiles", {
        name: "Lecture et commentaires",
        description: "",
        base_role: "member",
        permissions: ["tasks.comment"],
      })
    ).body;
    expect((await task("u_theo", pid)).status).toBe(200);
    expect((await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: profile.id })).status).toBe(
      200,
    );
    const denied = await task("u_theo", pid);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/profil/);
    const t = (await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body[0];
    expect((await api("u_theo", "POST", `/api/tasks/${t.id}/comments`, { body: "Autorisé" })).status).toBe(200);
    expect((await api("u_theo", "GET", "/api/me")).body.permissions).toEqual(["tasks.comment"]);
  });

  it("décocher un droit du profil s'applique à toutes les personnes concernées", async () => {
    const pid = await projectId("Application mobile");
    const id = await profileId("Membre");
    const current = (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { id: string }) => p.id === id);
    expect(
      (
        await api("u_alice", "PATCH", `/api/org/profiles/${id}`, {
          permissions: current.permissions.filter((p: string) => p !== "tasks.create"),
        })
      ).status,
    ).toBe(200);
    expect((await task("u_theo", pid)).status).toBe(403);
  });

  it("retire un droit à une seule personne, sans changer son profil, même administrateur d'un projet", async () => {
    const pid = await projectId("Application mobile");
    const mine = (await task("u_karim", pid)).body;
    await api("u_alice", "PUT", "/api/org/members/u_karim/permissions", { overrides: { "tasks.delete": false } });
    const r = await api("u_karim", "DELETE", `/api/tasks/${mine.id}`);
    expect(r.status).toBe(403);
    expect((await task("u_karim", pid)).status).toBe(200);
    const access = (await api("u_alice", "GET", "/api/org/members/u_karim/access")).body;
    expect(access.overrides).toEqual({ "tasks.delete": false });
    expect(access.effective).not.toContain("tasks.delete");
    await api("u_alice", "PUT", "/api/org/members/u_karim/permissions", { overrides: { "tasks.delete": null } });
    expect((await api("u_karim", "DELETE", `/api/tasks/${mine.id}`)).status).toBe(200);
  });

  it("accorde un droit d'administration précis sans donner tout le rôle", async () => {
    expect((await api("u_karim", "GET", "/api/org/invitations")).status).toBe(403);
    await api("u_alice", "PUT", "/api/org/members/u_karim/permissions", { overrides: { "org.members": true } });
    expect((await api("u_karim", "GET", "/api/org/invitations")).status).toBe(200);
    expect((await api("u_karim", "GET", "/api/org/profiles")).status).toBe(403);
  });

  it("empêche de se donner, ou de donner, plus que ses propres droits", async () => {
    await api("u_alice", "PUT", "/api/org/members/u_karim/permissions", {
      overrides: { "org.members": true, "org.profiles": true },
    });
    const member = await profileId("Membre"),
      admin = await profileId("Administrateur"),
      owner = await profileId("Propriétaire");
    expect(
      (await api("u_karim", "PUT", "/api/org/members/u_karim/permissions", { overrides: { "org.mail": true } })).status,
    ).toBe(403);
    expect((await api("u_karim", "PUT", "/api/org/members/u_theo/profile", { profile_id: admin })).status).toBe(403);
    expect((await api("u_karim", "PUT", "/api/org/members/u_karim/profile", { profile_id: owner })).status).toBe(403);
    expect(
      (
        await api("u_karim", "POST", "/api/org/profiles", {
          name: "Trop",
          description: "",
          base_role: "member",
          permissions: ["org.mail"],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("u_karim", "POST", "/api/org/profiles", {
          name: "Égal",
          description: "",
          base_role: "admin",
          permissions: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("u_karim", "PUT", "/api/org/members/u_alice/permissions", { overrides: { "tasks.create": false } }))
        .status,
    ).toBe(403);
    expect((await api("u_karim", "PUT", "/api/org/members/u_theo/profile", { profile_id: member })).status).toBe(200);
  });

  it("protège le profil Propriétaire et les profils utilisés", async () => {
    const owner = await profileId("Propriétaire");
    expect((await api("u_alice", "PATCH", `/api/org/profiles/${owner}`, { permissions: [] })).status).toBe(400);
    expect((await api("u_alice", "DELETE", `/api/org/profiles/${await profileId("Membre")}`)).status).toBe(400);
    const p = (
      await api("u_alice", "POST", "/api/org/profiles", {
        name: "Temporaire",
        description: "",
        base_role: "member",
        permissions: [],
      })
    ).body;
    await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: p.id });
    expect((await api("u_alice", "DELETE", `/api/org/profiles/${p.id}`)).status).toBe(400);
    await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: await profileId("Membre") });
    expect((await api("u_alice", "DELETE", `/api/org/profiles/${p.id}`)).status).toBe(200);
  });

  it("refuse un droit inconnu et un profil d'une autre organisation", async () => {
    expect(
      (
        await api("u_alice", "POST", "/api/org/profiles", {
          name: "X",
          description: "",
          base_role: "member",
          permissions: ["inconnu.droit"],
        })
      ).status,
    ).toBe(400);
    const other = (await api("u_alice", "POST", "/api/orgs", { name: "Autre" })).body as { id: string };
    await demo("u_alice");
    expect(
      (await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: `prf_member_${other.id}` })).status,
    ).toBe(400);
  });

  it("les coéquipiers IA restent gouvernés par leur rôle sur le projet", async () => {
    const pid = await projectId("Application mobile");
    await expect(
      ctx.ai.tools.execute({ actorId: "ai_atlas", orgId: await orgId() }, "create_task", {
        project_id: pid,
        title: "Par Atlas",
      }),
    ).resolves.toBeTruthy();
  });

  it("une action IA de l'assistant respecte le profil de la personne", async () => {
    const id = await profileId("Membre");
    const current = (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { id: string }) => p.id === id);
    await api("u_alice", "PATCH", `/api/org/profiles/${id}`, {
      permissions: current.permissions.filter((p: string) => p !== "ai.assistant"),
    });
    expect(
      (await api("u_theo", "POST", "/api/ai/chat", { messages: [{ role: "user", content: "Bonjour" }] })).status,
    ).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { assertPublicHost } from "./net-guard.js";
import { seal, open } from "./crypto.js";
import { startupProblems, sslOptions } from "./secrets.js";
import { totpCode } from "./auth/totp.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const GOOD = "cheval-agrafe-batterie-42",
  NEW = "licorne-tournevis-fanfare-77",
  EMAIL = "nadia@exemple.test";
const cookies: Record<string, string> = {};
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(([] as unknown[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0];
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
const tokenOf = (link: string) => new URLSearchParams(new URL(link, "http://x").hash.slice(1)).get("token")!;
const appId = async () =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE '%Application mobile%'"))!.id;
const userId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM users WHERE email = $1", [EMAIL]))!.id;
async function activated() {
  const profile = (await api("u_alice", "GET", "/api/org/profiles")).body.find(
    (p: { name: string }) => p.name === "Membre",
  ).id;
  const i = await api("u_alice", "POST", "/api/org/invitations", { email: EMAIL, name: "Nadia", profile_id: profile });
  await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.body.link), password: GOOD });
  cookies.nadia = cookieOf(await login(EMAIL, GOOD));
}
async function enroll() {
  await activated();
  const s = (await api("nadia", "POST", "/api/auth/mfa/setup")).body as { secret: string };
  const done = await api("nadia", "POST", "/api/auth/mfa/confirm", { code: totpCode(s.secret) });
  await ctx.db.query("UPDATE users SET totp_last_step = NULL WHERE email = $1", [EMAIL]);
  return { secret: s.secret, recovery: done.body.recovery_codes as string[] };
}
beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim"])
    cookies[u] = cookieOf(await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: u } }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await ctx.app.close();
});

describe("S-04 et S-12 : liens de réinitialisation", () => {
  it("un ancien lien ne sert plus après un changement de mot de passe", async () => {
    await activated();
    const { link } = await ctx.provisioning.resetLink(await userId());
    await api("nadia", "POST", "/api/auth/password", { current: GOOD, password: NEW });
    expect(
      (await api(null, "POST", "/api/auth/reset", { token: tokenOf(link), password: "pelican-brouette-orage-93" }))
        .status,
    ).toBe(400);
  });
  it("répond sans attendre l'envoi de l'e-mail", async () => {
    await activated();
    let sent = false;
    vi.spyOn(ctx.provisioning as never, "deliver").mockImplementation(
      (() =>
        new Promise((r) =>
          setTimeout(() => {
            sent = true;
            r(true);
          }, 400),
        )) as never,
    );
    expect((await api(null, "POST", "/api/auth/forgot", { email: EMAIL })).status).toBe(200);
    expect(sent).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect(sent).toBe(true);
  });
});

describe("S-05 : une consommation unique", () => {
  it("un code de secours ne sert qu'une fois, même en simultané", async () => {
    const { recovery } = await enroll();
    const [a, b] = [cookieOf(await login(EMAIL, GOOD)), cookieOf(await login(EMAIL, GOOD))];
    const all = await Promise.all([a, b].map((c) => api(c, "POST", "/api/auth/mfa", { code: recovery[0] })));
    expect(all.map((r) => r.status).sort()).toEqual([200, 401]);
  });
  it("les codes de secours sont longs et propres à chaque compte", async () => {
    const { recovery } = await enroll();
    expect(recovery[0]).toHaveLength(20);
    const row = await ctx.db.one<{ recovery_codes: string[] }>("SELECT recovery_codes FROM users WHERE email = $1", [
      EMAIL,
    ]);
    expect(row!.recovery_codes).not.toContain(recovery[0]);
  });
});

describe("S-07 : double authentification des administrateurs", () => {
  it("sans 2FA, les droits d'administration sont refusés et l'interface le sait", async () => {
    ctx.svc.requireAdminMfa = true;
    const refused = await api("u_alice", "GET", "/api/org/profiles");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/double authentification/);
    expect((await api("u_alice", "GET", "/api/me")).body.mfa_required).toBe(true);
    expect((await api("u_alice", "GET", "/api/teams")).status).toBe(200);
    await ctx.db.query("UPDATE users SET totp_enabled = TRUE WHERE id = 'u_alice'");
    expect((await api("u_alice", "GET", "/api/org/profiles")).status).toBe(200);
    expect((await api("u_alice", "GET", "/api/me")).body.mfa_required).toBe(false);
  });
  it("l'administrateur système y est soumis aussi", async () => {
    ctx.svc.requireAdminMfa = true;
    await ctx.db.query("UPDATE users SET platform_role = 'super_admin' WHERE id = 'u_karim'");
    expect((await api("u_karim", "GET", "/api/admin/users")).status).toBe(403);
  });
  it("un membre simple n'y est pas soumis", async () => {
    ctx.svc.requireAdminMfa = true;
    expect((await api("u_karim", "GET", "/api/me")).body.mfa_required).toBe(false);
  });
  it("ne s'applique qu'à un serveur en HTTPS, pas à un usage local", async () => {
    const [local, secured] = [
      await buildApp({ provider: "demo", demoLogin: false, seed: false }),
      await buildApp({ provider: "demo", demoLogin: false, seed: false, publicUrl: "https://cadence.test" }),
    ];
    expect([local.svc.requireAdminMfa, secured.svc.requireAdminMfa]).toEqual([false, true]);
    await local.app.close();
    await secured.app.close();
  });
  it("désactiver la 2FA exige aussi un code", async () => {
    const { secret } = await enroll();
    expect((await api("nadia", "POST", "/api/auth/mfa/disable", { password: GOOD, code: "000000" })).status).toBe(400);
    expect((await api("nadia", "POST", "/api/auth/mfa/disable", { password: GOOD })).status).toBe(400);
    expect(
      (await api("nadia", "POST", "/api/auth/mfa/disable", { password: GOOD, code: totpCode(secret) })).status,
    ).toBe(200);
  });
});

describe("S-01 : accès au réseau interne", () => {
  it("reconnaît les adresses internes", async () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      await expect(assertPublicHost(host), host).rejects.toThrow(/interne/);
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });
  it("refuse un SMTP interne sur un serveur exposé", async () => {
    ctx.mail.blockPrivateHosts = true;
    expect(
      (
        await api("u_alice", "PUT", "/api/org/mail", {
          domain: "nova.test",
          smtp: { host: "127.0.0.1", port: 25, security: "none" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("S-02 et S-03 : transport chiffré", () => {
  const ok = { COOKIE_SECRET: "x".repeat(32), CADENCE_SECRET_KEY: "x".repeat(32), SMTP_URL: "smtps://x" };
  it("exige HTTPS pour un serveur exposé", () => {
    expect(startupProblems({ ...ok, PUBLIC_URL: "http://c.test" }, { host: "0.0.0.0", databaseUrl: false })).toEqual([
      expect.stringMatching(/https/i),
    ]);
    expect(startupProblems({ ...ok, PUBLIC_URL: "https://c.test" }, { host: "0.0.0.0", databaseUrl: false })).toEqual(
      [],
    );
  });
  it("vérifie le certificat de la base dès qu'il est fourni", () => {
    expect(sslOptions("postgres://db.supabase.co/x", "-----BEGIN CERTIFICATE-----")).toEqual({
      ca: "-----BEGIN CERTIFICATE-----",
      rejectUnauthorized: true,
    });
    expect(sslOptions("postgres://localhost/x", undefined)).toBeUndefined();
  });
  it("exige le certificat de Supabase en production", () => {
    const env = {
      ...ok,
      NODE_ENV: "production",
      PUBLIC_URL: "https://c.test",
      DATABASE_URL: "postgres://db.supabase.co/x",
    };
    expect(startupProblems(env, { host: "127.0.0.1", databaseUrl: true })).toEqual([
      expect.stringMatching(/DATABASE_CA_CERT/),
    ]);
    expect(startupProblems({ ...env, DATABASE_CA_CERT: "x" }, { host: "127.0.0.1", databaseUrl: true })).toEqual([]);
  });
});

describe("S-08 et S-09 : entrées hostiles", () => {
  it("borne les champs libres", async () => {
    const id = await appId();
    expect((await api("u_alice", "PATCH", `/api/projects/${id}`, { color: "x".repeat(5000) })).status).toBe(400);
    expect(
      (
        await api("u_alice", "POST", `/api/projects/${id}/updates`, {
          status: "on_track",
          headline: "x".repeat(5000),
          summary: "",
          risks: [],
          next_steps: [],
        })
      ).status,
    ).toBe(400);
    expect((await api("u_alice", "GET", `/api/search?q=${"a".repeat(500)}`)).status).toBe(400);
    expect((await api("u_alice", "PATCH", "/api/org", { domains: Array(50).fill("a.test") })).status).toBe(400);
  });
  it("répond 400 ou 404, jamais 500, aux caractères et nombres impossibles", async () => {
    const id = await appId();
    expect((await api("u_alice", "POST", "/api/tasks", { project_id: id, title: "a\u0000b" })).status).toBe(400);
    expect((await api("u_alice", "GET", "/api/search?q=a%00b")).status).toBe(400);
    expect((await api("u_alice", "GET", "/api/tasks/a%00b")).status).toBe(400);
    expect((await api("u_alice", "GET", "/api/tasks/99999999999999999999")).status).toBe(404);
    expect((await api("u_alice", "GET", "/api/tasks/APP-99999999999999999999")).status).toBe(404);
  });
  it("traite % et _ comme du texte dans la recherche", async () => {
    expect((await api("u_alice", "GET", "/api/search?q=%25")).body.tasks).toHaveLength(0);
    await api("u_alice", "POST", "/api/tasks", { project_id: await appId(), title: "Remise de 50% accordée" });
    expect((await api("u_alice", "GET", "/api/search?q=50%25")).body.tasks).toHaveLength(1);
  });
});

describe("S-10 et S-11 : secrets et journaux", () => {
  it("chiffre au format versionné et relit l'ancien format de la clé courante", () => {
    expect(seal("x").startsWith("v2:")).toBe(true);
    expect(open(seal("mot de passe"))).toBe("mot de passe");
  });
  it("purge ce qui a dépassé sa durée de conservation", async () => {
    await ctx.db.query(
      "INSERT INTO login_attempts (id, email, ip, success, created_at) VALUES ('old', 'a', '1', FALSE, now() - interval '40 days'), ('new', 'a', '1', FALSE, now())",
    );
    await ctx.db.query(
      "INSERT INTO security_events (id, kind, created_at) VALUES ('old', 'x', now() - interval '400 days'), ('new', 'x', now())",
    );
    await ctx.auth.purge();
    expect((await ctx.db.query<{ id: string }>("SELECT id FROM login_attempts")).map((r) => r.id)).toEqual(["new"]);
    expect(
      (await ctx.db.query<{ id: string }>("SELECT id FROM security_events WHERE id IN ('old', 'new')")).map(
        (r) => r.id,
      ),
    ).toEqual(["new"]);
  });
  it("masque l'adresse saisie dans le journal des échecs", async () => {
    await login("personne@exemple.test", "mauvais-mot-de-passe");
    const row = await ctx.db.one<{ data: { email: string } }>(
      "SELECT data FROM security_events WHERE kind = 'login.failed' ORDER BY created_at DESC LIMIT 1",
    );
    expect(row!.data.email).toBe("p***@exemple.test");
  });
});

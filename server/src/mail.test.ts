import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import { buildApp } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
let smtp: SMTPServer;
let smtpPort = 0;
const inbox: { from: string; to: string[]; raw: string; user?: string }[] = [];
const cookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
}
async function api(user: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[user] } });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body || "null") : res.rawPayload, headers: res.headers };
}
const waitFor = async <T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 4000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); }
};
const smtpConfig = (port = smtpPort) => ({ domain: "nova-mobile.fr", from_name: "Nova Mobile", notifications: true,
  smtp: { host: "127.0.0.1", port, security: "none", username: "cadence", password: "s3cr3t-smtp" } });

// Un petit PNG valide (1×1)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(async () => {
  inbox.length = 0;
  smtp = new SMTPServer({
    authOptional: false, allowInsecureAuth: true, disabledCommands: ["STARTTLS"],
    onAuth: (auth, _s, cb) => (auth.username === "cadence" && auth.password === "s3cr3t-smtp" ? cb(null, { user: auth.username }) : cb(new Error("Identifiants refusés"))),
    onData: (stream, session, cb) => {
      let raw = ""; stream.on("data", (c) => (raw += c)); stream.on("end", () => {
        inbox.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_hugo"]) await login(u);
});
afterEach(async () => { await ctx.app.close(); await new Promise<void>((r) => smtp.close(r)); });

describe("messagerie de l'organisation", () => {
  it("garde le mot de passe SMTP secret : jamais renvoyé, jamais en clair en base", async () => {
    expect((await api("u_alice", "PUT", "/api/org/mail", smtpConfig())).status).toBe(200);
    const cfg = (await api("u_alice", "GET", "/api/org/mail")).body;
    expect(JSON.stringify(cfg)).not.toContain("s3cr3t-smtp");
    expect(cfg.smtp.password_set).toBe(true);
    const row = await ctx.db.one<{ settings: unknown }>("SELECT settings FROM organizations WHERE name = 'Nova Mobile'");
    expect(JSON.stringify(row!.settings)).not.toContain("s3cr3t-smtp");
    // Un enregistrement sans mot de passe conserve l'ancien
    await api("u_alice", "PUT", "/api/org/mail", { ...smtpConfig(), smtp: { ...smtpConfig().smtp, password: "" } });
    expect((await api("u_alice", "POST", "/api/org/mail/test")).body.ok).toBe(true);
  });

  it("réserve la configuration aux administrateurs", async () => {
    expect((await api("u_karim", "PUT", "/api/org/mail", smtpConfig())).status).toBe(403);
    expect((await api("u_karim", "GET", "/api/org/mail")).status).toBe(403);
  });

  it("attribue une adresse de service à chaque niveau, sur un seul domaine", async () => {
    await api("u_alice", "PUT", "/api/org/mail", smtpConfig());
    const list = (await api("u_alice", "GET", "/api/org/mail/addresses")).body as { target_type: string; name: string; address: string }[];
    expect(list.find((a) => a.target_type === "org")!.address).toBe("contact@nova-mobile.fr");
    expect(list.find((a) => a.name === "Équipe Mobile")!.address).toBe("equipe-mobile@nova-mobile.fr");
    expect(list.find((a) => a.name === "Ressources humaines")!.address).toBe("ressources-humaines@nova-mobile.fr");
    expect(new Set(list.map((a) => a.address)).size).toBe(list.length);
  });

  it("permet de personnaliser une adresse, en refusant les doublons et les formats invalides", async () => {
    await api("u_alice", "PUT", "/api/org/mail", smtpConfig());
    const list = (await api("u_alice", "GET", "/api/org/mail/addresses")).body as { id: string; name: string; local_part: string }[];
    const rh = list.find((a) => a.name === "Ressources humaines")!;
    expect((await api("u_alice", "PATCH", `/api/org/mail/addresses/${rh.id}`, { local_part: "drh" })).body.address).toBe("drh@nova-mobile.fr");
    expect(list.find((a) => a.name === "RH")!.local_part).toBe("rh");
    const other = list.find((a) => a.name === "Équipe Mobile")!;
    expect((await api("u_alice", "PATCH", `/api/org/mail/addresses/${other.id}`, { local_part: "drh" })).status).toBe(400);
    expect((await api("u_alice", "PATCH", `/api/org/mail/addresses/${other.id}`, { local_part: "Pas valide!" })).status).toBe(400);
    expect((await api("u_karim", "PATCH", `/api/org/mail/addresses/${other.id}`, { local_part: "mobile" })).status).toBe(403);
  });

  it("envoie un e-mail de test depuis l'adresse de l'organisation", async () => {
    await api("u_alice", "PUT", "/api/org/mail", smtpConfig());
    const res = (await api("u_alice", "POST", "/api/org/mail/test")).body;
    expect(res.ok).toBe(true);
    const m = await waitFor(() => inbox, (x) => x.length > 0);
    expect(m[0].from).toBe("contact@nova-mobile.fr");
    expect(m[0].to).toEqual(["alice@cadence.app"]);
    expect(m[0].user).toBe("cadence");
    expect(m[0].raw).toMatch(/From: "?Nova Mobile"? <contact@nova-mobile\.fr>/);
  });

  it("notifie par e-mail depuis l'adresse de l'équipe du projet", async () => {
    await api("u_alice", "PUT", "/api/org/mail", smtpConfig());
    const app = (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE key = 'APP'"))!.id;
    await api("u_alice", "POST", "/api/tasks", { project_id: app, title: "Corriger le crash au lancement", assignee_id: "u_karim" });
    const m = await waitFor(() => inbox, (x) => x.length > 0);
    expect(m[0].from).toBe("equipe-mobile@nova-mobile.fr");
    expect(m[0].to).toEqual(["karim@cadence.app"]);
    expect(m[0].raw).toMatch(/Subject: .*Corriger le crash/);
    expect(m[0].raw).toMatch(/Reply-To: [^\n]*(\r?\n [^\n]*)?equipe-mobile@nova-mobile\.fr/);
    const log = await waitFor(() => ctx.db.query<{ status: string }>("SELECT status FROM email_log"), (r) => r.length > 0);
    expect(log[0].status).toBe("sent");
  });

  it("signale clairement une erreur SMTP sans faire échouer l'action", async () => {
    await api("u_alice", "PUT", "/api/org/mail", { ...smtpConfig(), smtp: { ...smtpConfig().smtp, password: "mauvais" } });
    const res = (await api("u_alice", "POST", "/api/org/mail/test")).body;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/authentification|identifiants/i);
    const app = (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE key = 'APP'"))!.id;
    expect((await api("u_alice", "POST", "/api/tasks", { project_id: app, title: "Tâche malgré tout", assignee_id: "u_karim" })).status).toBe(200);
    const log = await waitFor(() => ctx.db.query<{ status: string }>("SELECT status FROM email_log WHERE status = 'failed'"), (r) => r.length > 1);
    expect(log.length).toBeGreaterThan(1);
  });

  it("n'envoie rien si les notifications par e-mail sont désactivées", async () => {
    await api("u_alice", "PUT", "/api/org/mail", { ...smtpConfig(), notifications: false });
    const app = (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE key = 'APP'"))!.id;
    await api("u_alice", "POST", "/api/tasks", { project_id: app, title: "Silencieuse", assignee_id: "u_karim" });
    await new Promise((r) => setTimeout(r, 300));
    expect(inbox).toHaveLength(0);
  });
});

describe("photos de profil", () => {
  it("enregistre une photo et la sert avec un lien versionné", async () => {
    const res = await api("u_karim", "PUT", "/api/users/u_karim/avatar", { data_url: `data:image/png;base64,${PNG}` });
    expect(res.status).toBe(200);
    const karim = ((await api("u_alice", "GET", "/api/users")).body as { id: string; avatar_url: string | null }[]).find((u) => u.id === "u_karim")!;
    expect(karim.avatar_url).toMatch(/^\/api\/avatars\/u_karim\?v=1$/);
    const img = await ctx.app.inject({ method: "GET", url: karim.avatar_url!, headers: { cookie: cookies.u_alice } });
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.subarray(1, 4).toString()).toBe("PNG");
  });
  it("refuse un fichier qui n'est pas une image ou trop lourd", async () => {
    const txt = Buffer.from("bonjour").toString("base64");
    expect((await api("u_karim", "PUT", "/api/users/u_karim/avatar", { data_url: `data:image/png;base64,${txt}` })).status).toBe(415);
    const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(600 * 1024)]).toString("base64");
    expect((await api("u_karim", "PUT", "/api/users/u_karim/avatar", { data_url: `data:image/png;base64,${big}` })).status).toBe(413);
  });
  it("seul l'intéressé change sa photo ; l'administrateur garde la main sur les coéquipiers IA", async () => {
    expect((await api("u_karim", "PUT", "/api/users/u_alice/avatar", { data_url: `data:image/png;base64,${PNG}` })).status).toBe(403);
    expect((await api("u_alice", "PUT", "/api/users/u_karim/avatar", { data_url: `data:image/png;base64,${PNG}` })).status).toBe(403);
    expect((await api("u_karim", "PUT", "/api/users/u_karim/avatar", { data_url: `data:image/png;base64,${PNG}` })).status).toBe(200);
    expect((await api("u_alice", "PUT", "/api/users/ai_atlas/avatar", { data_url: `data:image/png;base64,${PNG}` })).status).toBe(200);
    expect((await api("u_karim", "DELETE", "/api/users/u_karim/avatar")).status).toBe(200);
    const karim = ((await api("u_alice", "GET", "/api/users")).body as { id: string; avatar_url: string | null }[]).find((u) => u.id === "u_karim")!;
    expect(karim.avatar_url).toBeNull();
  });
});

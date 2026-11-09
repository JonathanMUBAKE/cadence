import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { hashPassword, passwordWork } from "./auth/password.js";
import { totpCode } from "./auth/totp.js";
import { trustProxySetting } from "./secrets.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const GOOD = "cheval-agrafe-batterie-42";
const INFO = { ip: "1.1.1.1", userAgent: "test" };
const cookies: Record<string, string> = {};

const cookieOf = (res: { headers: Record<string, unknown> }) => String(([] as unknown[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0];
async function demo(user: string) { cookies[user] = cookieOf(await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } })); }
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function api(who: string | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { ...(who ? { cookie: cookies[who] ?? who } : {}), ...headers } });
  let body = null; try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body, headers: res.headers };
}
const login = (email: string, password: string, headers?: Record<string, string>) => api(null, "POST", "/api/auth/login", { email, password }, headers);
const tokenOf = (link: string) => new URLSearchParams(new URL(link, "http://x").hash.slice(1)).get("token")!;
const orgId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const projectId = async (name: string) => (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const profileId = async (name: string) => (await api("u_alice", "GET", "/api/org/profiles")).body.find((p: { name: string }) => p.name === name).id as string;
const statusOf = async (id: string) => (await ctx.db.one<{ status: string }>("SELECT status FROM users WHERE id = $1", [id]))!.status;
const invite = async (email = "nadia@exemple.test") => (await api("u_alice", "POST", "/api/org/invitations", { email, name: "Nadia Keita", profile_id: await profileId("Membre") })).body as { invitation_id: string; sent: boolean; link: string };
const idOf = async (email = "nadia@exemple.test") => (await ctx.db.one<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]))!.id;
async function activated(email = "nadia@exemple.test") {
  const i = await invite(email);
  expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(200);
  cookies[email] = cookieOf(await login(email, GOOD));
  return i;
}
/** Une seconde organisation, dirigée par Hugo, sans lien avec Nova Mobile. */
async function otherOrg() {
  const b = await api("u_hugo", "POST", "/api/orgs", { name: "Autre organisation" });
  cookies.other = `${cookies.u_hugo}; ${cookieOf(b)}`;
  return b.body.id as string;
}
async function suspend(userId: string) {
  await ctx.db.query("UPDATE users SET platform_role = 'super_admin' WHERE id = 'u_karim'");
  await ctx.provisioning.suspend("u_karim", userId, INFO);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(users = ["u_alice", "u_karim", "u_theo", "u_hugo"]) {
  beforeEach(async () => { ctx = await buildApp({ provider: "demo", demoDelayMs: 0 }); for (const u of users) await demo(u); });
  afterEach(async () => { await ctx.app.close(); });
}

describe("liens d'activation entre organisations", () => {
  setup();

  it("une autre organisation n'obtient jamais de lien pour un compte déjà invité", async () => {
    const i = await invite();
    const org = await otherOrg();
    const r = await api("other", "POST", "/api/org/invitations", { email: "nadia@exemple.test", name: "Nadia", profile_id: `prf_member_${org}` });
    expect(r.status).toBe(200);
    expect(r.body.link).toBeUndefined();
    expect(r.body.sent).toBe(false);
    expect((await api("other", "POST", `/api/org/invitations/${r.body.invitation_id}/resend`)).body.link).toBeUndefined();
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(200);
    const c = cookieOf(await login("nadia@exemple.test", GOOD));
    expect((await api(c, "GET", "/api/me")).body.orgs).toHaveLength(1);
    expect((await api(c, "GET", "/api/invitations")).body).toHaveLength(1);
  });

  it("l'organisation d'origine peut toujours renvoyer le lien", async () => {
    const i = await invite();
    const org = await otherOrg();
    await api("other", "POST", "/api/org/invitations", { email: "nadia@exemple.test", name: "Nadia", profile_id: `prf_member_${org}` });
    expect(tokenOf((await api("u_alice", "POST", `/api/org/invitations/${i.invitation_id}/resend`)).body.link)).toBeTruthy();
  });

  it("une autre organisation ne peut pas annuler le lien d'origine", async () => {
    const i = await invite();
    const org = await otherOrg();
    const theirs = await api("other", "POST", "/api/org/invitations", { email: "nadia@exemple.test", name: "Nadia", profile_id: `prf_member_${org}` });
    expect((await api("other", "DELETE", `/api/org/invitations/${theirs.body.invitation_id}`)).status).toBe(200);
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(200);
  });

  it("un compte suspendu ne peut pas être invité ni repris", async () => {
    await suspend("u_ines");
    const org = await otherOrg();
    const r = await api("other", "POST", "/api/org/invitations", { email: "ines@cadence.app", name: "x", profile_id: `prf_member_${org}` });
    expect(r.status).toBe(200); // Même réponse que pour une adresse inconnue : rien n'est révélé
    expect(r.body.link).toBeUndefined();
    expect(await statusOf("u_ines")).toBe("suspended");
    expect(await ctx.svc.orgRole("u_ines", org)).toBeNull();
  });
});

describe("suspension", () => {
  setup();

  it("annule les liens déjà émis", async () => {
    const i = await invite();
    const id = await idOf();
    await suspend(id);
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(400);
    expect(await statusOf(id)).toBe("suspended");
  });

  it("refuse un lien de réinitialisation émis avant la suspension, même si le jeton a survécu", async () => {
    await activated();
    const id = await idOf();
    const { link } = await ctx.provisioning.resetLink(id);
    await ctx.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [id]);
    expect((await api(null, "POST", "/api/auth/reset", { token: tokenOf(link), password: "licorne-tournevis-fanfare-77" })).status).toBe(400);
  });

  it("refuse d'activer un compte qui n'est plus en attente d'activation", async () => {
    const i = await invite();
    const id = await idOf();
    await ctx.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [id]);
    expect((await api(null, "POST", "/api/auth/activate", { token: tokenOf(i.link), password: GOOD })).status).toBe(400);
    expect(await statusOf(id)).toBe("suspended");
  });
});

describe("messagerie des organisations et sécurité des comptes", () => {
  setup();

  it("le lien de réinitialisation ne passe jamais par le SMTP d'une organisation", async () => {
    await activated();
    const send = vi.spyOn(ctx.mail, "send").mockResolvedValue({ ok: true } as never);
    await api(null, "POST", "/api/auth/forgot", { email: "nadia@exemple.test" });
    expect(send).not.toHaveBeenCalled();
  });

  it("le lien envoyé par l'administrateur système non plus", async () => {
    await activated();
    await ctx.db.query("UPDATE users SET platform_role = 'super_admin' WHERE id = 'u_karim'");
    const send = vi.spyOn(ctx.mail, "send").mockResolvedValue({ ok: true } as never);
    const r = await api("u_karim", "POST", `/api/admin/users/${await idOf()}/reset`, {});
    expect(send).not.toHaveBeenCalled();
    expect(r.body.link).toBeTruthy();
  });
});

describe("ancienne route de rôle", () => {
  setup();
  const delegate = async () => {
    const p = (await api("u_alice", "POST", "/api/org/profiles", { name: "RH limité", base_role: "admin", permissions: ["org.members"] })).body;
    await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: p.id });
  };

  it("ne permet pas de s'attribuer plus de droits", async () => {
    await delegate();
    expect((await api("u_theo", "PUT", "/api/org/members/u_theo", { role: "admin" })).status).toBe(403);
    expect((await api("u_theo", "GET", "/api/me")).body.permissions).toEqual(["org.members"]);
  });

  it("ne permet pas de donner à un autre plus que ce qu'on possède", async () => {
    await delegate();
    expect((await api("u_theo", "PUT", "/api/org/members/u_hugo", { role: "admin" })).status).toBe(403);
  });

  it("reste utilisable par un propriétaire et un administrateur complet", async () => {
    expect((await api("u_alice", "PUT", "/api/org/members/u_theo", { role: "admin" })).status).toBe(200);
    await demo("u_theo");
    expect((await api("u_theo", "PUT", "/api/org/members/u_hugo", { role: "member" })).status).toBe(200);
  });
});

describe("coéquipiers IA : périmètre du demandeur", () => {
  setup();
  const SECRET = "Salaires 2027 confidentiels";

  async function secretProject() {
    const priv = (await api("u_alice", "POST", "/api/projects", { name: "Direction", access: "private" })).body as { id: string; key: string };
    await api("u_alice", "PUT", `/api/projects/${priv.id}/members/ai_atlas`, { role: "viewer" });
    const task = (await api("u_alice", "POST", "/api/tasks", { project_id: priv.id, title: SECRET })).body as { id: string; key: string };
    const res = await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments?name=note.txt`, payload: Buffer.from("contenu"), headers: { cookie: cookies.u_alice, "content-type": "application/octet-stream" } });
    return { priv, task, attachment: JSON.parse(res.body).id as string };
  }
  const scoped = async (requesterId: string | null) => ({ actorId: "ai_atlas", orgId: await orgId(), scope: { requesterId, projectId: await projectId("Application mobile") } });

  it("ne lit rien qu'une personne sans accès n'aurait pas pu lire", async () => {
    const { priv, task, attachment } = await secretProject();
    const ctxTool = await scoped("u_theo");
    const tools = ctx.ai.tools;
    await expect(tools.execute(ctxTool, "get_task", { task: task.key })).rejects.toThrow(/hors de portée/);
    await expect(tools.execute(ctxTool, "get_project", { project_id: priv.id })).rejects.toThrow(/hors de portée/);
    await expect(tools.execute(ctxTool, "read_attachment", { attachment_id: attachment })).rejects.toThrow(/hors de portée/);
    expect(JSON.stringify(await tools.execute(ctxTool, "search_tasks", { text: "Salaires" }))).not.toContain(SECRET);
    expect(JSON.stringify(await tools.execute(ctxTool, "list_projects", {}))).not.toContain("Direction");
    await expect(tools.execute(ctxTool, "add_comment", { task: task.key, body: "x" })).rejects.toThrow(/hors de portée/);
    expect(await tools.describe(ctxTool, "add_comment", { task: task.key })).not.toContain(SECRET);
  });

  it("garde l'accès aux projets que le demandeur voit", async () => {
    const { task } = await secretProject();
    const ctxTool = await scoped("u_alice");
    await expect(ctx.ai.tools.execute(ctxTool, "get_task", { task: task.key })).resolves.toMatchObject({ title: SECRET });
    expect(JSON.stringify(await ctx.ai.tools.execute(ctxTool, "search_tasks", { text: "Salaires" }))).toContain(SECRET);
  });

  it("sans demandeur, reste dans le projet de l'exécution", async () => {
    const { task } = await secretProject();
    const ctxTool = await scoped(null);
    await expect(ctx.ai.tools.execute(ctxTool, "get_task", { task: task.key })).rejects.toThrow(/hors de portée/);
    expect((await ctx.ai.tools.execute(ctxTool, "search_tasks", { project_id: await projectId("Application mobile") }) as { count: number }).count).toBeGreaterThan(0);
  });

  it("le moteur applique ce périmètre à une @mention", async () => {
    await ctx.app.close();
    const provider = {
      name: "stub",
      async turn({ messages }: { messages: { content: unknown }[] }) {
        const last = messages[messages.length - 1].content;
        const result = Array.isArray(last) ? last.find((b: { type: string }) => b.type === "tool_result") : null;
        if (!result) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search_tasks", input: { text: "Salaires" } }] };
        return { stop_reason: "end_turn", content: [{ type: "text", text: `Résultat : ${JSON.stringify(result.content)}` }] };
      },
    };
    ctx = await buildApp({ provider: provider as never, demoDelayMs: 0 });
    for (const u of ["u_alice", "u_theo"]) await demo(u);
    await secretProject();
    const t = (await api("u_alice", "POST", "/api/tasks", { project_id: await projectId("Application mobile"), title: "Anodine" })).body;
    await api("u_theo", "POST", `/api/tasks/${t.id}/comments`, { body: "@Atlas cherche Salaires" });
    await wait(800);
    const comments = (await api("u_theo", "GET", `/api/tasks/${t.id}`)).body.comments as { author_id: string; body: string }[];
    expect(comments.some((c) => c.author_id === "ai_atlas")).toBe(true);
    expect(JSON.stringify(comments)).not.toContain(SECRET);
  });
});

describe("droit de déléguer à l'IA", () => {
  setup();
  const restrict = async () => {
    const p = (await api("u_alice", "POST", "/api/org/profiles", { name: "Sans IA", base_role: "member", permissions: ["tasks.comment", "tasks.edit", "tasks.create"] })).body;
    await api("u_alice", "PUT", "/api/org/members/u_theo/profile", { profile_id: p.id });
  };
  const runs = async (taskId: string) => (await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM ai_runs WHERE task_id = $1 AND kind <> 'rule'", [taskId]))!.n;
  const task = async () => (await api("u_alice", "POST", "/api/tasks", { project_id: await projectId("Application mobile"), title: "T" })).body as { id: string };

  it("une @mention est refusée et ne lance rien", async () => {
    await restrict();
    const t = await task();
    const r = await api("u_theo", "POST", `/api/tasks/${t.id}/comments`, { body: "@Atlas où en est-on ?" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/profil/);
    await wait(300);
    expect(await runs(t.id)).toBe(0);
    expect((await api("u_theo", "GET", `/api/tasks/${t.id}`)).body.comments).toHaveLength(0);
  });

  it("une mention d'un humain reste permise", async () => {
    await restrict();
    const t = await task();
    expect((await api("u_theo", "POST", `/api/tasks/${t.id}/comments`, { body: "@Karim peux-tu regarder ?" })).status).toBe(200);
  });

  it("assigner à l'IA est refusé, à la création comme à la modification", async () => {
    await restrict();
    const t = await task();
    expect((await api("u_theo", "PATCH", `/api/tasks/${t.id}`, { assignee_id: "ai_atlas" })).status).toBe(403);
    expect((await api("u_theo", "POST", "/api/tasks", { project_id: await projectId("Application mobile"), title: "U", assignee_id: "ai_atlas" })).status).toBe(403);
    await wait(300);
    expect(await runs(t.id)).toBe(0);
  });

  it("le moteur refuse aussi un événement venu d'un autre chemin", async () => {
    await restrict();
    const t = await task();
    ctx.bus.emit({ type: "comment.created", actorId: "u_theo", projectId: await projectId("Application mobile"), taskId: t.id, commentId: "c", mentions: ["ai_atlas"] });
    await wait(300);
    expect(await runs(t.id)).toBe(0);
  });

  it("une personne autorisée lance toujours l'IA", async () => {
    const t = await task();
    expect((await api("u_karim", "POST", `/api/tasks/${t.id}/comments`, { body: "@Atlas où en est-on ?" })).status).toBe(200);
    await wait(300);
    expect(await runs(t.id)).toBe(1);
  });
});

describe("limites de connexion", () => {
  setup(["u_alice"]);

  it("des essais simultanés comptent tous pour le verrouillage", async () => {
    await activated();
    await Promise.all([...Array(20)].map(() => login("nadia@exemple.test", "mauvais-mot-de-passe")));
    expect((await ctx.db.one<{ failed_logins: number }>("SELECT failed_logins FROM users WHERE email = 'nadia@exemple.test'"))!.failed_logins).toBe(5);
    expect((await login("nadia@exemple.test", GOOD)).status).toBe(401);
  });

  it("des essais simultanés ne dépassent pas la limite par adresse", async () => {
    await ctx.db.query("INSERT INTO login_attempts (id, email, ip, success) SELECT 'x' || g, 'e' || g, '127.0.0.1', FALSE FROM generate_series(1, 25) g");
    const all = await Promise.all([...Array(10)].map(() => login("personne@exemple.test", "mauvais-mot-de-passe")));
    expect(all.filter((r) => r.status === 429)).toHaveLength(5);
    expect(all.filter((r) => r.status === 401)).toHaveLength(5);
    expect((await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM login_attempts"))!.n).toBe(30);
  });

  it("une connexion réussie ne compte pas comme un échec", async () => {
    await activated();
    await login("nadia@exemple.test", GOOD);
    expect((await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM login_attempts WHERE NOT success"))!.n).toBe(0);
    expect((await ctx.db.one<{ failed_logins: number }>("SELECT failed_logins FROM users WHERE email = 'nadia@exemple.test'"))!.failed_logins).toBe(0);
  });

  it("un mauvais mot de passe sur un compte verrouillé ne prolonge pas le verrou", async () => {
    await activated();
    for (let i = 0; i < 5; i++) await login("nadia@exemple.test", "mauvais-mot-de-passe");
    const before = await ctx.db.one<{ locked_until: string }>("SELECT locked_until FROM users WHERE email = 'nadia@exemple.test'");
    await login("nadia@exemple.test", "mauvais-mot-de-passe");
    expect(await ctx.db.one<{ locked_until: string }>("SELECT locked_until FROM users WHERE email = 'nadia@exemple.test'")).toEqual(before);
  });
});

describe("adresse du visiteur derrière un proxy", () => {
  afterEach(async () => { delete process.env.TRUST_PROXY; await ctx.app.close(); });

  it("traduit le réglage : nombre de proxys ou adresses de confiance", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("")).toBe(false);
    expect(trustProxySetting("0")).toBe(false);
    const oneHop = trustProxySetting("1") as (a: string, hop: number) => boolean;
    expect([oneHop("x", 0), oneHop("x", 1)]).toEqual([true, false]);
    expect(trustProxySetting("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("un X-Forwarded-For forgé ne contourne pas la limite par adresse", async () => {
    process.env.TRUST_PROXY = "1";
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    await ctx.db.query("INSERT INTO login_attempts (id, email, ip, success) SELECT 'x' || g, 'e' || g, '10.0.0.1', FALSE FROM generate_series(1, 40) g");
    expect((await login("a@b.test", "mauvais-mot-de-passe", { "x-forwarded-for": "9.9.9.9, 10.0.0.1" })).status).toBe(429);
    expect((await login("a@b.test", "mauvais-mot-de-passe", { "x-forwarded-for": "8.8.8.8, 10.0.0.2" })).status).toBe(401);
  });
});

describe("coût du hachage", () => {
  it("limite les calculs simultanés et refuse quand la file est pleine", async () => {
    const all = [...Array(40)].map(() => hashPassword(GOOD));
    expect(passwordWork().running).toBe(2);
    expect(passwordWork().waiting).toBe(32);
    const results = await Promise.allSettled(all);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused).toHaveLength(6);
    expect(refused[0].reason.status).toBe(429);
    expect(passwordWork()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);
});

describe("double authentification : force brute", () => {
  setup(["u_alice"]);

  async function enroll() {
    await activated();
    const c = cookies["nadia@exemple.test"];
    const s = (await api(c, "POST", "/api/auth/mfa/setup")).body as { secret: string };
    await api(c, "POST", "/api/auth/mfa/confirm", { code: totpCode(s.secret) });
    await ctx.db.query("UPDATE users SET totp_last_step = NULL WHERE email = 'nadia@exemple.test'");
    return s.secret;
  }
  const pending = async () => cookieOf(await login("nadia@exemple.test", GOOD));

  it("les échecs s'additionnent d'une session à l'autre et verrouillent la 2FA", async () => {
    const secret = await enroll();
    for (let n = 0; n < 2; n++) { const p = await pending(); for (let i = 0; i < 3; i++) await api(p, "POST", "/api/auth/mfa", { code: "000000" }); }
    const p = await pending();
    expect((await api(p, "POST", "/api/auth/mfa", { code: totpCode(secret) })).status).toBe(401);
    expect((await api(p, "GET", "/api/me")).status).toBe(401);
    await ctx.db.query("UPDATE users SET mfa_locked_until = now() - interval '1 minute'");
    expect((await api(p, "POST", "/api/auth/mfa", { code: totpCode(secret) })).status).toBe(200);
    expect((await ctx.db.one<{ mfa_failures: number }>("SELECT mfa_failures FROM users WHERE email = 'nadia@exemple.test'"))!.mfa_failures).toBe(0);
  });

  it("n'expose pas le compteur de la 2FA", async () => {
    await enroll();
    expect(JSON.stringify((await api("u_alice", "GET", "/api/users")).body)).not.toMatch(/mfa_failures|mfa_locked_until/);
  });
});

describe("jetons hors des adresses", () => {
  setup(["u_alice"]);

  it("le lien porte le jeton après #, et la lecture du jeton passe par le corps", async () => {
    const i = await invite();
    expect(i.link).toMatch(/^\/activation#token=/);
    expect((await api(null, "GET", `/api/auth/token?token=${tokenOf(i.link)}`)).status).toBe(404);
    expect((await api(null, "POST", "/api/auth/token", { token: tokenOf(i.link) })).body).toMatchObject({ kind: "invite", email: "nadia@exemple.test" });
  });
});

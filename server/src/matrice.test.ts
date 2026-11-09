import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/*
 * Contrat d'accès de toute l'API, rejoué à chaque test : anonyme, lecteur strict, propriétaire externe, propriétaire légitime.
 * Une route ajoutée sans entrée dans TABLE fait échouer la suite : aucune route ne peut échapper à ce contrôle.
 */
type Any = any;
type Kind = "P1" | "P2" | "P3" | "P4";
const PNG = "data:image/png;base64,iVBORw0KGgo=", GOOD = "cheval-agrafe-batterie-42", NO_LIMITS = { anonymousPerMinute: 1e6, sessionPerMinute: 1e6, aiPerMinute: 1e6, invitationsPerHour: 1e6, aiRunsPerHour: 1e6 };
const PUBLIC = /^\/api\/auth\/(login|logout|config|users$|mfa$|token|activate|reset|forgot|request-access)/;
/** Écritures qui ne concernent que son propre compte : un lecteur y a droit. */
const PERSONAL = /^(POST \/api\/auth\/(password|mfa\/setup|mfa\/confirm|mfa\/disable)|DELETE \/api\/auth\/sessions|POST \/api\/notifications\/read|POST \/api\/orgs\/:id\/switch|POST \/api\/invitations\/)/;
const DEMO_ONLY = "POST /api/orgs"; // Hors mode démo, réservé à l'administrateur système (voir auth.test.ts)
/** Réponses normales du propriétaire : l'essai vise volontairement un refus métier. */
const OWNER_EXPECTED = /^(PUT|DELETE) \/api\/users\/:id\/avatar|^GET \/api\/avatars|^POST \/api\/auth\/(password|mfa\/confirm|mfa\/disable)|^POST \/api\/invitations\/:id|\/api\/admin\//;
let n = 0; const u = (p: string) => `${p}${++n}`;
const cookieOf = (r: Any) => ([] as string[]).concat(r.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c)).join("; ");

async function boot(kind: Kind) {
  const ctx = await buildApp({ provider: "demo", demoDelayMs: 0, limits: NO_LIMITS });
  const c: Record<string, string> = {};
  const inj = async (who: string | null, method: Any, url: string, payload?: Any) => {
    const res = await ctx.app.inject({ method, url, payload, headers: who && c[who] ? { cookie: c[who] } : {} });
    let body: Any = null; try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body, res };
  };
  for (const id of ["u_alice", "u_karim", "u_hugo"]) c[id] = cookieOf((await inj(null, "POST", "/api/auth/login", { user_id: id })).res);
  const a = "u_alice";
  const org = (await ctx.db.one<Any>("SELECT id FROM organizations WHERE name='Nova Mobile'")).id as string;
  const app = (await ctx.db.one<Any>("SELECT id FROM projects WHERE name LIKE '%Application mobile%'")).id as string;
  const profs = (await inj(a, "GET", "/api/org/profiles")).body as Any[], prof = (x: string) => profs.find((p) => p.name === x).id as string;
  const detail = (await inj(a, "GET", `/api/projects/${app}`)).body;
  await inj(a, "PUT", "/api/org/mail", { domain: "nova.test", smtp: { host: "127.0.0.1", port: 1, security: "none" } });
  const addr = (await inj(a, "GET", "/api/org/mail/addresses")).body[0];
  let who: string | null = null;
  if (kind === "P2") {
    who = "u_hugo";
    await ctx.db.query("DELETE FROM memberships WHERE user_id='u_hugo'"); await ctx.db.query("DELETE FROM team_members WHERE user_id='u_hugo'");
    const p = (await inj(a, "POST", "/api/org/profiles", { name: "Sans droit", base_role: "member", permissions: [] })).body;
    await inj(a, "PUT", "/api/org/members/u_hugo/profile", { profile_id: p.id });
    await inj(a, "PUT", `/api/projects/${app}/members/u_hugo`, { role: "viewer" });
  }
  if (kind === "P3") {
    const b = await inj("u_hugo", "POST", "/api/orgs", { name: "Organisation B" });
    c.b = `${c.u_hugo.split(";")[0]}; ${cookieOf(b.res)}`; who = "b";
    await ctx.db.query("DELETE FROM memberships WHERE user_id='u_hugo'"); await ctx.db.query("DELETE FROM team_members WHERE user_id='u_hugo'"); await ctx.db.query("DELETE FROM org_members WHERE user_id='u_hugo' AND org_id=$1", [org]);
  }
  if (kind === "P4") who = a;
  const X: Any = {
    org, app, prof, detail, addr,
    task: async () => (await inj(a, "POST", "/api/tasks", { project_id: app, title: u("Tache") })).body,
    comment: async (t: Any) => (await inj(a, "POST", `/api/tasks/${t.id}/comments`, { body: "commentaire" })).body,
    att: async (t: Any) => JSON.parse((await ctx.app.inject({ method: "POST", url: `/api/tasks/${t.id}/attachments?name=a.txt`, payload: Buffer.from("texte"), headers: { cookie: c[a], "content-type": "application/octet-stream" } })).body),
    project: async () => { const p = (await inj(a, "POST", "/api/projects", { name: u("Projet") })).body; if (kind === "P2") await inj(a, "PUT", `/api/projects/${p.id}/members/u_hugo`, { role: "viewer" }); return p; },
    section: async () => (await inj(a, "POST", `/api/projects/${app}/sections`, { name: u("S") })).body,
    unit: async () => ({ id: (await inj(a, "POST", "/api/org/units", { name: u("U"), parent_id: (await inj(a, "GET", "/api/org/units")).body[0].id })).body.id }),
    team: async (visibility = "public") => (await inj(a, "POST", "/api/teams", { name: u("Eq"), visibility })).body,
    rule: async () => (await inj(a, "POST", `/api/projects/${app}/ai/rules`, { name: u("R"), trigger: "task_moved", agent_id: "ai_atlas", instructions: "x" })).body,
    profile: async () => (await inj(a, "POST", "/api/org/profiles", { name: u("Pr"), base_role: "member", permissions: [] })).body,
    invite: async () => (await inj(a, "POST", "/api/org/invitations", { email: `${u("x")}@x.test`, name: "X", profile_id: prof("Membre") })).body,
    run: async () => { const t = await X.task(); return (await inj(a, "POST", `/api/tasks/${t.id}/ai/run`, { agent_id: "ai_atlas", instructions: "attente" })).body.run_id; },
    approval: async () => {
      const t = await X.task(); await inj(a, "POST", `/api/tasks/${t.id}/ai/run`, { agent_id: "ai_atlas", instructions: "Crée une tâche de test" });
      for (let i = 0; i < 40; i++) { const r = await ctx.db.one<Any>("SELECT id FROM ai_approvals WHERE task_id=$1 AND status='pending'", [t.id]); if (r) return r.id; await new Promise((s) => setTimeout(s, 50)); }
      return "aucune";
    },
    request: async () => { const t = await X.team("request"); await inj("u_karim", "POST", `/api/teams/${t.id}/join`); return (await ctx.db.one<Any>("SELECT id FROM team_requests WHERE team_id=$1", [t.id])).id; },
  };
  return { ctx, c, inj, X, who };
}

type Fixture = (X: Any) => Any;
const R_ = (m: string, p: string, f: Fixture = () => ({})) => [m, p, f] as const;
const taskUrl = (s = "") => async (X: Any) => ({ url: `/api/tasks/${(await X.task()).id}${s}` });
const TABLE = [
  R_("GET", "/api/me"), R_("GET", "/api/users"),
  R_("PUT", "/api/users/:id/avatar", () => ({ url: "/api/users/u_karim/avatar", body: { data_url: PNG } })), R_("DELETE", "/api/users/:id/avatar", () => ({ url: "/api/users/u_karim/avatar" })), R_("GET", "/api/avatars/:id", () => ({ url: "/api/avatars/u_alice" })),
  R_("GET", "/api/org/mail"), R_("PUT", "/api/org/mail", () => ({ body: { domain: "nova.test", smtp: { host: "127.0.0.1", port: 1, security: "none" } } })), R_("POST", "/api/org/mail/test"), R_("GET", "/api/org/mail/log"), R_("GET", "/api/org/mail/addresses"),
  R_("PATCH", "/api/org/mail/addresses/:id", (X) => ({ url: `/api/org/mail/addresses/${X.addr.id}`, body: { local_part: u("adr") } })),
  R_("POST", "/api/orgs", () => ({ body: { name: u("Org") } })), R_("POST", "/api/orgs/:id/switch", (X) => ({ url: `/api/orgs/${X.org}/switch` })), R_("PATCH", "/api/org", () => ({ body: { name: "Nova Mobile" } })),
  R_("PUT", "/api/org/members/:userId", () => ({ url: "/api/org/members/u_karim", body: { role: "member" } })), R_("PUT", "/api/org/members/:userId/unit", () => ({ url: "/api/org/members/u_karim/unit", body: { unit_id: null } })),
  R_("GET", "/api/org/units"), R_("POST", "/api/org/units", () => ({ body: { name: u("U") } })), R_("PATCH", "/api/units/:id", async (X) => ({ url: `/api/units/${(await X.unit()).id}`, body: { name: u("U") } })), R_("DELETE", "/api/units/:id", async (X) => ({ url: `/api/units/${(await X.unit()).id}` })),
  R_("GET", "/api/teams"), R_("POST", "/api/teams", () => ({ body: { name: u("Eq") } })), R_("GET", "/api/teams/:id", async (X) => ({ url: `/api/teams/${(await X.team()).id}` })), R_("PATCH", "/api/teams/:id", async (X) => ({ url: `/api/teams/${(await X.team()).id}`, body: { name: u("Eq") } })),
  R_("PUT", "/api/teams/:id/members/:userId", async (X) => ({ url: `/api/teams/${(await X.team()).id}/members/u_karim`, body: { role: "member" } })), R_("POST", "/api/teams/:id/join", async (X) => ({ url: `/api/teams/${(await X.team()).id}/join` })), R_("POST", "/api/team-requests/:id", async (X) => ({ url: `/api/team-requests/${await X.request()}`, body: { approve: true } })),
  R_("GET", "/api/projects"), R_("POST", "/api/projects", () => ({ body: { name: u("Projet") } })), R_("GET", "/api/projects/:id", (X) => ({ url: `/api/projects/${X.app}` })), R_("PATCH", "/api/projects/:id", (X) => ({ url: `/api/projects/${X.app}`, body: { description: "x" } })),
  R_("DELETE", "/api/projects/:id", async (X) => { const p = await X.project(); return { url: `/api/projects/${p.id}`, body: { confirm: p.name } }; }), R_("PUT", "/api/projects/:id/members/:userId", (X) => ({ url: `/api/projects/${X.app}/members/u_karim`, body: { role: "editor" } })),
  R_("GET", "/api/projects/:id/tasks", (X) => ({ url: `/api/projects/${X.app}/tasks` })), R_("GET", "/api/projects/:id/stats", (X) => ({ url: `/api/projects/${X.app}/stats` })), R_("GET", "/api/projects/:id/activity", (X) => ({ url: `/api/projects/${X.app}/activity` })), R_("GET", "/api/projects/:id/updates", (X) => ({ url: `/api/projects/${X.app}/updates` })),
  R_("POST", "/api/projects/:id/updates", (X) => ({ url: `/api/projects/${X.app}/updates`, body: { status: "on_track", headline: "x", summary: "x", risks: [], next_steps: [] } })), R_("POST", "/api/projects/:id/sections", (X) => ({ url: `/api/projects/${X.app}/sections`, body: { name: u("S") } })),
  R_("PATCH", "/api/sections/:id", async (X) => ({ url: `/api/sections/${(await X.section()).id}`, body: { name: u("S") } })), R_("POST", "/api/sections/:id/move", async (X) => ({ url: `/api/sections/${(await X.section()).id}/move`, body: { direction: "left" } })), R_("DELETE", "/api/sections/:id", async (X) => ({ url: `/api/sections/${(await X.section()).id}` })),
  R_("GET", "/api/tasks"), R_("POST", "/api/tasks", (X) => ({ body: { project_id: X.app, title: u("T") } })), R_("POST", "/api/projects/:id/tasks/bulk", (X) => ({ url: `/api/projects/${X.app}/tasks/bulk`, body: { tasks: [{ title: u("T") }] } })),
  R_("GET", "/api/tasks/:id", taskUrl()), R_("PATCH", "/api/tasks/:id", async (X) => ({ ...(await taskUrl()(X)), body: { title: u("T") } })), R_("POST", "/api/tasks/:id/move", async (X) => ({ ...(await taskUrl("/move")(X)), body: { section_id: X.detail.sections[1].id } })),
  R_("POST", "/api/tasks/:id/duplicate", async (X) => ({ ...(await taskUrl("/duplicate")(X)), body: {} })), R_("POST", "/api/tasks/:id/move-project", async (X) => { const p = await X.project(); return { ...(await taskUrl("/move-project")(X)), body: { project_id: p.id } }; }), R_("DELETE", "/api/tasks/:id", taskUrl()),
  R_("POST", "/api/tasks/:id/comments", async (X) => ({ ...(await taskUrl("/comments")(X)), body: { body: "x" } })), R_("PATCH", "/api/comments/:id", async (X) => ({ url: `/api/comments/${(await X.comment(await X.task())).id}`, body: { body: "y" } })), R_("DELETE", "/api/comments/:id", async (X) => ({ url: `/api/comments/${(await X.comment(await X.task())).id}` })),
  R_("POST", "/api/tasks/:id/attachments", async (X) => ({ url: `/api/tasks/${(await X.task()).id}/attachments?name=a.txt`, bin: "texte" })), R_("GET", "/api/attachments/:id", async (X) => ({ url: `/api/attachments/${(await X.att(await X.task())).id}` })), R_("GET", "/api/attachments/:id/preview", async (X) => ({ url: `/api/attachments/${(await X.att(await X.task())).id}/preview` })),
  R_("POST", "/api/comments/:id/attachments", async (X) => ({ url: `/api/comments/${(await X.comment(await X.task())).id}/attachments?name=a.txt`, bin: "texte" })), R_("DELETE", "/api/attachments/:id", async (X) => ({ url: `/api/attachments/${(await X.att(await X.task())).id}` })),
  R_("POST", "/api/import/analyze", () => ({ url: "/api/import/analyze?name=plan.txt", bin: "Phase 1\n- Tache A\n- Tache B\n" })), R_("POST", "/api/import/create", () => ({ body: { name: u("Imp"), filename: "a.txt", sections: ["S"], tasks: [{ title: "T", description: "", section: "S", assignee_id: null, due_on: null, priority: "none", completed: false, subtasks: [] }] } })),
  R_("GET", "/api/notifications"), R_("POST", "/api/notifications/read", () => ({ body: { all: true } })), R_("GET", "/api/search", () => ({ url: "/api/search?q=test" })),
  R_("GET", "/api/ai/status"), R_("GET", "/api/ai/agents"), R_("POST", "/api/tasks/:id/ai/run", async (X) => ({ ...(await taskUrl("/ai/run")(X)), body: { agent_id: "ai_atlas" } })), R_("POST", "/api/ai/chat", () => ({ body: { messages: [{ role: "user", content: "Bonjour" }] } })),
  R_("GET", "/api/ai/runs"), R_("GET", "/api/ai/runs/:id", async (X) => ({ url: `/api/ai/runs/${await X.run()}` })), R_("POST", "/api/ai/runs/:id/cancel", async (X) => ({ url: `/api/ai/runs/${await X.run()}/cancel` })), R_("GET", "/api/ai/approvals"), R_("POST", "/api/ai/approvals/:id", async (X) => ({ url: `/api/ai/approvals/${await X.approval()}`, body: { approve: false } })),
  R_("POST", "/api/tasks/:id/ai/subtasks", async (X) => ({ ...(await taskUrl("/ai/subtasks")(X)), body: {} })), R_("POST", "/api/tasks/:id/ai/description", async (X) => ({ ...(await taskUrl("/ai/description")(X)), body: {} })), R_("POST", "/api/projects/:id/ai/status", (X) => ({ url: `/api/projects/${X.app}/ai/status`, body: {} })), R_("POST", "/api/projects/:id/ai/parse", (X) => ({ url: `/api/projects/${X.app}/ai/parse`, body: { text: "Faire X" } })),
  R_("GET", "/api/projects/:id/ai/rules", (X) => ({ url: `/api/projects/${X.app}/ai/rules` })), R_("POST", "/api/projects/:id/ai/rules", (X) => ({ url: `/api/projects/${X.app}/ai/rules`, body: { name: u("R"), trigger: "task_moved", agent_id: "ai_atlas", instructions: "x" } })), R_("DELETE", "/api/projects/:id/ai/rules/:ruleId", async (X) => ({ url: `/api/projects/${X.app}/ai/rules/${(await X.rule()).id}` })),
  R_("GET", "/api/auth/sessions"), R_("DELETE", "/api/auth/sessions/:id", () => ({ url: "/api/auth/sessions/inconnue" })), R_("POST", "/api/auth/password", () => ({ body: { current: "faux-mot-de-passe", password: GOOD } })), R_("POST", "/api/auth/mfa/setup"), R_("POST", "/api/auth/mfa/confirm", () => ({ body: { code: "000000" } })), R_("POST", "/api/auth/mfa/disable", () => ({ body: { password: "faux-mot-de-passe" } })),
  R_("GET", "/api/org/invitations"), R_("POST", "/api/org/invitations", (X) => ({ body: { email: `${u("n")}@x.test`, name: "N", profile_id: X.prof("Membre") } })), R_("POST", "/api/org/invitations/:id/resend", async (X) => ({ url: `/api/org/invitations/${(await X.invite()).invitation_id}/resend` })), R_("DELETE", "/api/org/invitations/:id", async (X) => ({ url: `/api/org/invitations/${(await X.invite()).invitation_id}` })),
  R_("GET", "/api/invitations"), R_("POST", "/api/invitations/:id/accept", async (X) => ({ url: `/api/invitations/${(await X.invite()).invitation_id}/accept` })), R_("POST", "/api/invitations/:id/decline", async (X) => ({ url: `/api/invitations/${(await X.invite()).invitation_id}/decline` })),
  R_("GET", "/api/org/permissions"), R_("GET", "/api/org/profiles"), R_("POST", "/api/org/profiles", () => ({ body: { name: u("Pr"), base_role: "member", permissions: [] } })), R_("PATCH", "/api/org/profiles/:id", async (X) => ({ url: `/api/org/profiles/${(await X.profile()).id}`, body: { name: u("Pr") } })), R_("DELETE", "/api/org/profiles/:id", async (X) => ({ url: `/api/org/profiles/${(await X.profile()).id}` })),
  R_("PUT", "/api/org/members/:userId/profile", (X) => ({ url: "/api/org/members/u_karim/profile", body: { profile_id: X.prof("Membre") } })), R_("GET", "/api/org/members/:userId/access", () => ({ url: "/api/org/members/u_karim/access" })), R_("PUT", "/api/org/members/:userId/permissions", () => ({ url: "/api/org/members/u_karim/permissions", body: { overrides: { "tasks.create": false } } })),
  ...["users", "orgs", "events", "settings"].map((p) => R_("GET", `/api/admin/${p}`)), R_("PATCH", "/api/admin/settings", () => ({ body: { registration: "invite" } })),
  R_("POST", "/api/admin/users/:id/approve", (X) => ({ url: "/api/admin/users/u_karim/approve", body: { org_id: X.org, profile_id: X.prof("Membre") } })), ...["reject", "suspend", "reactivate", "revoke-sessions", "reset"].map((p) => R_("POST", `/api/admin/users/:id/${p}`, () => ({ url: `/api/admin/users/u_karim/${p}`, body: {} }))), R_("PUT", "/api/admin/users/:id/platform-role", () => ({ url: "/api/admin/users/u_karim/platform-role", body: { super_admin: true } })),
];

const results: Record<string, Partial<Record<Kind, number>>> = {};
const ok = (s?: number) => s !== undefined && s >= 200 && s < 300;

describe("contrat d'accès de toute l'API", () => {
  beforeAll(async () => {
    for (const kind of ["P1", "P2", "P3", "P4"] as Kind[]) {
      const { ctx, c, inj, X, who } = await boot(kind);
      for (const [m, p, f] of TABLE) {
        const d = await f(X), url = d.url ?? p;
        const res = d.bin !== undefined
          ? await ctx.app.inject({ method: m as Any, url, payload: Buffer.from(d.bin), headers: { ...(who ? { cookie: c[who] } : {}), "content-type": "application/octet-stream" } })
          : (await inj(who, m, url, m === "GET" ? undefined : d.body ?? (m === "POST" ? {} : undefined))).res;
        (results[`${m} ${p}`] ??= {})[kind] = res.statusCode;
      }
      await ctx.app.close();
    }
  }, 300_000);
  afterAll(() => { for (const k of Object.keys(results)) delete results[k]; });

  it("toute route privée déclarée figure dans le contrat", () => {
    const declared = ["./app.ts", "./auth/routes.ts"].flatMap((f) => [...readFileSync(new URL(f, import.meta.url), "utf8").matchAll(/\.(get|post|put|patch|delete)(?:<[^>]*>)?\("(\/api[^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
    const known = new Set(TABLE.map(([m, p]) => `${m} ${p}`));
    expect(declared.filter((r) => !PUBLIC.test(r.split(" ")[1]) && r !== "GET /api/events" && !known.has(r))).toEqual([]);
  });
  const offenders = (test: (key: string, r: Partial<Record<Kind, number>>) => boolean) => Object.entries(results).filter(([k, r]) => test(k, r)).map(([k, r]) => `${k} ${JSON.stringify(r)}`);

  it("un anonyme est toujours refusé", () => { expect(offenders((_k, r) => r.P1 !== 401)).toEqual([]); });
  it("un profil sans droit n'écrit rien en dehors de son propre compte", () => { expect(offenders((k, r) => !k.startsWith("GET ") && ok(r.P2) && !PERSONAL.test(k) && k !== DEMO_ONLY)).toEqual([]); });
  it("un propriétaire externe n'atteint aucun objet de l'organisation A", () => { expect(offenders((k, r) => k.includes(":") && ok(r.P3) && k !== "DELETE /api/auth/sessions/:id")).toEqual([]); });
  it("le propriétaire légitime accède à toutes ses routes", () => { expect(offenders((k, r) => !ok(r.P4) && !OWNER_EXPECTED.test(k))).toEqual([]); });
  it("aucune route ne répond par une erreur serveur", () => { expect(offenders((_k, r) => Object.values(r).some((s) => (s ?? 0) >= 500))).toEqual([]); });
});

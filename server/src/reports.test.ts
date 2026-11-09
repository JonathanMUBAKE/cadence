import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { computeProjectMetrics, type MetricTask } from "./analytics.js";
import type { AiProvider, JsonRequest } from "./ai/provider.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
}
async function api(user: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[user] } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const projectId = async (name: string) => (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const orgId = async () => (await ctx.db.one<{ id: string }>("SELECT id FROM organizations WHERE name = 'Nova Mobile'"))!.id;
const start = async (user: string, url: string, body: unknown = { agent_id: "ai_atlas", period_days: 30 }) => api(user, "POST", url, body);
const ready = (user: string, id: string) => waitFor(async () => (await api(user, "GET", `/api/reports/${id}`)).body, (r) => r.status !== "generating");

const NOW = "2026-06-30";
const task = (o: Partial<MetricTask>): MetricTask => ({ project_id: "p", key: "APP-1", title: "T", section_id: "s1", assignee_id: "u1", priority: "none", due_on: null, completed: false, completed_at: null, created_at: "2026-06-29T10:00:00.000Z", last_activity_at: "2026-06-29T10:00:00.000Z", ...o });
const compute = (tasks: MetricTask[], due_on: string | null = null) => computeProjectMetrics({
  project: { id: "p", key: "APP", name: "App", status: "on_track", due_on }, tasks, sections: [{ id: "s1", name: "À faire" }],
  users: new Map([["u1", { name: "Karim", is_ai: false }], ["u2", { name: "Chloé", is_ai: false }]]), now: NOW, periodDays: 28,
});

describe("calcul des indicateurs", () => {
  it("mesure la vélocité, les retards, l'inactivité et le respect des échéances", () => {
    const m = compute([
      task({ completed: true, completed_at: "2026-06-20T10:00:00.000Z", created_at: "2026-06-10T10:00:00.000Z", due_on: "2026-06-25" }),
      task({ completed: true, completed_at: "2026-06-22T10:00:00.000Z", created_at: "2026-06-20T10:00:00.000Z", due_on: "2026-06-21" }),
      task({ completed: true, completed_at: "2026-05-01T10:00:00.000Z", created_at: "2026-04-20T10:00:00.000Z" }),
      task({ key: "APP-4", due_on: "2026-06-20", priority: "urgent" }),
      task({ key: "APP-5", created_at: "2026-05-01T10:00:00.000Z", last_activity_at: "2026-05-01T10:00:00.000Z", assignee_id: null }),
    ]);
    expect(m.totals).toMatchObject({ total: 5, open: 2, completed_in_period: 2, velocity_per_week: 0.5, overdue: 1, max_days_late: 10, stale: 1, unassigned_open: 1, on_time_sample: 2, on_time_rate: 0.5, cycle_median_days: 6, previous_completed: 0 });
    expect(m.overdue_tasks[0]).toMatchObject({ key: "APP-4", days: 10, assignee: "Karim" });
    expect(m.stale_tasks.map((t) => t.key)).toEqual(["APP-5"]);
    expect(m.findings[0]).toMatchObject({ severity: "high" });
    expect(m.weekly).toHaveLength(4);
    expect(m.weekly.reduce((a, w) => a + w.completed, 0)).toBe(2);
  });
  it("prévoit une fin en retard sur l'échéance, et reste muet sans vélocité", () => {
    const done = [...Array(8)].map((_, i) => task({ completed: true, completed_at: `2026-06-${10 + i}T10:00:00.000Z`, created_at: "2026-06-01T10:00:00.000Z" }));
    const late = compute([...done, ...[...Array(10)].map(() => task({}))], "2026-07-01");
    expect(late.forecast).toMatchObject({ remaining: 10, projected_end: "2026-08-04", margin_days: -34, confidence: "medium" });
    expect(late.findings.some((f) => f.code === "forecast_late")).toBe(true);
    const few = compute([task({ completed: true, completed_at: "2026-06-20T10:00:00.000Z", created_at: "2026-06-01T10:00:00.000Z" }), ...[...Array(10)].map(() => task({}))], "2026-07-01");
    expect(few.findings.find((f) => f.code === "forecast_late")).toMatchObject({ severity: "medium", message: expect.stringMatching(/peu fiable/) });
    const idle = compute([task({})], "2026-07-01");
    expect(idle.forecast).toMatchObject({ projected_end: null, margin_days: null, confidence: "low" });
    expect(idle.findings.some((f) => f.code === "no_throughput")).toBe(true);
  });
  it("ignore une tâche terminée avant sa création pour la durée de traitement", () => {
    expect(compute([task({ completed: true, completed_at: "2026-06-20T10:00:00.000Z", created_at: "2026-06-25T10:00:00.000Z" })]).totals).toMatchObject({ completed_in_period: 1, cycle_sample: 0, cycle_median_days: null });
  });
  it("gère un projet vide", () => {
    expect(compute([]).totals).toMatchObject({ total: 0, completion_rate: 0, on_time_rate: null, cycle_median_days: null });
  });
});

describe("analyse par les coéquipiers", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    for (const u of ["u_alice", "u_karim", "u_hugo"]) await login(u);
  });
  afterEach(async () => { await ctx.app.close(); });

  it("analyze_data respecte les droits du coéquipier", async () => {
    const c = { actorId: "ai_atlas", orgId: await orgId() };
    await expect(ctx.ai.tools.execute(c, "analyze_data", { project_id: await projectId("RH") })).rejects.toThrow(/n'a pas le droit/);
    const all = await ctx.ai.tools.execute(c, "analyze_data", {}) as { scope: string; projects: { name: string }[] };
    expect(all.scope).toBe("portfolio");
    expect(all.projects.map((p) => p.name)).not.toContain("RH · Recrutements 2027");
  });

  it("l'assistant répond à une question d'analyse avec les chiffres calculés", async () => {
    const pid = await projectId("Application mobile");
    const { run_id } = (await api("u_alice", "POST", "/api/ai/chat", { project_id: pid, messages: [{ role: "user", content: "Analyse la vélocité de l'équipe" }] })).body;
    const run = await waitFor(async () => (await api("u_alice", "GET", `/api/ai/runs/${run_id}`)).body, (r) => r.status === "done" || r.status === "failed");
    expect(run.status).toBe("done");
    expect(run.steps.some((s: { tool: string; status: string }) => s.tool === "analyze_data" && s.status === "ok")).toBe(true);
    expect(run.summary).toMatch(/Analyse de Application mobile v2/);
  });

  it("une tâche d'analyse confiée à Atlas ne demande aucune validation et publie le résultat", async () => {
    const pid = await projectId("Application mobile");
    const t = (await api("u_alice", "POST", "/api/tasks", { project_id: pid, title: "Analyser la charge de travail du sprint", assignee_id: "ai_atlas" })).body;
    await waitFor(async () => (await api("u_alice", "GET", `/api/tasks/${t.id}`)).body.comments as { author_id: string; body: string }[], (c) => c.some((x) => x.author_id === "ai_atlas"));
    const detail = (await api("u_alice", "GET", `/api/tasks/${t.id}`)).body;
    expect(detail.comments.at(-1).body).toMatch(/Analyse de/);
    expect((await api("u_alice", "GET", "/api/ai/approvals")).body).toHaveLength(0);
  });

  it("une longue liste de résultats reste exploitable par l'assistant", async () => {
    const org = await orgId();
    const p = await ctx.svc.createProject("u_alice", org, { name: "Charge", key: "CHRG" });
    for (let i = 0; i < 30; i++) await ctx.svc.createTask("u_alice", { project_id: p.id, title: `Tâche ${i} avec un titre assez long pour remplir le résultat`, due_on: "2020-02-02", assignee_id: "u_alice", priority: "high" });
    const { run_id } = (await api("u_alice", "POST", "/api/ai/chat", { project_id: p.id, messages: [{ role: "user", content: "Qu'est-ce qui est en retard ?" }] })).body;
    expect((await waitFor(async () => (await api("u_alice", "GET", `/api/ai/runs/${run_id}`)).body, (r) => r.status === "done" || r.status === "failed")).status).toBe("done");
  });
});

describe("rapports IA", () => {
  beforeEach(async () => {
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    for (const u of ["u_alice", "u_karim", "u_hugo", "u_ines"]) await login(u);
  });
  afterEach(async () => { await ctx.app.close(); });

  it("génère un rapport de projet avec ses indicateurs, et notifie son auteur", async () => {
    const pid = await projectId("Application mobile");
    const created = await start("u_alice", `/api/projects/${pid}/reports`, { agent_id: "ai_atlas", period_days: 30, focus: "Où sont les risques ?" });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("generating");
    expect(created.body.metrics.totals.total).toBeGreaterThan(10);
    const r = await ready("u_alice", created.body.id);
    expect(r.status).toBe("ready");
    expect(r.provider).toBe("demo");
    expect(r.content.title).toMatch(/Application mobile v2/);
    expect(r.content.focus_answer).toMatch(/Où sont les risques/);
    expect(r.content.risks.length).toBeGreaterThan(0);
    const list = (await api("u_alice", "GET", `/api/projects/${pid}/reports`)).body;
    expect(list[0]).toMatchObject({ id: r.id, title: r.content.title });
    expect(list[0].metrics).toBeUndefined();
    await waitFor(async () => (await api("u_alice", "GET", "/api/notifications")).body as { kind: string }[], (n) => n.some((x) => x.kind === "report"));
  });

  it("applique les droits : lecture aux membres du projet, génération aux éditeurs", async () => {
    const pid = await projectId("RH");
    await ctx.svc.setMember("u_alice", pid, "ai_atlas", "viewer");
    await ctx.svc.setMember("u_alice", pid, "u_hugo", "viewer");
    expect((await start("u_hugo", `/api/projects/${pid}/reports`)).status).toBe(403);
    const r = await ready("u_alice", (await start("u_alice", `/api/projects/${pid}/reports`)).body.id);
    expect((await api("u_hugo", "GET", `/api/reports/${r.id}`)).status).toBe(200);
    expect((await api("u_karim", "GET", `/api/reports/${r.id}`)).status).toBe(403);
    expect((await api("u_hugo", "DELETE", `/api/reports/${r.id}`)).status).toBe(403);
    expect((await api("u_alice", "DELETE", `/api/reports/${r.id}`)).status).toBe(200);
    expect((await api("u_alice", "GET", `/api/reports/${r.id}`)).status).toBe(404);
  });

  it("refuse un coéquipier sans accès au projet, ou un humain", async () => {
    const hr = await projectId("RH");
    const res = await start("u_alice", `/api/projects/${hr}/reports`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/n'a pas accès/);
    expect((await start("u_alice", `/api/projects/${hr}/reports`, { agent_id: "u_karim", period_days: 30 })).status).toBe(400);
  });

  it("le portefeuille se limite aux projets communs et reste privé", async () => {
    const created = await start("u_alice", "/api/reports", { agent_id: "ai_atlas", period_days: 90 });
    expect(created.status).toBe(200);
    expect(created.body.metrics.projects.map((p: { name: string }) => p.name)).not.toContain("RH · Recrutements 2027");
    expect(created.body.metrics.excluded_projects).toBeGreaterThanOrEqual(1);
    const r = await ready("u_alice", created.body.id);
    expect(r.status).toBe("ready");
    expect((await api("u_karim", "GET", `/api/reports/${r.id}`)).status).toBe(403);
    expect((await api("u_karim", "GET", "/api/reports")).body).toHaveLength(0);
  });

  it("consigne l'échec de rédaction, refuse un doublon, et conserve les indicateurs", async () => {
    await ctx.app.close();
    let release: (() => void) | undefined;
    const provider: AiProvider = {
      name: "demo",
      turn: async () => ({ stop_reason: "end_turn", content: [] }),
      json: async <T,>(_req: JsonRequest) => { await new Promise<void>((r) => { release = r; }); throw Object.assign(new Error("x"), { status: 429 }) as unknown as T; },
    };
    ctx = await buildApp({ provider });
    for (const u of ["u_alice"]) await login(u);
    const pid = await projectId("Application mobile");
    const created = await start("u_alice", `/api/projects/${pid}/reports`);
    expect((await start("u_alice", `/api/projects/${pid}/reports`)).status).toBe(400);
    await waitFor(async () => release, (v) => !!v);
    release!();
    const r = await ready("u_alice", created.body.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Limite de requêtes/);
    expect(r.metrics.totals.total).toBeGreaterThan(10);
  });

  it("un rapport interrompu par un redémarrage est marqué en échec", async () => {
    const pid = await projectId("Application mobile");
    const r = await ready("u_alice", (await start("u_alice", `/api/projects/${pid}/reports`)).body.id);
    await ctx.db.query("UPDATE ai_reports SET status = 'generating' WHERE id = $1", [r.id]);
    await ctx.reports.init();
    expect((await api("u_alice", "GET", `/api/reports/${r.id}`)).body).toMatchObject({ status: "failed", error: "Interrompu par un redémarrage du serveur" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppOptions } from "./app.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};
async function api(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies.a } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
async function start(provider: AppOptions["provider"] = "demo") {
  ctx = await buildApp({ provider, demoDelayMs: 0 });
  cookies.a = String(([] as string[]).concat((await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: "u_alice" } })).headers["set-cookie"] as string)[0]).split(";")[0];
}
afterEach(async () => { vi.restoreAllMocks(); await ctx.app.close(); });

describe("Q-06 et Q-07 : performance", () => {
  it("la liste des projets ne fait pas une requête par projet", async () => {
    await start();
    for (let i = 0; i < 6; i++) await api("POST", "/api/projects", { name: `P${i}` });
    const spy = vi.spyOn(ctx.db, "query");
    const res = await api("GET", "/api/projects");
    expect(res.body.length).toBeGreaterThan(6);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
    expect(res.body.every((p: { members: string[] }) => Array.isArray(p.members))).toBe(true);
  });
  it("toutes les clés étrangères sont indexées", async () => {
    await start();
    const missing = await ctx.db.query<{ t: string; col: string }>(`SELECT c.conrelid::regclass::text AS t, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`);
    expect(missing).toEqual([]);
  });
});

describe("Q-09 : traçabilité", () => {
  it("supprimer un projet conserve son historique dans l'organisation", async () => {
    await start();
    const p = (await api("POST", "/api/projects", { name: "Éphémère" })).body as { id: string; name: string; org_id: string };
    const t = (await api("POST", "/api/tasks", { project_id: p.id, title: "T" })).body as { id: string };
    expect((await api("DELETE", `/api/projects/${p.id}`, { confirm: p.name })).status).toBe(200);
    expect(t.id).toBeTruthy();
    expect((await ctx.db.one<{ n: number }>("SELECT count(*)::int AS n FROM activity WHERE org_id = $1 AND kind = 'task.created' AND project_id IS NULL", [p.org_id]))!.n).toBe(1);
  });
});

describe("Q-11 et Q-12 : erreurs et arrêt", () => {
  const stub = { name: "stub", async turn({ messages }: { messages: { content: unknown }[] }) {
    const last = messages[messages.length - 1].content;
    if (Array.isArray(last) && last.some((b: { type: string }) => b.type === "tool_result")) return { stop_reason: "end_turn", content: [{ type: "text", text: "fin" }] };
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "list_projects", input: {} }] };
  } };
  it("une erreur technique d'outil ne remonte pas à l'utilisateur", async () => {
    await start(stub as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ctx.ai.tools, "execute").mockRejectedValue(new Error('relation "secrete" does not exist'));
    const run = (await api("POST", "/api/ai/chat", { messages: [{ role: "user", content: "x" }] })).body.run_id as string;
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.stringify((await api("GET", `/api/ai/runs/${run}`)).body)).not.toContain("secrete");
  });
  it("une exécution programmée juste avant l'arrêt ne touche plus la base", async () => {
    await start();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await api("POST", "/api/ai/chat", { messages: [{ role: "user", content: "x" }] });
    await ctx.app.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(errors).not.toHaveBeenCalled();
    ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  });
});

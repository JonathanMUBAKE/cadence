import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { get, openDb } from "./db.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
const cookies: Record<string, string> = {};

async function login(user: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user_id: user } });
  cookies[user] = String(res.headers["set-cookie"]).split(";")[0];
}
async function api(user: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[user] } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const projectId = (name: string) => get<{ id: string }>(ctx.db, "SELECT id FROM projects WHERE name LIKE ?", `%${name}%`)!.id;
const taskId = (title: string) => get<{ id: string }>(ctx.db, "SELECT id FROM tasks WHERE title = ?", title)!.id;

beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_hugo", "u_ines"]) await login(u);
});
afterEach(async () => { await ctx.app.close(); });

describe("migrations de la base", () => {
  it("met à niveau une base créée avant l'ajout d'une colonne", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cadence-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE ai_runs (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, task_id TEXT, project_id TEXT, requested_by TEXT, status TEXT, summary TEXT, error TEXT, provider TEXT, created_at TEXT, finished_at TEXT)");
    old.close();
    const db = openDb(path);
    const cols = (db.prepare("PRAGMA table_info(ai_runs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("rule_id");
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(2);
    db.close();
  });
  it("ne refait pas une migration déjà appliquée", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cadence-")), "new.db");
    openDb(path).close();
    expect(() => openDb(path).close()).not.toThrow();
  });
});

describe("dates de début", () => {
  it("refuse une date de début postérieure à l'échéance", async () => {
    const id = taskId("Tests de non-régression iOS");
    const res = await api("u_alice", "PATCH", `/api/tasks/${id}`, { start_on: "2030-02-10", due_on: "2030-02-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date de début/);
    expect((await api("u_alice", "PATCH", `/api/tasks/${id}`, { start_on: "2030-01-25", due_on: "2030-02-01" })).body.start_on).toBe("2030-01-25");
  });
});

describe("sections", () => {
  it("renomme, réordonne et supprime une section en déplaçant ses tâches", async () => {
    const pid = projectId("Application mobile");
    const p = (await api("u_alice", "GET", `/api/projects/${pid}`)).body;
    const backlog = p.sections[0];
    await api("u_alice", "PATCH", `/api/sections/${backlog.id}`, { name: "Idées" });
    await api("u_alice", "POST", `/api/sections/${backlog.id}/move`, { direction: "right" });
    const after = (await api("u_alice", "GET", `/api/projects/${pid}`)).body.sections;
    expect(after[1]).toMatchObject({ id: backlog.id, name: "Idées" });
    const count = (await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body.length;
    expect((await api("u_alice", "DELETE", `/api/sections/${backlog.id}`)).status).toBe(200);
    expect((await api("u_alice", "GET", `/api/projects/${pid}/tasks`)).body.length).toBe(count);
  });
});

describe("projets : archivage et suppression", () => {
  it("archive puis restaure un projet", async () => {
    const pid = projectId("Refonte du site");
    await api("u_alice", "PATCH", `/api/projects/${pid}`, { archived: true });
    expect((await api("u_alice", "GET", "/api/projects")).body.map((x: { id: string }) => x.id)).not.toContain(pid);
    const archived = (await api("u_alice", "GET", "/api/projects?archived=true")).body;
    expect(archived.map((x: { id: string }) => x.id)).toContain(pid);
    await api("u_alice", "PATCH", `/api/projects/${pid}`, { archived: false });
    expect((await api("u_alice", "GET", "/api/projects")).body.map((x: { id: string }) => x.id)).toContain(pid);
  });
  it("seul un administrateur peut supprimer un projet, avec confirmation du nom", async () => {
    const pid = projectId("Campagne de lancement");
    expect((await api("u_ines", "DELETE", `/api/projects/${pid}`, { confirm: "Campagne de lancement" })).status).toBe(403);
    const wrong = await api("u_hugo", "DELETE", `/api/projects/${pid}`, { confirm: "mauvais nom" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/nom exact/);
  });
  it("l'administrateur du projet le supprime avec ses tâches", async () => {
    const pid = projectId("RH");
    expect((await api("u_alice", "DELETE", `/api/projects/${pid}`, { confirm: "RH · Recrutements 2027" })).status).toBe(200);
    expect(get(ctx.db, "SELECT id FROM tasks WHERE project_id = ?", pid)).toBeUndefined();
  });
});

describe("tâches : dupliquer et déplacer", () => {
  it("duplique une tâche avec ses sous-tâches", async () => {
    const id = taskId("Intégrer le SDK de paiement");
    const copy = (await api("u_alice", "POST", `/api/tasks/${id}/duplicate`, { subtasks: true })).body;
    expect(copy.title).toBe("Copie de Intégrer le SDK de paiement");
    expect((await api("u_alice", "GET", `/api/tasks/${copy.id}`)).body.subtasks).toHaveLength(3);
  });
  it("déplace une tâche vers un autre projet et retire un responsable qui n'en est pas membre", async () => {
    const id = taskId("Tests de non-régression iOS");
    const dest = projectId("Campagne de lancement");
    const moved = (await api("u_alice", "POST", `/api/tasks/${id}/move-project`, { project_id: dest })).body;
    expect(moved.project_id).toBe(dest);
    expect(moved.assignee_id).toBeNull();
    const destSections = (await api("u_alice", "GET", `/api/projects/${dest}`)).body.sections.map((s: { id: string }) => s.id);
    expect(destSections).toContain(moved.section_id);
  });
  it("refuse le déplacement vers un projet où l'on n'est pas éditeur", async () => {
    const id = taskId("Tests de non-régression iOS");
    const res = await api("u_karim", "POST", `/api/tasks/${id}/move-project`, { project_id: projectId("Refonte du site") });
    expect(res.status).toBe(403);
  });
});

describe("commentaires : modifier et supprimer", () => {
  it("l'auteur modifie son commentaire, un autre membre ne peut pas", async () => {
    const id = taskId("Intégrer le SDK de paiement");
    const c = (await api("u_karim", "POST", `/api/tasks/${id}/comments`, { body: "Premier jet" })).body;
    expect((await api("u_alice", "PATCH", `/api/comments/${c.id}`, { body: "Piraté" })).status).toBe(403);
    const edited = (await api("u_karim", "PATCH", `/api/comments/${c.id}`, { body: "Version corrigée" })).body;
    expect(edited).toMatchObject({ body: "Version corrigée" });
    expect(edited.edited_at).toBeTruthy();
  });
  it("l'auteur ou un administrateur du projet peut supprimer", async () => {
    const id = taskId("Intégrer le SDK de paiement");
    const c = (await api("u_karim", "POST", `/api/tasks/${id}/comments`, { body: "À supprimer" })).body;
    expect((await api("u_ines", "DELETE", `/api/comments/${c.id}`)).status).toBe(403);
    expect((await api("u_alice", "DELETE", `/api/comments/${c.id}`)).status).toBe(200);
    expect((await api("u_alice", "GET", `/api/tasks/${id}`)).body.comments.some((x: { id: string }) => x.id === c.id)).toBe(false);
  });
});

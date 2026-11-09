import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";

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
const projectId = async (name: string) =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM projects WHERE name LIKE $1", [`%${name}%`]))!.id;
const taskId = async (title: string) =>
  (await ctx.db.one<{ id: string }>("SELECT id FROM tasks WHERE title = $1", [title]))!.id;

beforeEach(async () => {
  ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
  for (const u of ["u_alice", "u_karim", "u_hugo", "u_ines"]) await login(u);
});
afterEach(async () => {
  await ctx.app.close();
});

describe("migrations de la base", () => {
  it("applique les migrations une seule fois et rouvre une base existante sans erreur", async () => {
    const db = await openDb();
    const v = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(v.map((x) => x.version)).toContain("001");
    const { migrate } = await import("./db.js");
    await expect(migrate(db)).resolves.toBeUndefined();
    expect((await db.query("SELECT version FROM schema_migrations")).length).toBe(v.length);
    await db.close();
  });
  it("renvoie les dates calendaires au format AAAA-MM-JJ et annule une transaction en erreur", async () => {
    const db = await openDb();
    await db.query("INSERT INTO organizations (id, name, slug) VALUES ('o1','Test','test')");
    await expect(
      db.tx(async (q) => {
        await q.query("INSERT INTO organizations (id, name, slug) VALUES ('o2','T2','t2')");
        throw new Error("boum");
      }),
    ).rejects.toThrow("boum");
    expect(await db.one("SELECT id FROM organizations WHERE id = 'o2'")).toBeUndefined();
    const r = await db.one<{ d: string }>("SELECT '2030-02-01'::date AS d");
    expect(r!.d).toBe("2030-02-01");
    await db.close();
  });
});

describe("dates de début", () => {
  it("refuse une date de début postérieure à l'échéance", async () => {
    const id = await taskId("Tests de non-régression iOS");
    const res = await api("u_alice", "PATCH", `/api/tasks/${id}`, { start_on: "2030-02-10", due_on: "2030-02-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date de début/);
    expect(
      (await api("u_alice", "PATCH", `/api/tasks/${id}`, { start_on: "2030-01-25", due_on: "2030-02-01" })).body
        .start_on,
    ).toBe("2030-01-25");
  });
});

describe("sections", () => {
  it("renomme, réordonne et supprime une section en déplaçant ses tâches", async () => {
    const pid = await projectId("Application mobile");
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
    const pid = await projectId("Refonte du site");
    await api("u_alice", "PATCH", `/api/projects/${pid}`, { archived: true });
    expect((await api("u_alice", "GET", "/api/projects")).body.map((x: { id: string }) => x.id)).not.toContain(pid);
    const archived = (await api("u_alice", "GET", "/api/projects?archived=true")).body;
    expect(archived.map((x: { id: string }) => x.id)).toContain(pid);
    await api("u_alice", "PATCH", `/api/projects/${pid}`, { archived: false });
    expect((await api("u_alice", "GET", "/api/projects")).body.map((x: { id: string }) => x.id)).toContain(pid);
  });
  it("seul un administrateur peut supprimer un projet, avec confirmation du nom", async () => {
    const pid = await projectId("Campagne de lancement");
    expect((await api("u_ines", "DELETE", `/api/projects/${pid}`, { confirm: "Campagne de lancement" })).status).toBe(
      403,
    );
    const wrong = await api("u_hugo", "DELETE", `/api/projects/${pid}`, { confirm: "mauvais nom" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/nom exact/);
  });
  it("l'administrateur du projet le supprime avec ses tâches", async () => {
    const pid = await projectId("RH");
    expect((await api("u_alice", "DELETE", `/api/projects/${pid}`, { confirm: "RH · Recrutements 2027" })).status).toBe(
      200,
    );
    expect(await ctx.db.one("SELECT id FROM tasks WHERE project_id = $1", [pid])).toBeUndefined();
  });
});

describe("tâches : dupliquer et déplacer", () => {
  it("duplique une tâche avec ses sous-tâches", async () => {
    const id = await taskId("Intégrer le SDK de paiement");
    const copy = (await api("u_alice", "POST", `/api/tasks/${id}/duplicate`, { subtasks: true })).body;
    expect(copy.title).toBe("Copie de Intégrer le SDK de paiement");
    expect((await api("u_alice", "GET", `/api/tasks/${copy.id}`)).body.subtasks).toHaveLength(3);
  });
  it("déplace une tâche vers un autre projet et retire un responsable qui n'en est pas membre", async () => {
    const id = await taskId("Tests de non-régression iOS");
    const dest = await projectId("Campagne de lancement");
    const moved = (await api("u_alice", "POST", `/api/tasks/${id}/move-project`, { project_id: dest })).body;
    expect(moved.project_id).toBe(dest);
    expect(moved.assignee_id).toBeNull();
    const destSections = (await api("u_alice", "GET", `/api/projects/${dest}`)).body.sections.map(
      (s: { id: string }) => s.id,
    );
    expect(destSections).toContain(moved.section_id);
  });
  it("refuse le déplacement vers un projet où l'on n'est pas éditeur", async () => {
    const id = await taskId("Tests de non-régression iOS");
    const res = await api("u_karim", "POST", `/api/tasks/${id}/move-project`, {
      project_id: await projectId("Refonte du site"),
    });
    expect(res.status).toBe(403);
  });
});

describe("commentaires : modifier et supprimer", () => {
  it("l'auteur modifie son commentaire, un autre membre ne peut pas", async () => {
    const id = await taskId("Intégrer le SDK de paiement");
    const c = (await api("u_karim", "POST", `/api/tasks/${id}/comments`, { body: "Premier jet" })).body;
    expect((await api("u_alice", "PATCH", `/api/comments/${c.id}`, { body: "Piraté" })).status).toBe(403);
    const edited = (await api("u_karim", "PATCH", `/api/comments/${c.id}`, { body: "Version corrigée" })).body;
    expect(edited).toMatchObject({ body: "Version corrigée" });
    expect(edited.edited_at).toBeTruthy();
  });
  it("l'auteur ou un administrateur du projet peut supprimer", async () => {
    const id = await taskId("Intégrer le SDK de paiement");
    const c = (await api("u_karim", "POST", `/api/tasks/${id}/comments`, { body: "À supprimer" })).body;
    expect((await api("u_ines", "DELETE", `/api/comments/${c.id}`)).status).toBe(403);
    expect((await api("u_alice", "DELETE", `/api/comments/${c.id}`)).status).toBe(200);
    expect(
      (await api("u_alice", "GET", `/api/tasks/${id}`)).body.comments.some((x: { id: string }) => x.id === c.id),
    ).toBe(false);
  });
});

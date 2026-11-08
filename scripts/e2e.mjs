// Test de bout en bout : démarre Cadence (mode démo), pilote un vrai navigateur, vérifie le parcours IA.
// Usage : npm run build && npm run e2e
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PORT = 4321;
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ["server/dist/index.js"], {
  env: { ...process.env, PORT: String(PORT), DATABASE_PATH: ":memory:", ANTHROPIC_API_KEY: "", NODE_ENV: "test" },
  stdio: "inherit",
});
const step = (m) => console.log(`  ✓ ${m}`);
let browser;

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/auth/users`)).ok) break; } catch {} await sleep(100); }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.getByText("Alice Martin").click();
  await page.getByRole("heading", { name: /Alice/ }).waitFor();
  step("connexion et accueil");

  await page.getByRole("link", { name: /Application mobile v2/ }).first().click();
  await page.getByRole("link", { name: "Tableau", exact: true }).click();
  await page.getByText("Point d'avancement hebdo").first().click();
  await page.getByRole("dialog", { name: "Détail de la tâche" }).waitFor();
  step("tableau Kanban et panneau de tâche");

  await page.getByRole("button", { name: /Confier à Atlas/ }).click();
  let approved = 0;
  for (let i = 0; i < 40; i++) {
    const btn = page.getByRole("button", { name: "Autoriser" }).first();
    if (await btn.count()) { if (await btn.click({ timeout: 2000 }).then(() => true, () => false)) approved++; await sleep(300); continue; }
    if (await page.getByText(/Point sur #\d+/).count()) break;
    await sleep(250);
  }
  assert.ok(approved >= 2, `au moins deux validations attendues, reçu ${approved}`);
  await page.getByText(/Point sur #\d+/).first().waitFor();
  step(`Atlas a travaillé, ${approved} action(s) validée(s), compte rendu publié`);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+j");
  await page.getByRole("button", { name: "Qu'est-ce qui est en retard, et pourquoi ?" }).click();
  await page.getByText(/J'ai trouvé \d+ tâche/).waitFor();
  step("l'assistant répond avec les tâches en retard");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nE2E : OK");
} catch (e) {
  console.error("\nE2E : ÉCHEC\n", e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}

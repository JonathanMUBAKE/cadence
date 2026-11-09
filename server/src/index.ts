import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildApp } from "./app.js";
import { loadLocalSecret, startupProblems } from "./secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4000);
// La connexion de démonstration n'a pas de mot de passe : par défaut, seul cet ordinateur y accède
const host = process.env.HOST || "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL || undefined;
const dataDir = process.env.DATA_DIR === ":memory:" ? undefined : process.env.DATA_DIR || (databaseUrl ? undefined : resolve(here, "../data"));

const problems = startupProblems(process.env, { host, databaseUrl: !!databaseUrl });
if (problems.length) {
  console.error(`\n  Cadence ne peut pas démarrer :\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  process.exit(1);
}
if (dataDir) loadLocalSecret(dataDir);

const { app, provider, db } = await buildApp({
  databaseUrl,
  dataDir,
  webDist: resolve(here, "../../web/dist"),
  logger: process.env.NODE_ENV !== "test",
});

await app.listen({ port, host });
console.log(`\n  Cadence → http://localhost:${port}`);
console.log(`  Base : ${db.kind === "postgres" ? "PostgreSQL (DATABASE_URL)" : `PostgreSQL embarqué (PGlite)${dataDir ? ` dans ${dataDir}` : ", en mémoire"}`}`);
console.log(provider.name === "anthropic"
  ? "  IA : Claude (clé ANTHROPIC_API_KEY détectée)\n"
  : "  IA : mode démo (aucune clé ANTHROPIC_API_KEY) — définissez-la pour utiliser Claude\n");

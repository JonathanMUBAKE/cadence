import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";

const { app, provider } = await buildApp({
  dbPath: process.env.DATABASE_PATH || resolve(here, "../cadence.db"),
  webDist: resolve(here, "../../web/dist"),
  logger: process.env.NODE_ENV !== "test",
});

await app.listen({ port, host });
console.log(`\n  Cadence → http://localhost:${port}`);
console.log(provider.name === "anthropic"
  ? "  IA : Claude (clé ANTHROPIC_API_KEY détectée)\n"
  : "  IA : mode démo (aucune clé ANTHROPIC_API_KEY) — définissez-la pour utiliser Claude\n");

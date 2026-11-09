import { openDb } from "./db.js";

// Applique les migrations sur la base désignée par DATABASE_URL (Supabase, etc.), puis s'arrête.
const url = process.env.DATABASE_URL;
if (!url) { console.error("Définissez DATABASE_URL (chaîne de connexion PostgreSQL)."); process.exit(1); }
const db = await openDb({ url });
const done = await db.query<{ version: string; applied_at: string }>("SELECT version, applied_at FROM schema_migrations ORDER BY version");
console.log("Migrations appliquées :", done.map((m) => m.version).join(", "));
await db.close();

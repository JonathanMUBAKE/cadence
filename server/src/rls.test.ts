import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";

describe("sécurité Supabase", () => {
  it("un rôle comme « anon » ne lit aucune ligne, même s'il a le droit SELECT", async () => {
    const db = await openDb();
    await db.query("INSERT INTO users (id, name) VALUES ('u1', 'Secret')");
    await db.exec(
      "CREATE ROLE anon NOLOGIN; GRANT USAGE ON SCHEMA public TO anon; GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;",
    );
    const rows = await db.tx(async (q) => {
      await q.query("SET LOCAL ROLE anon");
      return q.query("SELECT * FROM users");
    });
    expect(rows).toHaveLength(0);
    expect(await db.query("SELECT * FROM users")).toHaveLength(1); // le propriétaire (serveur Cadence) garde l'accès
    await db.close();
  });
});

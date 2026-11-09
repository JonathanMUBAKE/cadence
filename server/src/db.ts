import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

/**
 * Accès PostgreSQL. Même SQL partout :
 * - production : Supabase (ou tout PostgreSQL) via `DATABASE_URL` et le pool `pg` ;
 * - tests et démo : PGlite, PostgreSQL embarqué (en mémoire, ou dans un dossier de données).
 */
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Queryable {
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
  /** Exécute `fn` dans une transaction ; tout est annulé si elle lève. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}
export type Row = Record<string, unknown>;

// Dates calendaires en « AAAA-MM-JJ », horodatages en ISO 8601, partout.
const DATE = 1082, TIMESTAMPTZ = 1184, TIMESTAMP = 1114;
const iso = (v: string) => new Date(v).toISOString();

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  constructor(private db: PGlite) {}
  async query<T>(sql: string, params: unknown[] = []) { return (await this.db.query<T>(sql, params)).rows; }
  async one<T>(sql: string, params: unknown[] = []) { return (await this.query<T>(sql, params))[0]; }
  async exec(sql: string) { await this.db.exec(sql); }
  async tx<T>(fn: (q: Queryable) => Promise<T>) {
    return this.db.transaction(async (t) => fn({ query: async <R>(sql: string, params: unknown[] = []) => (await t.query<R>(sql, params)).rows }));
  }
  async close() { await this.db.close(); }
}

class PgDb implements Db {
  readonly kind = "postgres" as const;
  constructor(private pool: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []) { return (await this.pool.query(sql, params)).rows as T[]; }
  async one<T>(sql: string, params: unknown[] = []) { return (await this.query<T>(sql, params))[0]; }
  async exec(sql: string) { await this.pool.query(sql); }
  async tx<T>(fn: (q: Queryable) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({ query: async <R>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[] });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async close() { await this.pool.end(); }
}

export interface OpenOptions { url?: string; dataDir?: string; migrationsDir?: string }

export async function openDb(opts: OpenOptions = {}): Promise<Db> {
  let db: Db;
  if (opts.url) {
    pg.types.setTypeParser(DATE, (v) => v);
    pg.types.setTypeParser(TIMESTAMPTZ, iso);
    pg.types.setTypeParser(TIMESTAMP, iso);
    const ssl = /supabase\.(co|com)|sslmode=require/.test(opts.url) ? { rejectUnauthorized: false } : undefined;
    db = new PgDb(new pg.Pool({ connectionString: opts.url, ssl, max: 10 }));
  } else {
    if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
    const lite = new PGlite({ dataDir: opts.dataDir, parsers: { [DATE]: (v: string) => v, [TIMESTAMPTZ]: iso, [TIMESTAMP]: iso } });
    db = new PgliteDb(lite);
  }
  await migrate(db, opts.migrationsDir);
  return db;
}

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, "../migrations");

/** Applique, dans l'ordre et une seule fois, les fichiers `NNN_nom.sql`. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR) {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version));
  for (const file of readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    const version = file.split("_")[0];
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
  }
}

/** Découpe un fichier SQL en instructions, sans couper le corps $$…$$ d'une fonction. */
function splitSql(sql: string) {
  return (sql.replace(/--.*$/gm, "").match(/(?:\$\$[\s\S]*?\$\$|[^;])+/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
export const now = () => new Date().toISOString();

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { LEGACY_SECRET, startupProblems } from "./secrets.js";

const STRONG = "x".repeat(32);
const local = { host: "127.0.0.1", databaseUrl: false };

describe("configuration au démarrage", () => {
  it("laisse démarrer une installation locale sans configuration", () => {
    expect(startupProblems({}, local)).toEqual([]);
  });
  it("refuse d'exposer la connexion sans mot de passe sur le réseau, sauf accord explicite", () => {
    expect(startupProblems({}, { ...local, host: "0.0.0.0" })[0]).toMatch(/CADENCE_DEMO=1/);
    expect(startupProblems({ CADENCE_DEMO: "1" }, { ...local, host: "0.0.0.0" })).toEqual([]);
  });
  it("exige des secrets solides en production et avec une base distante", () => {
    expect(startupProblems({ NODE_ENV: "production", CADENCE_DEMO: "1" }, local)).toHaveLength(2);
    expect(startupProblems({ COOKIE_SECRET: STRONG, CADENCE_SECRET_KEY: "court" }, { ...local, databaseUrl: true })).toEqual([expect.stringMatching(/CADENCE_SECRET_KEY/)]);
    expect(startupProblems({ NODE_ENV: "production", CADENCE_DEMO: "1", COOKIE_SECRET: LEGACY_SECRET, CADENCE_SECRET_KEY: STRONG }, local)).toEqual([expect.stringMatching(/COOKIE_SECRET/)]);
    expect(startupProblems({ NODE_ENV: "production", CADENCE_DEMO: "1", COOKIE_SECRET: STRONG, CADENCE_SECRET_KEY: STRONG }, local)).toEqual([]);
  });
});

describe("secrets", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("crée un secret local unique, le réutilise et ne touche pas au dossier de la base", async () => {
    vi.stubEnv("COOKIE_SECRET", ""); vi.stubEnv("CADENCE_SECRET_KEY", "");
    const parent = mkdtempSync(join(tmpdir(), "cadence-")); dirs.push(parent);
    const data = join(parent, "data");
    const first = await import("./secrets.js");
    first.loadLocalSecret(data);
    const value = first.cookieSecret();
    expect(value).toHaveLength(64);
    expect(value).not.toBe(LEGACY_SECRET);
    expect(readFileSync(join(parent, ".cadence-secret"), "utf8")).toBe(value);
    expect(existsSync(data)).toBe(false);
    vi.resetModules();
    const second = await import("./secrets.js");
    second.loadLocalSecret(data);
    expect(second.cookieSecret()).toBe(value);
    expect(second.encryptionSecret()).toBe(value);
  });

  it("chiffre sans le secret public et relit les mots de passe déjà enregistrés avec lui", async () => {
    vi.stubEnv("CADENCE_SECRET_KEY", STRONG);
    const { open, seal } = await import("./crypto.js");
    expect(open(seal("mot-de-passe"))).toBe("mot-de-passe");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", createHash("sha256").update(LEGACY_SECRET).digest(), iv);
    const enc = Buffer.concat([c.update("ancien", "utf8"), c.final()]);
    expect(open("v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"))).toBe("ancien");
    expect(() => open("v1:" + randomBytes(48).toString("base64"))).toThrow();
  });

  it("refuse une session signée avec l'ancien secret public", async () => {
    const ctx = await buildApp({ provider: "demo", demoDelayMs: 0 });
    try {
      const forged = cookie.sign("u_alice", LEGACY_SECRET);
      const res = await ctx.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `cadence_uid=${encodeURIComponent(forged)}` } });
      expect(res.statusCode).toBe(401);
    } finally { await ctx.app.close(); }
  });
});

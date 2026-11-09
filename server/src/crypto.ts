import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { encryptionSecret } from "./secrets.js";

/**
 * Chiffrement des secrets stockés en base (mot de passe SMTP, jetons de connecteurs).
 * AES-256-GCM, clé dérivée de `CADENCE_SECRET_KEY` (à défaut `COOKIE_SECRET`, puis du secret local).
 * Format : "v2:" + base64(iv | tag | chiffré). L'ancien format "v1" reste lisible.
 */
const keyV2 = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "", "cadence/secrets/v2", 32));
const keyV1 = (secret: string) => createHash("sha256").update(secret).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyV2(encryptionSecret()), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v2:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function open(sealed: string): string {
  const version = sealed.slice(0, 3);
  if (version !== "v1:" && version !== "v2:") throw new Error("Secret illisible");
  const buf = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv(
    "aes-256-gcm",
    version === "v2:" ? keyV2(encryptionSecret()) : keyV1(encryptionSecret()),
    buf.subarray(0, 12),
  );
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

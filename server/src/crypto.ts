import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { LEGACY_SECRET, encryptionSecret } from "./secrets.js";

/**
 * Chiffrement des secrets stockés en base (mot de passe SMTP, jetons de connecteurs).
 * AES-256-GCM, clé dérivée de `CADENCE_SECRET_KEY` (à défaut `COOKIE_SECRET`, puis du secret local).
 * Format : "v1:" + base64(iv | tag | chiffré).
 */
const key = (secret: string) => createHash("sha256").update(secret).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(encryptionSecret()), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function decrypt(buf: Buffer, secret: string) {
  const d = createDecipheriv("aes-256-gcm", key(secret), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export function open(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("Secret illisible");
  const buf = Buffer.from(sealed.slice(3), "base64");
  try {
    return decrypt(buf, encryptionSecret());
  } catch (err) {
    // Un mot de passe enregistré avant la suppression du secret par défaut doit rester utilisable
    try { return decrypt(buf, LEGACY_SECRET); } catch { throw err; }
  }
}

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Codes à usage temporaire (RFC 6238), compatibles avec Google Authenticator, Microsoft Authenticator, 1Password… */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD = 30;

export function generateSecret() {
  let bits = "", out = "";
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string) {
  let bits = "";
  for (const c of secret) bits += ALPHABET.indexOf(c).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const currentStep = () => Math.floor(Date.now() / 1000 / PERIOD);
export const totpCode = (secret: string) => codeAt(secret, currentStep());

/** Renvoie l'intervalle reconnu, ou null. Une dérive d'horloge de 30 secondes est tolérée. */
export function matchTotp(secret: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  for (const step of [currentStep() - 1, currentStep(), currentStep() + 1]) if (timingSafeEqual(Buffer.from(codeAt(secret, step)), given)) return step;
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer = "Cadence") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD}`;

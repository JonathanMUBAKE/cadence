import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "../services.js";

// Paramètres scrypt recommandés par l'OWASP : N=2^17, r=8, p=1
const N = 131_072, R = 8, P = 1, KEY_LENGTH = 32;
const MAX_MEMORY = 256 * 1024 * 1024;
export const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

// Chaque calcul occupe 128 Mo : sans plafond, des connexions anonymes simultanées épuiseraient la mémoire du serveur
const MAX_RUNNING = 2, MAX_WAITING = 32;
let running = 0;
const waiting: (() => void)[] = [];
export const passwordWork = () => ({ running, waiting: waiting.length });

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running < MAX_RUNNING) running++;
  else if (waiting.length >= MAX_WAITING) throw new HttpError(429, "Trop de connexions en cours. Réessayez dans quelques instants.");
  else await new Promise<void>((go) => waiting.push(go)); // La place libérée est transmise directement
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else running--; }
}

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, length: number) => limited(() => new Promise<Buffer>((resolve, reject) => {
  scrypt(password.normalize("NFKC"), salt, length, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key)));
}));

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected);
}

let decoy: Promise<string> | null = null;
/** Même durée de calcul quand le compte n'existe pas : le temps de réponse ne doit rien révéler. */
export async function burnPasswordTime(password: string) {
  decoy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await decoy);
}

const COMMON = ["password", "motdepasse", "azerty", "qwerty", "123456", "admin", "bienvenue", "welcome", "soleil", "cadence", "changeme", "letmein", "iloveyou", "football", "secret"];

/** Règles du NIST : la longueur et le refus des mots de passe courants valent mieux que des caractères imposés. */
export function passwordProblem(password: string, who: { email?: string | null; name?: string | null }): string | null {
  if (password.length < PASSWORD_MIN) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères`;
  if (password.length > PASSWORD_MAX) return `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX} caractères`;
  const flat = password.toLowerCase().replace(/[\s\-_.!@#$%^&*]/g, "");
  if (new Set(flat).size <= 3 || COMMON.some((w) => flat.startsWith(w) && flat.slice(w.length).replace(/\d/g, "").length === 0)) return "Ce mot de passe est trop courant : choisissez une phrase plus personnelle";
  const local = who.email?.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (local && local.length >= 4 && flat.includes(local)) return "Le mot de passe ne doit pas reprendre votre adresse e-mail";
  const first = who.name?.split(" ")[0]?.toLowerCase();
  if (first && first.length >= 4 && flat === first) return "Le mot de passe ne doit pas être votre prénom";
  return null;
}

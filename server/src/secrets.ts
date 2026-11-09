import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Ancienne valeur par défaut, publique : conservée uniquement pour relire les données déjà chiffrées avec elle. */
export const LEGACY_SECRET = "cadence-dev-secret-change-me";
export const MIN_SECRET_LENGTH = 32;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const generate = () => randomBytes(32).toString("hex");

// Sans variable ni dossier de données (tests, base en mémoire), le secret ne vit que le temps du processus
let local: string | null = null;
const localSecret = () => (local ??= generate());

export const cookieSecret = () => process.env.COOKIE_SECRET || localSecret();
export const encryptionSecret = () => process.env.CADENCE_SECRET_KEY || process.env.COOKIE_SECRET || localSecret();

/** Installation locale : crée au premier démarrage un secret propre à cette machine, à côté du dossier de données. */
export function loadLocalSecret(dataDir: string) {
  if (process.env.COOKIE_SECRET) return;
  const file = join(dirname(resolve(dataDir)), ".cadence-secret");
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, generate(), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`Secret local invalide : supprimez ${file} pour en créer un nouveau`);
  local = secret;
}

/**
 * TRUST_PROXY : nombre de proxys devant Cadence, ou leurs adresses (IP, CIDR).
 * Jamais « tout accepter » : l'adresse la plus à gauche de X-Forwarded-For est choisie par le visiteur, qui échapperait ainsi aux limites.
 */
export function trustProxySetting(value = process.env.TRUST_PROXY): boolean | string | ((address: string, hop: number) => boolean) {
  if (!value || value === "0") return false;
  if (!/^\d+$/.test(value)) return value;
  const hops = Number(value);
  return (_address, hop) => hop < hops;
}

/** Raisons de refuser le démarrage : une configuration dangereuse ne doit jamais tourner silencieusement. */
export function startupProblems(env: Record<string, string | undefined>, o: { host: string; databaseUrl: boolean }): string[] {
  const out: string[] = [];
  const production = env.NODE_ENV === "production";
  const exposed = !LOOPBACK.has(o.host);
  if (env.CADENCE_DEMO === "1" && (production || exposed)) out.push("Le mode démo permet de se connecter sans mot de passe : il est réservé à un usage local. Retirez CADENCE_DEMO, ou retirez HOST et NODE_ENV=production.");
  if ((production || exposed) && !env.PUBLIC_URL) out.push("PUBLIC_URL est obligatoire : les liens d'invitation et de réinitialisation envoyés par e-mail en dépendent (ex. https://cadence.exemple.com).");
  if ((production || exposed) && !env.SMTP_URL) out.push("SMTP_URL est obligatoire : la messagerie de la plateforme est seule à prouver qu'une adresse e-mail appartient à la personne invitée.");
  if (production || o.databaseUrl) {
    for (const name of ["COOKIE_SECRET", "CADENCE_SECRET_KEY"]) {
      if ((env[name]?.length ?? 0) < MIN_SECRET_LENGTH) out.push(`${name} est obligatoire ici et doit faire au moins ${MIN_SECRET_LENGTH} caractères.`);
    }
  }
  return out;
}

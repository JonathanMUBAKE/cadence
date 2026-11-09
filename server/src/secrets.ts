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

/** Raisons de refuser le démarrage : une configuration dangereuse ne doit jamais tourner silencieusement. */
export function startupProblems(env: Record<string, string | undefined>, o: { host: string; databaseUrl: boolean }): string[] {
  const out: string[] = [];
  const production = env.NODE_ENV === "production";
  if ((production || !LOOPBACK.has(o.host)) && env.CADENCE_DEMO !== "1") {
    out.push(`La connexion de démonstration, sans mot de passe, serait accessible depuis le réseau (HOST=${o.host}${production ? ", NODE_ENV=production" : ""}). Retirez HOST pour rester sur cet ordinateur, ou définissez CADENCE_DEMO=1 pour accepter ce risque.`);
  }
  if (production || o.databaseUrl) {
    for (const name of ["COOKIE_SECRET", "CADENCE_SECRET_KEY"]) {
      if ((env[name]?.length ?? 0) < MIN_SECRET_LENGTH) out.push(`${name} est obligatoire ici et doit faire au moins ${MIN_SECRET_LENGTH} caractères.`);
    }
  }
  return out;
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { badRequest } from "./services.js";

function isInternal(address: string) {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/** Un hôte saisi par un client ne doit pas servir à atteindre le réseau interne du serveur. Un nom introuvable échouera à l'envoi. */
export async function assertPublicHost(host: string) {
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return;
  }
  if (addresses.some(isInternal)) throw badRequest("Cet hôte SMTP pointe vers un réseau interne : il est refusé");
}

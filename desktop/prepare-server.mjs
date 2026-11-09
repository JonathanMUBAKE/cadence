// Prépare le serveur Cadence embarqué dans l'application de bureau :
// compile le web et le serveur, puis copie le résultat avec ses seules dépendances de production
// dans build/app-server (inclus tel quel dans l'installateur).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(here, "build", "app-server");
const run = (cmd, cwd = root) => { console.log(`> ${cmd}`); execSync(cmd, { cwd, stdio: "inherit" }); };

if (!existsSync(join(root, "node_modules"))) run("npm install");
run("npm run build");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });
cpSync(join(root, "server", "dist"), join(out, "server", "dist"), { recursive: true });
cpSync(join(root, "server", "migrations"), join(out, "server", "migrations"), { recursive: true });
cpSync(join(root, "web", "dist"), join(out, "web", "dist"), { recursive: true });

// Dépendances de production uniquement (toutes en JavaScript ou WebAssembly : valables sur Windows, macOS et Linux)
const pkg = JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8"));
writeFileSync(join(out, "server", "package.json"), JSON.stringify({ name: "cadence-server", private: true, type: "module", dependencies: pkg.dependencies }, null, 2));
run("npm install --omit=dev --no-audit --no-fund --ignore-scripts", join(out, "server"));
console.log(`\nServeur embarqué prêt : ${out}`);

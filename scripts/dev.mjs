// Lance l'API et Vite ensemble, sur tous les systèmes (« & » n'exécute rien en parallèle sous Windows).
import { spawn } from "node:child_process";

const run = (workspace) => spawn("npm", ["run", "dev", "-w", workspace], { stdio: "inherit", shell: process.platform === "win32" });
const children = [run("server"), run("web")];
const stop = (code = 0) => { for (const c of children) c.kill(); process.exit(code); };

for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

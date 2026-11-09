// Cadence, application de bureau.
// Démarre le serveur Cadence (base PostgreSQL embarquée) sur un port libre de la machine,
// puis l'affiche dans une fenêtre. Les données restent sur l'ordinateur, dans le dossier utilisateur.
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let win = null;
let server = null;
let url = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const serverRoot = () => app.isPackaged ? path.join(process.resourcesPath, "app-server") : path.join(__dirname, "build", "app-server");
const dataDir = () => path.join(app.getPath("userData"), "donnees");

/** Secret local, créé au premier lancement : signe les sessions et chiffre les mots de passe enregistrés. */
function localSecret() {
  const file = path.join(app.getPath("userData"), "secret.key");
  if (!existsSync(file)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 }); }
  return readFileSync(file, "utf8").trim();
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer() {
  const secret = localSecret();
  process.env.COOKIE_SECRET ||= secret;
  process.env.CADENCE_SECRET_KEY ||= secret;
  process.env.NODE_ENV ||= "production";
  // Application locale et mono-poste : on garde le choix d'un profil, sans mot de passe
  process.env.CADENCE_DEMO ||= "1";
  mkdirSync(dataDir(), { recursive: true });
  const root = serverRoot();
  const { buildApp } = await import(pathToFileURL(path.join(root, "server", "dist", "app.js")).href);
  const built = await buildApp({ dataDir: dataDir(), webDist: path.join(root, "web", "dist"), logger: false });
  const port = await freePort();
  await built.app.listen({ port, host: "127.0.0.1" });
  server = built.app;
  return `http://127.0.0.1:${port}`;
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "Fichier", submenu: [
      { label: "Ouvrir dans le navigateur", click: () => url && shell.openExternal(url) },
      { label: "Ouvrir le dossier des données", click: () => shell.openPath(dataDir()) },
      { type: "separator" },
      isMac ? { role: "close", label: "Fermer" } : { role: "quit", label: "Quitter" },
    ] },
    { label: "Édition", submenu: [
      { role: "undo", label: "Annuler" }, { role: "redo", label: "Rétablir" }, { type: "separator" },
      { role: "cut", label: "Couper" }, { role: "copy", label: "Copier" }, { role: "paste", label: "Coller" }, { role: "selectAll", label: "Tout sélectionner" },
    ] },
    { label: "Affichage", submenu: [
      { role: "reload", label: "Actualiser" }, { role: "togglefullscreen", label: "Plein écran" }, { type: "separator" },
      { role: "zoomIn", label: "Zoom avant" }, { role: "zoomOut", label: "Zoom arrière" }, { role: "resetZoom", label: "Taille réelle" },
      { type: "separator" }, { role: "toggleDevTools", label: "Outils de développement" },
    ] },
  ]));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 600, title: "Cadence", show: false,
    backgroundColor: "#f7f7f8", autoHideMenuBar: process.platform !== "darwin",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  // Les liens externes s'ouvrent dans le navigateur, jamais dans l'application
  win.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https?:/.test(target)) shell.openExternal(target); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, target) => { if (url && !target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); } });
  win.on("closed", () => { win = null; });

  await win.loadFile(path.join(__dirname, "splash.html"));
  try {
    url = url ?? (await startServer());
    await win.loadURL(url);
  } catch (err) {
    dialog.showErrorBox("Cadence n'a pas pu démarrer", `${err && err.stack ? err.stack : err}\n\nDossier des données : ${dataDir()}`);
    app.quit();
  }
}

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on("activate", () => { if (!win) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

let closing = false;
app.on("before-quit", (e) => {
  if (closing || !server) return;
  // Ferme proprement la base embarquée avant de quitter
  e.preventDefault(); closing = true;
  Promise.race([server.close(), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.quit());
});

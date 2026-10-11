// TranspoZ, application de bureau (Electron).
//
// L'interface est celle du dossier web/, servie telle quelle par un protocole
// interne (app://transpoz/). La seule chose que faisait le serveur — appeler
// Audiveris sur les PDF et les images — est faite ici, avec l'Audiveris livré
// dans l'application (voir scripts/fetch-audiveris.mjs). La fusion des pages
// et la lecture des fichiers produits se font dans l'interface (web/merge.js).

import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fichiers de l'interface
// ---------------------------------------------------------------------------

// Application installée : resources/web (préparé par scripts/prepare-web.mjs).
// Développement : ../web et OpenSheetMusicDisplay depuis ../node_modules.
const WEB_ROOTS = app.isPackaged
  ? [path.join(process.resourcesPath, "web")]
  : [path.join(here, "..", "web")];
const OSMD_DEV = path.join(here, "..", "node_modules", "opensheetmusicdisplay", "build");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".musicxml": "application/vnd.recordare.musicxml+xml",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function resolveWebFile(urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const candidates = WEB_ROOTS.map((root) => [root, path.join(root, relative)]);
  if (!app.isPackaged && relative.startsWith("vendor/osmd/")) {
    candidates.push([OSMD_DEV, path.join(OSMD_DEV, relative.slice("vendor/osmd/".length))]);
  }
  for (const [root, file] of candidates) {
    // Pas de sortie du dossier de l'interface (« ../ »).
    if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) continue;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------------------
// Audiveris
// ---------------------------------------------------------------------------

function findAudiveris() {
  if (process.env.AUDIVERIS_CMD) return process.env.AUDIVERIS_CMD;
  const exe = process.platform === "win32" ? "Audiveris.exe" : path.join("bin", "Audiveris");
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, "audiveris")]
    : [path.join(here, "vendor", process.platform === "win32" ? "audiveris-win" : "audiveris-linux")];
  for (const root of roots) {
    const file = path.join(root, exe);
    if (existsSync(file)) return file;
  }
  return null;
}

function detectKind(name, data) {
  const head = Buffer.from(data.subarray(0, 8));
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return ".pdf";
  if (head[0] === 0xff && head[1] === 0xd8) return ".jpg";
  if (head.subarray(1, 4).toString("latin1") === "PNG") return ".png";
  if (["II*\0", "MM\0*"].includes(head.subarray(0, 4).toString("latin1"))) return ".tif";
  if (head.subarray(0, 2).toString("latin1") === "BM") return ".bmp";
  const ext = path.extname(name).toLowerCase();
  if ([".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"].includes(ext)) return ext;
  throw new Error(`Format de fichier non reconnu : ${name}`);
}

function run(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, windowsHide: true });
    let output = "";
    const keep = (chunk) => {
      output = (output + chunk.toString()).slice(-20000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("La reconnaissance a pris trop de temps."));
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Impossible de lancer Audiveris : ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else {
        const tail = output.trim().split(/\r?\n/).slice(-5).join(" / ");
        reject(new Error(`Échec de la reconnaissance : ${tail}`));
      }
    });
  });
}

const naturalKey = (s) => s.split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? t.padStart(12, "0") : t)).join("");

async function listOutputs(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(mxl|xml|musicxml)$/i.test(entry.name)) {
      found.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return found.sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));
}

/**
 * Reconnaît les fichiers (pages, dans l'ordre) : renvoie les fichiers MusicXML
 * produits par Audiveris, une ou plusieurs pages par fichier.
 */
async function recognize(files) {
  const command = findAudiveris();
  if (!command) return { error: "Audiveris est introuvable dans l'application." };
  const work = await mkdtemp(path.join(tmpdir(), "transpoz-"));
  try {
    // Dossier de langues vide : pas de lecture de texte (OCR), qui ajoute des
    // textes incohérents et fait perdre des nuances. Même résultat partout.
    const tessdata = path.join(work, "tessdata");
    await mkdir(tessdata);
    const env = { ...process.env, TESSDATA_PREFIX: tessdata };
    const pages = [];
    for (const [index, file] of files.entries()) {
      const input = path.join(work, `page${String(index).padStart(3, "0")}${detectKind(file.name, file.data)}`);
      await writeFile(input, file.data);
      const out = path.join(work, `out${index}`);
      await mkdir(out);
      await run(command, ["-batch", "-export", "-output", out, "--", input], { cwd: work, env });
      const outputs = await listOutputs(out);
      if (!outputs.length) throw new Error(`Aucune portée n'a été reconnue sur ${file.name}.`);
      for (const p of outputs) pages.push({ name: path.basename(p), data: new Uint8Array(await readFile(p)) });
    }
    return { engine: "audiveris", pages };
  } catch (err) {
    return { error: err.message };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

ipcMain.handle("transpoz:status", () => ({ engine: findAudiveris() ? "audiveris" : null }));
ipcMain.handle("transpoz:recognize", (_event, files) => recognize(files));

// ---------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "TranspoZ",
    autoHideMenuBar: true,
    backgroundColor: "#f4f1ea",
    show: !process.env.TRANSPOZ_SELFTEST,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      plugins: true, // visionneuse PDF pour l'original
    },
  });
  // Les liens externes s'ouvrent dans le navigateur, pas dans l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL("app://transpoz/index.html");
  return win;
}

app.whenReady().then(async () => {
  protocol.handle("app", async (request) => {
    const file = resolveWebFile(new URL(request.url).pathname);
    if (!file) return new Response("Introuvable", { status: 404 });
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return new Response(await readFile(file), { headers: { "content-type": type } });
  });
  const win = createWindow();
  if (process.env.TRANSPOZ_SELFTEST) await selfTest(win, process.env.TRANSPOZ_SELFTEST);
});

app.on("window-all-closed", () => app.quit());

// ---------------------------------------------------------------------------
// Auto-test (sans fenêtre visible) : TRANSPOZ_SELFTEST=<partition.pdf|jpg>
// Charge l'interface, fait reconnaître le fichier comme un utilisateur, affiche
// le résultat et quitte. Sert à vérifier une construction de l'application.
// ---------------------------------------------------------------------------

async function selfTest(win, file) {
  const log = (...a) => process.stdout.write(`[auto-test] ${a.join(" ")}\n`);
  let code = 1;
  try {
    await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
    log("Audiveris :", findAudiveris() ?? "introuvable");
    const data = await readFile(file);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const file = new File([new Uint8Array(${JSON.stringify([...data])})], ${JSON.stringify(path.basename(file))});
      const dt = new DataTransfer(); dt.items.add(file);
      document.getElementById("dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      const t0 = Date.now();
      while (!document.querySelector(".tz-note") && Date.now() - t0 < 300000) {
        if (document.querySelector("#status.error")) break;
        await wait(250);
      }
      return { status: document.getElementById("status").textContent, notes: document.querySelectorAll(".tz-note").length };
    })()`);
    log("statut :", result.status);
    log("notes affichées :", result.notes);
    code = result.notes > 0 ? 0 : 1;
  } catch (err) {
    log("erreur :", err.message);
  }
  app.exit(code);
}

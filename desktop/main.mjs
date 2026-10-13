// TranspoZ, application de bureau (Electron).
//
// L'interface est celle du dossier web/, servie telle quelle par un protocole
// interne (app://transpoz/). La seule chose que faisait le serveur — appeler
// Audiveris sur les PDF et les images — est faite ici, avec l'Audiveris livré
// dans l'application (voir scripts/fetch-audiveris.mjs). La fusion des pages
// et la lecture des fichiers produits se font dans l'interface (web/merge.js).

import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Modules partagés avec l'interface : archives zip, chiffrage imposé à la reconnaissance.
const webModule = (name) => import(pathToFileURL(path.join(WEB_ROOTS[0], name)).href);
const { readZip, writeZip } = await webModule("mxl.js");
const { forceTimeInSheet, parseTime } = await webModule("omr-time.js");

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

// Dossier d'Audiveris livré avec l'application (TRANSPOZ_AUDIVERIS_DIR pour en tester un autre).
function audiverisRoot() {
  if (process.env.TRANSPOZ_AUDIVERIS_DIR) return process.env.TRANSPOZ_AUDIVERIS_DIR;
  return app.isPackaged
    ? path.join(process.resourcesPath, "audiveris")
    : path.join(here, "vendor", process.platform === "win32" ? "audiveris-win" : "audiveris-linux");
}

/**
 * Commande pour lancer Audiveris : { command, prefix } (arguments à placer avant ceux d'Audiveris).
 *
 * On lance directement le Java livré avec Audiveris, avec les paramètres de son fichier
 * Audiveris.cfg, plutôt que son lanceur (bin/Audiveris, Audiveris.exe) : installé par un
 * paquet système (.rpm, .deb), ce lanceur interroge le gestionnaire de paquets pour
 * retrouver ses fichiers, ne les trouve pas (ils appartiennent au paquet TranspoZ) et
 * échoue avec « Error opening "Audiveris.cfg" file ».
 */
function findAudiveris() {
  if (process.env.AUDIVERIS_CMD) return { command: process.env.AUDIVERIS_CMD, prefix: [] };
  const root = audiverisRoot();
  const win = process.platform === "win32";
  // Linux : lib/app et lib/runtime ; Windows : app et runtime.
  const appDir = path.join(root, win ? "app" : path.join("lib", "app"));
  const java = path.join(root, win ? "runtime" : path.join("lib", "runtime"), "bin", win ? "java.exe" : "java");
  const cfg = path.join(appDir, "Audiveris.cfg");
  if (existsSync(cfg) && existsSync(java)) {
    const settings = parseLauncherConfig(readFileSync(cfg, "utf8"), appDir, root);
    if (settings.mainClass && settings.classpath.length) {
      return {
        command: java,
        prefix: [...settings.javaOptions, "-cp", settings.classpath.join(path.delimiter), settings.mainClass],
      };
    }
  }
  const launcher = path.join(root, win ? "Audiveris.exe" : path.join("bin", "Audiveris"));
  return existsSync(launcher) ? { command: launcher, prefix: [] } : null;
}

// Fichier .cfg de jpackage : [Application] app.classpath / app.mainclass, [JavaOptions] java-options.
function parseLauncherConfig(text, appDir, rootDir) {
  const expand = (v) => v.replaceAll("$APPDIR", appDir).replaceAll("$ROOTDIR", rootDir);
  const settings = { classpath: [], mainClass: null, javaOptions: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq < 0 || line.startsWith("[") || line.startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    const value = expand(line.slice(eq + 1).trim());
    if (key === "app.classpath") settings.classpath.push(value);
    else if (key === "app.mainclass") settings.mainClass = value;
    else if (key === "java-options") settings.javaOptions.push(value);
  }
  return settings;
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

// Applique le chiffrage à toutes les pages d'un projet Audiveris (.omr, archive zip).
async function forceTimeInBook(book, time) {
  const entries = await readZip(new Uint8Array(await readFile(book)));
  const files = [];
  for (const [name, data] of entries) {
    if (/^sheet#\d+\/sheet#\d+\.xml$/.test(name)) {
      const { xml } = forceTimeInSheet(new TextDecoder().decode(data), time);
      files.push({ name, data: new TextEncoder().encode(xml) });
    } else files.push({ name, data });
  }
  await writeFile(book, writeZip(files));
}

/**
 * Reconnaît les fichiers (pages, dans l'ordre) : renvoie les fichiers MusicXML
 * produits par Audiveris, une ou plusieurs pages par fichier.
 * options.time (« 2/2 »…) impose le chiffrage : Audiveris s'arrête après la lecture
 * des débuts de portée, le chiffrage est remplacé dans son projet, puis il termine
 * (même déroulement que le serveur, server/omr.py).
 */
async function recognize(files, options = {}) {
  const time = parseTime(options.time);
  const audiveris = findAudiveris();
  if (!audiveris) return { error: "Audiveris est introuvable dans l'application." };
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
      const audiverisRun = (args) => run(audiveris.command, [...audiveris.prefix, "-batch", ...args], { cwd: work, env });
      if (time) {
        await audiverisRun(["-save", "-step", "HEADERS", "-output", out, "--", input]);
        const book = (await readdir(out, { recursive: true })).find((f) => f.endsWith(".omr"));
        if (!book) throw new Error(`Aucune portée n'a été reconnue sur ${file.name}.`);
        await forceTimeInBook(path.join(out, book), time);
        await audiverisRun(["-export", "-output", out, "--", path.join(out, book)]);
      } else {
        await audiverisRun(["-export", "-output", out, "--", input]);
      }
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
ipcMain.handle("transpoz:recognize", (_event, files, options) => recognize(files, options));

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
// Auto-test (sans fenêtre visible) : TRANSPOZ_SELFTEST=<partition.pdf|png>
// Charge l'interface, fait reconnaître le fichier comme un utilisateur, affiche
// le résultat et quitte. Sert à vérifier une construction de l'application.
// Facultatif : TRANSPOZ_SELFTEST_TIME (chiffrage imposé, ex. 4/4),
// TRANSPOZ_SELFTEST_SHOT (capture PNG de la fenêtre, original affiché),
// TRANSPOZ_SELFTEST_PRINT (impression de la partition en PDF).
// ---------------------------------------------------------------------------

async function selfTest(win, file) {
  const log = (...a) => process.stdout.write(`[auto-test] ${a.join(" ")}\n`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let code = 1;
  try {
    await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
    log("Audiveris :", findAudiveris()?.command ?? "introuvable");
    const data = await readFile(file);
    const time = process.env.TRANSPOZ_SELFTEST_TIME ?? "auto";
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const file = new File([new Uint8Array(${JSON.stringify([...data])})], ${JSON.stringify(path.basename(file))},
        { type: ${JSON.stringify(file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "")} });
      document.getElementById("omr-time").value = ${JSON.stringify(time)};
      const dt = new DataTransfer(); dt.items.add(file);
      document.getElementById("dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      const t0 = Date.now();
      while (!document.querySelector(".tz-note") && Date.now() - t0 < 300000) {
        if (document.querySelector("#status.error")) break;
        await wait(250);
      }
      await wait(500);
      return { status: document.getElementById("status").textContent, notes: document.querySelectorAll(".tz-note").length };
    })()`);
    log("chiffrage demandé :", time);
    log("statut :", result.status);
    log("notes affichées :", result.notes);
    code = result.notes > 0 ? 0 : 1;

    if (code === 0 && process.env.TRANSPOZ_SELFTEST_PRINT) {
      const pdf = await win.webContents.printToPDF({ pageSize: "A4", printBackground: true });
      await writeFile(process.env.TRANSPOZ_SELFTEST_PRINT, pdf);
      log("impression PDF :", pdf.length, "octets");
      if (pdf.length < 2000) code = 1;
    }
    if (code === 0 && process.env.TRANSPOZ_SELFTEST_SHOT) {
      // Original affiché à côté de la partition (visionneuse PDF de l'application).
      win.setSize(1440, 920);
      await win.webContents.executeJavaScript(`document.getElementById("original-btn").click(); true`);
      await wait(3000);
      const image = await win.webContents.capturePage();
      await writeFile(process.env.TRANSPOZ_SELFTEST_SHOT, image.toPNG());
      log("capture :", image.getSize().width, "x", image.getSize().height);
    }
  } catch (err) {
    log("erreur :", err.message);
    code = 1;
  }
  app.exit(code);
}

// Télécharge Audiveris (avec son Java) et l'extrait dans vendor/ pour qu'il soit
// livré dans l'application. Usage : node scripts/fetch-audiveris.mjs linux|win
//
// Linux   : paquet .deb (application autonome jpackage, déplaçable) → vendor/audiveris-linux
// Windows : paquet .msi « Console » (ligne de commande), extrait sans installation
//           (msiexec /a) → vendor/audiveris-win. À lancer sous Windows.

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const AUDIVERIS_VERSION = "5.11.0";
const BASE = `https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}`;
const ASSETS = {
  linux: `Audiveris-${AUDIVERIS_VERSION}-ubuntu22.04-x86_64.deb`,
  win: `Audiveris-${AUDIVERIS_VERSION}-windowsConsole-x86_64.msi`,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2] ?? (process.platform === "win32" ? "win" : "linux");
if (!ASSETS[platform]) {
  console.error("Usage : node scripts/fetch-audiveris.mjs linux|win");
  process.exit(2);
}
const target = path.join(here, "..", "vendor", `audiveris-${platform}`);
const marker = path.join(target, ".version");

if (existsSync(marker)) {
  console.log(`Audiveris ${AUDIVERIS_VERSION} déjà présent dans ${target}`);
  process.exit(0);
}

const work = await mkdtemp(path.join(tmpdir(), "audiveris-"));
const asset = path.join(work, ASSETS[platform]);
console.log(`Téléchargement de ${ASSETS[platform]}…`);
const res = await fetch(`${BASE}/${ASSETS[platform]}`);
if (!res.ok) throw new Error(`Téléchargement impossible (${res.status})`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(asset));

// Dossier contenant l'exécutable (bin/Audiveris ou Audiveris.exe).
function findAppRoot(dir, exe) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(path.join(full, exe))) return full;
    const deeper = findAppRoot(full, exe);
    if (deeper) return deeper;
  }
  return null;
}

let appRoot;
if (platform === "linux") {
  execFileSync("ar", ["x", asset], { cwd: work });
  const data = readdirSync(work).find((f) => f.startsWith("data.tar"));
  execFileSync("tar", ["-xf", data], { cwd: work });
  appRoot = path.join(work, "opt", "audiveris");
} else {
  const extracted = path.join(work, "msi");
  execFileSync("msiexec", ["/a", asset, "/qn", `TARGETDIR=${extracted}`], { stdio: "inherit" });
  appRoot = existsSync(path.join(extracted, "Audiveris.exe")) ? extracted : findAppRoot(extracted, "Audiveris.exe");
}
const exe = platform === "linux" ? path.join(appRoot ?? "", "bin", "Audiveris") : path.join(appRoot ?? "", "Audiveris.exe");
if (!appRoot || !existsSync(exe)) throw new Error("Exécutable Audiveris introuvable dans le paquet.");

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(appRoot, target, { recursive: true, verbatimSymlinks: true });
await writeFile(marker, `${AUDIVERIS_VERSION}\n`);
await rm(work, { recursive: true, force: true });
console.log(`Audiveris ${AUDIVERIS_VERSION} prêt dans ${target}`);

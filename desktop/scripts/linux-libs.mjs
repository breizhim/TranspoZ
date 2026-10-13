// Bibliothèques système dont l'application Linux a besoin : celles que demandent
// ses exécutables (Electron, Java d'Audiveris) sans être livrées dans le paquet,
// hors socle glibc. Sert à tenir à jour les dépendances du paquet .rpm.
//
//   node scripts/linux-libs.mjs          liste (format des dépendances rpm)
//   node scripts/linux-libs.mjs --check  échoue si package.json en oublie une
//
// À lancer après une construction Linux (dist/linux-unpacked) ; utilise readelf.

import { execFileSync } from "node:child_process";
import { lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "dist", "linux-unpacked");
const GLIBC = /^(libc|libm|libdl|libpthread|librt|libgcc_s|ld-linux-x86-64|libresolv|libutil)\.so/;

function isElf(file) {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(4);
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  return head.toString("latin1") === "\x7fELF";
}

const elfs = [];
const bundled = new Set();
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(file);
    else if (stat.isFile() && isElf(file)) {
      elfs.push(file);
      bundled.add(entry);
    }
  }
})(appDir);

const needed = new Set();
for (const file of elfs) {
  const out = execFileSync("readelf", ["-d", file], { encoding: "utf8" });
  for (const [, so] of out.matchAll(/\(NEEDED\).*\[(.*)\]/g)) {
    if (!bundled.has(so) && !GLIBC.test(so)) needed.add(`${so}()(64bit)`);
  }
}
const libs = [...needed].sort();

if (process.argv.includes("--check")) {
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
  const declared = new Set(pkg.build.rpm?.depends ?? []);
  const missing = libs.filter((l) => !declared.has(l));
  if (missing.length) {
    console.error(`Dépendances rpm manquantes dans package.json (build.rpm.depends) :\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Dépendances rpm à jour (${libs.length} bibliothèques).`);
} else {
  console.log(JSON.stringify(libs, null, 2));
}

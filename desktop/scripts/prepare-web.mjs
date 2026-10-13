// Copie l'interface (../web) et OpenSheetMusicDisplay dans staging/web, livré
// tel quel dans l'application. Les fichiers de web/ ne sont pas modifiés.
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const out = path.join(here, "..", "staging", "web");

await rm(out, { recursive: true, force: true });
await cp(path.join(root, "web"), out, {
  recursive: true,
  filter: (src) => !path.basename(src).startsWith("_"), // fichiers de test temporaires
});
await mkdir(path.join(out, "vendor", "osmd"), { recursive: true });
await cp(
  path.join(root, "node_modules", "opensheetmusicdisplay", "build", "opensheetmusicdisplay.min.js"),
  path.join(out, "vendor", "osmd", "opensheetmusicdisplay.min.js"),
);
console.log(`Interface prête dans ${out}`);

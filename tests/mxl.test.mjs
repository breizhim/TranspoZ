import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMusicXML } from "../web/mxl.js";

const SAMPLE = readFileSync(new URL("../web/samples/au-clair-de-la-lune.musicxml", import.meta.url), "utf8");

function makeMxl({ stored = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mxl-"));
  mkdirSync(join(dir, "META-INF"));
  writeFileSync(join(dir, "META-INF", "container.xml"),
    '<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>');
  writeFileSync(join(dir, "score.musicxml"), SAMPLE);
  // Archive générée par Python (zipfile), comme le ferait un logiciel de notation.
  execFileSync("python3", ["-c", `
import zipfile, sys
mode = zipfile.ZIP_STORED if sys.argv[2] == "1" else zipfile.ZIP_DEFLATED
with zipfile.ZipFile(sys.argv[1] + "/score.mxl", "w", mode) as z:
    z.write(sys.argv[1] + "/META-INF/container.xml", "META-INF/container.xml")
    z.write(sys.argv[1] + "/score.musicxml", "score.musicxml")
`, dir, stored ? "1" : "0"]);
  return new Uint8Array(readFileSync(join(dir, "score.mxl")));
}

test("lit un MusicXML brut", async () => {
  assert.equal(await readMusicXML(new TextEncoder().encode(SAMPLE)), SAMPLE);
});

test("lit une archive .mxl compressée", async () => {
  assert.equal(await readMusicXML(makeMxl()), SAMPLE);
});

test("lit une archive .mxl non compressée", async () => {
  assert.equal(await readMusicXML(makeMxl({ stored: true })), SAMPLE);
});

test("refuse un fichier qui n'est pas une partition", async () => {
  await assert.rejects(readMusicXML(new TextEncoder().encode("<html/>")), /pas une partition/);
});

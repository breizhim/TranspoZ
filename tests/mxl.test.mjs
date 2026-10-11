import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMusicXML, readScoreFile, writeScoreFile } from "../web/mxl.js";

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

test("fichier de relecture : partition + original + réglages, aller-retour", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xe9, 0x00, 0xff]);
  const session = { version: 1, title: "Au clair de la lune", semitones: 2, region: "all" };
  const bytes = writeScoreFile(SAMPLE, { originals: [{ name: "partition été.pdf", bytes: pdf }], session });
  const back = await readScoreFile(bytes);
  assert.equal(back.xml, SAMPLE);
  assert.deepEqual(back.session, session);
  assert.equal(back.originals.length, 1);
  assert.equal(back.originals[0].name, "partition été.pdf");
  assert.deepEqual([...back.originals[0].bytes], [...pdf]);
  assert.equal(await readMusicXML(bytes), SAMPLE, "lisible comme un .mxl ordinaire");
  const plain = await readScoreFile(new TextEncoder().encode(SAMPLE));
  assert.deepEqual([plain.originals.length, plain.session], [0, null]);
});

test("fichier de relecture : archive zip valide pour d'autres logiciels", () => {
  const dir = mkdtempSync(join(tmpdir(), "relecture-"));
  const path = join(dir, "relecture.mxl");
  writeFileSync(path, writeScoreFile(SAMPLE, { originals: [{ name: "p.pdf", bytes: new Uint8Array([1, 2, 3]) }], session: { a: 1 } }));
  const out = execFileSync("python3", ["-c", `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(" ".join(z.namelist()))
print(z.read("META-INF/container.xml").decode().count("score.musicxml"))
`, path]).toString().trim().split("\n");
  assert.equal(out[0], "mimetype META-INF/container.xml score.musicxml transpoz/original/p.pdf transpoz/session.json");
  assert.equal(out[1], "1");
});

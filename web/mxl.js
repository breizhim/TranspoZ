// Lecture des fichiers MusicXML dans le navigateur, y compris les archives
// compressées .mxl (zip), sans bibliothèque externe (DecompressionStream).
//
// Fichier de relecture TranspoZ : une archive .mxl standard (lisible par
// MuseScore) qui contient en plus, dans le dossier « transpoz/ », les fichiers
// d'origine (PDF, images) et les réglages de la session.

const textDecoder = new TextDecoder("utf-8");

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Fin du répertoire central (signature 0x06054b50), cherchée depuis la fin.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Archive .mxl invalide.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Archive .mxl invalide.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extract(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error("Compression .mxl non prise en charge.");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Contenu d'une archive zip : Map nom → octets (décompressés). */
export async function readZip(bytes) {
  const entries = readZipEntries(bytes);
  const files = new Map();
  for (const [name, entry] of entries) if (!name.endsWith("/")) files.set(name, await extract(bytes, entry));
  return files;
}

/** Archive zip (sans compression) : [{ name, data }] → octets. */
export function writeZip(files) {
  return zip(files);
}

const ORIGINALS_DIR = "transpoz/original/";
const SESSION_PATH = "transpoz/session.json";

export async function unzipMxl(bytes) {
  return (await readArchive(bytes)).xml;
}

async function readArchive(bytes) {
  const entries = readZipEntries(bytes);
  let rootPath = null;
  const container = entries.get("META-INF/container.xml");
  if (container) {
    const xml = textDecoder.decode(await extract(bytes, container));
    rootPath = /full-path="([^"]+)"/.exec(xml)?.[1] ?? null;
  }
  if (!rootPath || !entries.has(rootPath)) {
    rootPath = [...entries.keys()].find((n) => /\.(xml|musicxml)$/i.test(n) && !n.startsWith("META-INF/"));
  }
  if (!rootPath) throw new Error("Archive .mxl sans partition.");
  const xml = textDecoder.decode(await extract(bytes, entries.get(rootPath)));
  const originals = [];
  for (const [name, entry] of entries) {
    if (!name.startsWith(ORIGINALS_DIR) || name.endsWith("/")) continue;
    originals.push({ name: name.slice(ORIGINALS_DIR.length), bytes: await extract(bytes, entry) });
  }
  let session = null;
  if (entries.has(SESSION_PATH)) {
    try {
      session = JSON.parse(textDecoder.decode(await extract(bytes, entries.get(SESSION_PATH))));
    } catch {
      session = null; // réglages illisibles : on garde la partition
    }
  }
  return { xml, originals, session };
}

/**
 * Lit un fichier de partition : MusicXML brut ou .mxl, éventuellement fichier de
 * relecture TranspoZ (avec les originaux et les réglages).
 * @returns {Promise<{xml:string, originals:Array<{name:string, bytes:Uint8Array}>, session:object|null}>}
 */
export async function readScoreFile(bytes) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const result = isZip ? await readArchive(bytes) : { xml: textDecoder.decode(bytes), originals: [], session: null };
  result.xml = checkScore(result.xml);
  return result;
}

// Retourne le texte MusicXML d'un fichier brut (.musicxml/.xml) ou compressé (.mxl).
export async function readMusicXML(bytes) {
  return (await readScoreFile(bytes)).xml;
}

function checkScore(text) {
  if (!text.includes("<score-partwise")) {
    throw new Error(text.includes("<score-timewise")
      ? "Le format MusicXML « timewise » n'est pas pris en charge."
      : "Ce fichier n'est pas une partition MusicXML.");
  }
  return text.replace(/^﻿/, "");
}

// ---------------------------------------------------------------------------
// Écriture d'une archive .mxl (zip sans compression : les PDF le sont déjà)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // noms en UTF-8
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/**
 * Fichier de relecture : partition (MusicXML) + originaux + réglages, en .mxl.
 * @param {string} xml
 * @param {{originals?: Array<{name:string, bytes:Uint8Array}>, session?: object}} [extra]
 */
export function writeScoreFile(xml, { originals = [], session = null } = {}) {
  const encoder = new TextEncoder();
  // Le type MIME doit être le premier fichier, non compressé (convention .mxl).
  const files = [
    { name: "mimetype", data: encoder.encode("application/vnd.recordare.musicxml") },
    {
      name: "META-INF/container.xml",
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles>' +
        '<rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>' +
        "</rootfiles></container>\n"),
    },
    { name: "score.musicxml", data: encoder.encode(xml) },
  ];
  const used = new Set();
  for (const o of originals) {
    let name = o.name.replace(/[\\/]+/g, "_") || "original";
    while (used.has(name)) name = `_${name}`;
    used.add(name);
    files.push({ name: ORIGINALS_DIR + name, data: o.bytes });
  }
  if (session) files.push({ name: SESSION_PATH, data: encoder.encode(JSON.stringify(session, null, 2)) });
  return zip(files);
}

export const isMusicXMLName = (name) => /\.(musicxml|xml|mxl)$/i.test(name);

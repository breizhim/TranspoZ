// Lecture des fichiers MusicXML dans le navigateur, y compris les archives
// compressées .mxl (zip), sans bibliothèque externe (DecompressionStream).

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

export async function unzipMxl(bytes) {
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
  return textDecoder.decode(await extract(bytes, entries.get(rootPath)));
}

// Retourne le texte MusicXML d'un fichier brut (.musicxml/.xml) ou compressé (.mxl).
export async function readMusicXML(bytes) {
  const text = bytes[0] === 0x50 && bytes[1] === 0x4b ? await unzipMxl(bytes) : textDecoder.decode(bytes);
  if (!text.includes("<score-partwise")) {
    throw new Error(text.includes("<score-timewise")
      ? "Le format MusicXML « timewise » n'est pas pris en charge."
      : "Ce fichier n'est pas une partition MusicXML.");
  }
  return text.replace(/^﻿/, "");
}

export const isMusicXMLName = (name) => /\.(musicxml|xml|mxl)$/i.test(name);

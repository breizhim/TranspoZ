import {
  addIntervals,
  intervalFromSemitones,
  transposePitch,
  transposeScore,
  keyName,
  keySignatureLabel,
  scoreTitle,
} from "./transpose.js";
import {
  PITCHES,
  INSTRUMENTS,
  findInstrument,
  instrumentInterval,
  soundingOffset,
  semitoneLabel,
} from "./instruments.js";
import { readMusicXML, isMusicXMLName } from "./mxl.js";

// Adresse du serveur de reconnaissance (config.js). Vide = même origine que la page.
const API_BASE = (window.TRANSPOZ_CONFIG?.apiUrl ?? "").trim().replace(/\/+$/, "");
const apiUrl = (path) => (API_BASE ? `${API_BASE}/${path}` : path);

const $ = (id) => document.getElementById(id);

const ui = {
  fileInput: $("file-input"),
  dropzone: $("dropzone"),
  sampleBtn: $("sample-btn"),
  status: $("status"),
  title: $("title"),
  src: { instrument: $("src-instrument"), pitch: $("src-pitch"), octave: $("src-octave"), hint: $("src-hint") },
  tgt: { instrument: $("tgt-instrument"), pitch: $("tgt-pitch"), octave: $("tgt-octave"), hint: $("tgt-hint") },
  semitones: $("semitones"),
  semiDown: $("semi-down"),
  semiUp: $("semi-up"),
  semiLabel: $("semi-label"),
  keyPref: $("key-pref"),
  clef: $("clef"),
  summary: $("summary"),
  printBtn: $("print-btn"),
  downloadBtn: $("download-btn"),
  originalBtn: $("original-btn"),
  zoom: $("zoom"),
  original: $("original"),
  empty: $("empty"),
  score: $("score"),
};

const state = {
  sourceXml: null,
  transposedXml: null,
  originals: [], // { url, type }
  osmd: null,
  rendering: false,
  dirty: false,
  pageFormat: "Endless",
};

// ---------------------------------------------------------------------------
// Formulaires
// ---------------------------------------------------------------------------

const NOTE_FR = { C: "Do", D: "Ré", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };
const ALTER_FR = { "-2": "𝄫", "-1": "♭", "0": "", "1": "♯", "2": "𝄪" };
const OCTAVES = [
  [2, "+2 octaves"], [1, "+1 octave"], [0, "normale"], [-1, "−1 octave"], [-2, "−2 octaves"],
];

function fillSelect(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
}

function setupInstrumentFields(group, defaultId) {
  fillSelect(group.instrument, INSTRUMENTS.map((i) => [i.id, i.name]));
  fillSelect(group.pitch, Object.entries(PITCHES).map(([k, p]) => [k, p.label]));
  fillSelect(group.octave, OCTAVES);
  group.instrument.value = defaultId;
  applyInstrument(group);

  group.instrument.addEventListener("change", () => {
    applyInstrument(group);
    update();
  });
  const manual = () => {
    const inst = findInstrument(group.instrument.value);
    if (inst.pitch !== group.pitch.value || inst.octave !== Number(group.octave.value)) {
      group.instrument.value = "custom";
    }
    updateHint(group);
    update();
  };
  group.pitch.addEventListener("change", manual);
  group.octave.addEventListener("change", manual);
}

function applyInstrument(group) {
  const inst = findInstrument(group.instrument.value);
  if (inst.id !== "custom") {
    group.pitch.value = inst.pitch;
    group.octave.value = String(inst.octave);
  }
  updateHint(group);
}

function updateHint(group) {
  const offset = soundingOffset(group.pitch.value, Number(group.octave.value));
  const real = transposePitch({ step: "C", alter: 0, octave: 4 }, offset);
  const name = `${NOTE_FR[real.step]}${ALTER_FR[real.alter]}${real.octave}`;
  group.hint.textContent = offset.chromatic === 0
    ? "Instrument non transpositeur : les notes écrites sont les notes réelles."
    : `Un Do4 écrit sonne ${name} (${semitoneLabel(offset.chromatic).replace(/ \(.*/, "")}).`;
}

function readInstrument(group) {
  const inst = findInstrument(group.instrument.value);
  return { ...inst, pitch: group.pitch.value, octave: Number(group.octave.value) };
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

async function waitForOSMD() {
  for (let i = 0; i < 100 && !window.opensheetmusicdisplay; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!window.opensheetmusicdisplay) throw new Error("Impossible de charger le moteur d'affichage des partitions.");
  return window.opensheetmusicdisplay;
}

async function getOSMD() {
  if (state.osmd) return state.osmd;
  const lib = await waitForOSMD();
  state.osmd = new lib.OpenSheetMusicDisplay(ui.score, {
    backend: "svg",
    autoResize: true,
    drawTitle: true,
    drawComposer: true,
    drawPartNames: true,
    drawingParameters: "default",
    pageFormat: state.pageFormat,
    pageBackgroundColor: "#FFFFFF",
  });
  return state.osmd;
}

function buildTransposition() {
  const source = readInstrument(ui.src);
  const target = readInstrument(ui.tgt);
  const semitones = Number(ui.semitones.value);
  const interval = addIntervals(instrumentInterval(source, target), intervalFromSemitones(semitones));
  let clef = ui.clef.value;
  if (clef === "keep") clef = null;
  else if (clef === "auto") clef = target.clef;
  const instrumentChanged = source.id !== target.id || source.pitch !== target.pitch || source.octave !== target.octave;
  return {
    source,
    target,
    semitones,
    options: {
      interval,
      keyPreference: ui.keyPref.value,
      clef,
      instrumentTransposition: soundingOffset(target.pitch, target.octave),
      partName: instrumentChanged && target.id !== "custom" ? target.name : null,
      title: ui.title.value.trim() || null,
    },
  };
}

function describeKey(key) {
  return key.mode ? keyName(key.fifths, key.mode) : `${keyName(key.fifths)} (${keySignatureLabel(key.fifths)})`;
}

function showSummary(report, { options }) {
  const part = report.parts[0];
  if (!part) {
    ui.summary.hidden = true;
    return;
  }
  const writtenShift = options.interval.chromatic;
  const lines = [
    `<p><strong>Tonalité :</strong> ${describeKey(part.from)} → <strong>${describeKey(part.to)}</strong></p>`,
    `<p><strong>Notes écrites :</strong> ${semitoneLabel(writtenShift)}</p>`,
  ];
  ui.summary.innerHTML = lines.join("");
  ui.summary.hidden = false;
}

function transpose() {
  const doc = new DOMParser().parseFromString(state.sourceXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Partition MusicXML illisible.");
  const settings = buildTransposition();
  const report = transposeScore(doc, settings.options);
  showSummary(report, settings);
  return new XMLSerializer().serializeToString(doc);
}

// Un seul rendu à la fois : les changements rapides sont regroupés.
async function update() {
  ui.semiLabel.textContent = semitoneLabel(Number(ui.semitones.value));
  if (!state.sourceXml) return;
  if (state.rendering) {
    state.dirty = true;
    return;
  }
  state.rendering = true;
  try {
    do {
      state.dirty = false;
      state.transposedXml = transpose();
      ui.empty.hidden = true;
      ui.score.hidden = false;
      const osmd = await getOSMD();
      await osmd.load(state.transposedXml);
      osmd.zoom = Number(ui.zoom.value);
      osmd.render();
    } while (state.dirty);
    for (const b of [ui.printBtn, ui.downloadBtn]) b.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`Affichage impossible : ${err.message}`, "error");
  } finally {
    state.rendering = false;
  }
}

// ---------------------------------------------------------------------------
// Chargement des fichiers
// ---------------------------------------------------------------------------

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

function showOriginals(files) {
  for (const o of state.originals) URL.revokeObjectURL(o.url);
  state.originals = files
    .filter((f) => f.type === "application/pdf" || f.type.startsWith("image/") || /\.(pdf|jpe?g|png)$/i.test(f.name))
    .map((f) => ({ url: URL.createObjectURL(f), pdf: f.type === "application/pdf" || /\.pdf$/i.test(f.name) }));
  ui.original.replaceChildren(
    ...state.originals.map((o) => {
      if (o.pdf) {
        const frame = document.createElement("iframe");
        frame.src = o.url;
        frame.title = "Partition d'origine";
        return frame;
      }
      const img = new Image();
      img.src = o.url;
      img.alt = "Partition d'origine";
      return img;
    }),
  );
  ui.originalBtn.disabled = state.originals.length === 0;
  if (!state.originals.length) ui.original.hidden = true;
}

function loadSource(xml, title, fallbackTitle = null) {
  state.sourceXml = xml;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  ui.title.value = title || scoreTitle(doc) || fallbackTitle || ui.title.value;
  return update();
}

// null = pas encore vérifié ; sinon { reachable, engine }.
let server = null;

async function checkServer() {
  try {
    const res = await fetch(apiUrl("api/status"));
    const body = res.ok ? await res.json() : null;
    server = { reachable: Boolean(body), engine: body?.engine ?? null };
  } catch {
    server = { reachable: false, engine: null };
  }
  return server;
}

const NO_OMR_MESSAGE =
  "La reconnaissance des PDF et images nécessite un serveur TranspoZ, non disponible ici. " +
  "Importez un fichier MusicXML (exportable depuis MuseScore, Finale, Sibelius…) ou utilisez une instance avec serveur.";

async function recognizeOnServer(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(apiUrl("api/recognize"), { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Erreur serveur (${res.status})`);
  return body;
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  showOriginals(files);
  const needsOMR = files.some((f) => !isMusicXMLName(f.name));
  setStatus(
    needsOMR
      ? `Reconnaissance des notes en cours (${files.length} fichier${files.length > 1 ? "s" : ""})… cela peut prendre une minute par page.`
      : "Lecture de la partition…",
    "busy",
  );
  ui.dropzone.classList.add("busy");
  try {
    const fallbackTitle = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    if (!needsOMR && files.length === 1) {
      // MusicXML : lu directement dans le navigateur, sans serveur.
      const xml = await readMusicXML(new Uint8Array(await files[0].arrayBuffer()));
      await loadSource(xml, null, fallbackTitle);
      setStatus("Partition chargée.");
      return;
    }
    if (!(server ?? (await checkServer())).reachable) throw new Error(NO_OMR_MESSAGE);
    const body = await recognizeOnServer(files);
    await loadSource(body.musicxml, body.title, fallbackTitle);
    const engine = body.engine ? ` avec ${body.engine}` : "";
    setStatus(`Partition chargée${engine}. Comparez-la à l'original pour vérifier la reconnaissance.`);
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    ui.dropzone.classList.remove("busy");
  }
}

async function loadSample() {
  setStatus("Chargement de l'exemple…", "busy");
  try {
    const res = await fetch("samples/au-clair-de-la-lune.musicxml");
    showOriginals([]);
    ui.src.instrument.value = "flute";
    applyInstrument(ui.src);
    await loadSource(await res.text());
    setStatus("Exemple chargé : choisissez un instrument ou une tonalité.");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Impression et export
// ---------------------------------------------------------------------------

async function renderWithFormat(format) {
  state.pageFormat = format;
  const osmd = await getOSMD();
  osmd.setOptions({ pageFormat: format });
  osmd.render();
}

async function print() {
  await renderWithFormat("A4_P");
  const restore = () => {
    window.removeEventListener("afterprint", restore);
    renderWithFormat("Endless");
  };
  window.addEventListener("afterprint", restore);
  window.print();
}

function download() {
  if (!state.transposedXml) return;
  const target = readInstrument(ui.tgt);
  const base = `${ui.title.value.trim() || "partition"} - ${target.id === "custom" ? "transposé" : target.name}`;
  const name = base.replace(/[\\/:*?"<>|]+/g, "").slice(0, 120) + ".musicxml";
  const blob = new Blob([state.transposedXml], { type: "application/vnd.recordare.musicxml+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

setupInstrumentFields(ui.src, "ut");
setupInstrumentFields(ui.tgt, "ut");

ui.fileInput.addEventListener("change", () => handleFiles(ui.fileInput.files));
ui.sampleBtn.addEventListener("click", loadSample);
for (const ev of ["dragenter", "dragover"]) {
  ui.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    ui.dropzone.classList.add("over");
  });
}
for (const ev of ["dragleave", "drop"]) {
  ui.dropzone.addEventListener(ev, () => ui.dropzone.classList.remove("over"));
}
ui.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});

let titleTimer;
ui.title.addEventListener("input", () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(update, 300);
});
ui.semitones.addEventListener("input", update);
ui.semiDown.addEventListener("click", () => {
  ui.semitones.stepDown();
  update();
});
ui.semiUp.addEventListener("click", () => {
  ui.semitones.stepUp();
  update();
});
ui.keyPref.addEventListener("change", update);
ui.clef.addEventListener("change", update);
ui.zoom.addEventListener("input", () => {
  if (!state.osmd || !state.sourceXml) return;
  state.osmd.zoom = Number(ui.zoom.value);
  state.osmd.render();
});
ui.printBtn.addEventListener("click", print);
ui.downloadBtn.addEventListener("click", download);
ui.originalBtn.addEventListener("click", () => {
  ui.original.hidden = !ui.original.hidden;
});

update();
checkServer().then((s) => {
  if (ui.status.textContent) return;
  if (!s.reachable) {
    setStatus("ℹ️ Version en ligne sans serveur : importez un fichier MusicXML ou essayez l'exemple. " +
      "La reconnaissance des PDF/JPG nécessite le serveur TranspoZ.");
  } else if (!s.engine) {
    setStatus("⚠️ Aucun moteur de reconnaissance installé sur ce serveur : seuls les fichiers MusicXML sont acceptés.");
  }
});

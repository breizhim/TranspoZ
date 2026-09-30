import {
  addIntervals,
  intervalFromSemitones,
  negateInterval,
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
import { TrumpetPlayer } from "./player.js";
import * as editor from "./editor.js";

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
  playBtn: $("play-btn"),
  stopBtn: $("stop-btn"),
  tempo: $("tempo"),
  playPitch: $("play-pitch"),
  tempoLabel: $("tempo-label"),
  editor: $("editor"),
  editorTools: $("editor-tools"),
  selInfo: $("sel-info"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  timeSig: $("time-sig"),
  checks: $("checks"),
  popup: $("insert-popup"),
  ipKind: $("ip-kind"),
  ipDuration: $("ip-duration"),
  ipTitle: $("ip-title"),
  ipPitch: $("ip-pitch"),
  ipDot: $("ip-dot"),
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
  newSource: false, // prendre le tempo de la partition au prochain rendu
  cursorTimes: null, // position (en noires) de chaque pas du curseur
  cursorIndex: 0,
  cursorFrame: 0,
  // Édition
  transposedDoc: null,
  report: null,
  analysis: null, // analyse de la partition affichée (transposée)
  selected: null, // rang de la note sélectionnée
  noteEls: new Map(), // rang → éléments SVG
  history: [],
  future: [],
  slots: null, // emplacements d'insertion (calculés au premier survol)
  hoverSlot: null,
  pending: null, // insertion en cours de choix dans le menu
};

const player = new TrumpetPlayer();

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
    autoResize: false, // redimensionnement géré ici pour redécorer la partition
    drawTitle: true,
    drawComposer: true,
    drawPartNames: true,
    drawingParameters: "default",
    pageFormat: state.pageFormat,
    pageBackgroundColor: "#FFFFFF",
    followCursor: true,
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
  loadPlayer(doc);
  state.transposedDoc = doc;
  state.report = report;
  state.analysis = editor.analyzeScore(doc);
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
      decorate();
    } while (state.dirty);
    for (const b of [ui.printBtn, ui.downloadBtn, ui.playBtn, ui.stopBtn]) b.disabled = false;
    ui.editor.hidden = false;
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
  state.newSource = true;
  state.history = [];
  state.future = [];
  state.selected = null;
  updateHistoryButtons();
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
// Lecture audio et curseur
// ---------------------------------------------------------------------------

// Nouvelle partition transposée : la lecture repart du début.
function loadPlayer(doc) {
  player.load(doc, { concertPitch: ui.playPitch.value === "concert" });
  if (state.newSource) {
    state.newSource = false;
    ui.tempo.value = String(Math.round(player.scoreBpm));
  }
  player.bpm = Number(ui.tempo.value);
  ui.tempoLabel.textContent = ui.tempo.value;
  hideCursor();
  state.cursorTimes = null;
  updatePlayButton();
}

function updatePlayButton() {
  ui.playBtn.textContent = player.playing ? "⏸️ Pause" : "▶️ Jouer";
}

function hideCursor() {
  cancelAnimationFrame(state.cursorFrame);
  state.osmd?.cursor?.hide();
}

// Positions du curseur d'OSMD, pas à pas, en noires (reprises comprises).
function cursorTimes(cursor) {
  cursor.reset();
  const times = [];
  const it = cursor.Iterator.clone();
  while (!it.EndReached && times.length < 20000) {
    times.push(it.CurrentEnrolledTimestamp.RealValue * 4);
    it.moveToNextVisibleVoiceEntry(false);
  }
  return times;
}

// Amène le curseur sur la dernière position atteinte à `quarter`.
function moveCursor(quarter) {
  const cursor = state.osmd?.cursor;
  if (!cursor || !state.cursorTimes) return;
  let target = 0;
  while (target + 1 < state.cursorTimes.length && state.cursorTimes[target + 1] <= quarter + 1e-4) target++;
  if (target < state.cursorIndex) {
    cursor.reset();
    state.cursorIndex = 0;
  }
  while (state.cursorIndex < target) {
    cursor.next();
    state.cursorIndex++;
  }
}

function followPlayback() {
  moveCursor(player.currentQuarter());
  if (player.playing) state.cursorFrame = requestAnimationFrame(followPlayback);
}

async function togglePlayback() {
  if (player.playing) {
    pausePlayback();
    return;
  }
  const cursor = state.osmd?.cursor;
  if (cursor) {
    cursor.show();
    if (!state.cursorTimes) {
      state.cursorTimes = cursorTimes(cursor);
      state.cursorIndex = 0;
    }
  }
  try {
    await player.play();
  } catch (err) {
    setStatus(`Lecture impossible : ${err.message}`, "error");
  }
  updatePlayButton();
  followPlayback();
}

function pausePlayback() {
  player.pause();
  cancelAnimationFrame(state.cursorFrame);
  updatePlayButton();
}

function stopPlayback() {
  player.stop();
  hideCursor();
  state.cursorIndex = 0;
  state.osmd?.cursor?.reset();
  updatePlayButton();
}

player.onEnd = stopPlayback;

// ---------------------------------------------------------------------------
// Correction de la partition
// ---------------------------------------------------------------------------

const TYPE_FR = {
  breve: "carrée", whole: "ronde", half: "blanche", quarter: "noire", eighth: "croche",
  "16th": "double croche", "32nd": "triple croche", "64th": "quadruple croche",
};
const DURATION_KEYS = { 1: "whole", 2: "half", 3: "quarter", 4: "eighth", 5: "16th", 6: "32nd" };

const pitchLabel = (p) => `${NOTE_FR[p.step]}${ALTER_FR[p.alter] ?? ""}${p.octave}`;
const beatsLabel = (quarters, time) => {
  const beats = (quarters * time.beatType) / 4;
  return Number.isInteger(beats) ? String(beats) : beats.toFixed(2).replace(/0+$/, "").replace(".", ",");
};

// Associe les notes dessinées par OSMD aux notes du MusicXML : même portée,
// même mesure, même instant ; à l'intérieur d'un accord, dans l'ordre des hauteurs.
function mapGraphicalNotes(osmd, analysis) {
  const key = (staff, measure, start, grace) => `${staff}|${measure}|${start.toFixed(4)}|${grace ? 1 : 0}`;
  const REST = -1e9;
  const fromXml = new Map();
  for (const n of analysis.notes) {
    const k = key(n.staff, n.measure, n.start, n.grace);
    if (!fromXml.has(k)) fromXml.set(k, []);
    fromXml.get(k).push({ index: n.index, v: n.pitch ? editor.pitchMidi(n.pitch) : REST });
  }
  const fromOsmd = new Map();
  for (const row of osmd.GraphicSheet.MeasureList) {
    for (const gm of row ?? []) {
      for (const se of gm?.staffEntries ?? []) {
        for (const gve of se.graphicalVoiceEntries ?? []) {
          for (const gn of gve.notes ?? []) {
            const sn = gn.sourceNote;
            const ve = sn?.ParentVoiceEntry;
            if (!ve) continue;
            const k = key(sn.ParentStaffEntry.ParentStaff.idInMusicSheet, sn.SourceMeasure.measureListIndex,
              ve.Timestamp.RealValue * 4, ve.IsGrace);
            const p = sn.Pitch;
            const v = sn.isRest() || !p ? REST : p.Octave * 12 + p.FundamentalNote + p.AccidentalHalfTones;
            if (!fromOsmd.has(k)) fromOsmd.set(k, []);
            fromOsmd.get(k).push({ gn, v });
          }
        }
      }
    }
  }
  const byPitch = (a, b) => a.v - b.v;
  const map = new Map();
  for (const [k, graphical] of fromOsmd) {
    const xml = fromXml.get(k);
    if (!xml) continue;
    xml.sort(byPitch);
    graphical.sort(byPitch);
    graphical.forEach(({ gn }, j) => {
      const target = xml[Math.min(j, xml.length - 1)];
      let el = gn.getSVGGElement?.();
      if (!target || !el) return;
      // Accord : VexFlow dessine toutes les têtes dans le même groupe ; on vise la bonne.
      const heads = el.querySelectorAll(".vf-notehead");
      if (heads.length > 1) el = heads[gn.vfnoteIndex ?? gn.vfnote?.[1] ?? 0] ?? el;
      if (!map.has(target.index)) map.set(target.index, []);
      map.get(target.index).push(el);
    });
  }
  return map;
}

// Cadres rouges sur les mesures dont la durée ne correspond pas au chiffrage.
function drawMeasureChecks(osmd, analysis) {
  for (const old of ui.score.querySelectorAll(".tz-flag")) old.remove();
  const svgs = ui.score.querySelectorAll("svg");
  const unit = 10 * osmd.zoom;
  const flagged = analysis.measures.filter((m) => m.status !== "ok");
  for (const m of flagged) {
    const row = osmd.GraphicSheet.MeasureList[m.index];
    if (!row) continue;
    const first = analysis.staffOffsets[m.part];
    const last = analysis.staffOffsets[m.part + 1] ?? row.length;
    // Un seul cadre pour toutes les portées de la partie (piano : deux portées).
    const boxes = row.slice(first, last).filter((gm) => gm?.PositionAndShape);
    if (!boxes.length) continue;
    const top = boxes[0].PositionAndShape;
    const bottom = boxes[boxes.length - 1].PositionAndShape;
    const page = boxes[0].ParentStaffLine?.ParentMusicSystem?.Parent;
    const svg = svgs[Math.max(0, osmd.GraphicSheet.MusicPages.indexOf(page))] ?? svgs[0];
    if (!svg) continue;
    const y1 = top.AbsolutePosition.y + top.BorderTop - 1.5;
    const y2 = bottom.AbsolutePosition.y + bottom.BorderBottom + 1.5;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "tz-flag");
    rect.setAttribute("x", (top.AbsolutePosition.x + top.BorderLeft) * unit);
    rect.setAttribute("y", y1 * unit);
    rect.setAttribute("width", (top.BorderRight - top.BorderLeft) * unit);
    rect.setAttribute("height", (y2 - y1) * unit);
    rect.setAttribute("rx", 4);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `Mesure ${m.number} : ${beatsLabel(m.actual, m.time)} temps au lieu de ${m.time.beats}`;
    rect.appendChild(title);
    svg.insertBefore(rect, svg.firstChild);
  }

  ui.checks.hidden = flagged.length === 0;
  if (!flagged.length) return;
  const label = flagged.length > 1 ? `${flagged.length} mesures à vérifier` : "1 mesure à vérifier";
  ui.checks.replaceChildren(
    document.createTextNode(`⚠️ ${label} (durée différente du chiffrage) : `),
    ...flagged.slice(0, 30).map((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = m.number;
      b.title = `${beatsLabel(m.actual, m.time)} temps au lieu de ${m.time.beats} (${m.status === "short" ? "incomplète" : "trop longue"})`;
      b.addEventListener("click", () => {
        const note = analysis.notes.find((n) => n.part === m.part && n.measure === m.index);
        if (note) select(note.index, { scroll: true });
      });
      return b;
    }),
    document.createTextNode(flagged.length > 30 ? " …" : ""),
  );
}

// Après chaque rendu : notes cliquables, mesures signalées, sélection.
function decorate() {
  state.slots = null;
  hideInsertLine();
  if (!state.osmd || !state.analysis) return;
  try {
    state.noteEls = mapGraphicalNotes(state.osmd, state.analysis);
    for (const [index, els] of state.noteEls) {
      for (const el of els) {
        el.classList.add("tz-note");
        el.setAttribute("data-note", index);
      }
    }
    drawMeasureChecks(state.osmd, state.analysis);
  } catch (err) {
    console.error("Correction indisponible :", err);
  }
  if (state.selected != null && state.selected >= state.analysis.notes.length) state.selected = null;
  showSelection();
}

function select(index, { scroll = false } = {}) {
  state.selected = index;
  showSelection();
  if (scroll) state.noteEls.get(index)?.[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function showSelection() {
  for (const el of ui.score.querySelectorAll(".tz-selected")) el.classList.remove("tz-selected");
  const n = state.selected != null ? state.analysis?.notes[state.selected] : null;
  for (const b of ui.editorTools.querySelectorAll("button, select")) b.disabled = !n;
  ui.editorTools.querySelectorAll("[data-type]").forEach((b) => b.classList.remove("active"));
  if (!n) {
    ui.selInfo.textContent = "Cliquez sur une note pour la corriger.";
    for (const b of ui.editorTools.querySelectorAll("[aria-pressed]")) b.setAttribute("aria-pressed", "false");
    return;
  }
  for (const el of state.noteEls.get(n.index) ?? []) el.classList.add("tz-selected");

  const measure = state.analysis.measures.find((m) => m.part === n.part && m.index === n.measure);
  const found = n.type ? { type: n.type, dots: n.dots } : editor.typeFromQuarters(n.duration);
  const value = found ? `${TYPE_FR[found.type] ?? found.type}${found.dots ? " pointée" : ""}` : "durée irrégulière";
  const what = n.rest ? `silence (${value})` : `${pitchLabel(n.pitch)} · ${value}`;
  ui.selInfo.textContent = `Mesure ${measure?.number ?? n.measure + 1} · ${what}${n.grace ? " · appoggiature" : ""}`;
  if (found) ui.editorTools.querySelector(`[data-type="${found.type}"]`)?.classList.add("active");
  ui.editorTools.querySelector('[data-action="dot"]').classList.toggle("active", Boolean(found?.dots));

  const links = editor.linkState(state.analysis, n.index);
  const linkLabel = { tie: "liaison de prolongation", slur: "liaison d'expression" };
  for (const side of ["left", "right"]) {
    const b = ui.editorTools.querySelector(`[data-action="link-${side}"]`);
    b.setAttribute("aria-pressed", String(Boolean(links[side])));
    b.title = links[side] ? `Délier (${linkLabel[links[side]]})` : `Lier à la note de ${side === "left" ? "gauche" : "droite"}`;
  }
  for (const name of ["up", "down", "octave-up", "octave-down", "sharp", "flat", "natural", "link-left", "link-right"]) {
    ui.editorTools.querySelector(`[data-action="${name}"]`).disabled = n.rest;
  }
  ui.editorTools.querySelector('[data-action="to-note"]').disabled = !n.rest;
  if (measure?.time) {
    const value = `${measure.time.beats}/${measure.time.beatType}`;
    if (![...ui.timeSig.options].some((o) => o.value === value)) ui.timeSig.add(new Option(value, value));
    ui.timeSig.value = value;
  }
}

function updateHistoryButtons() {
  ui.undoBtn.disabled = !state.history.length;
  ui.redoBtn.disabled = !state.future.length;
}

function commit(xml, selected) {
  state.history.push(state.sourceXml);
  if (state.history.length > 200) state.history.shift();
  state.future = [];
  state.sourceXml = xml;
  state.selected = selected;
  updateHistoryButtons();
  return update();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(state.sourceXml);
  state.sourceXml = state.history.pop();
  updateHistoryButtons();
  update();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(state.sourceXml);
  state.sourceXml = state.future.pop();
  updateHistoryButtons();
  update();
}

// Applique une opération d'editor.js à la partition d'origine.
function edit(operation) {
  if (state.selected == null || !state.sourceXml) return;
  apply((doc) => operation(doc, state.selected));
}

function apply(operation) {
  if (!state.sourceXml) return;
  const doc = new DOMParser().parseFromString(state.sourceXml, "application/xml");
  const result = operation(doc) ?? {};
  if (result.error) {
    setStatus(result.error, "error");
    return;
  }
  setStatus("");
  commit(new XMLSerializer().serializeToString(doc), result.select ?? state.selected);
}

// Les hauteurs se choisissent sur la partition affichée (transposée) puis sont
// ramenées dans la tonalité d'origine.
function editPitch(compute) {
  const i = state.selected;
  const shown = state.analysis?.notes[i];
  if (!shown) return;
  const wanted = compute(shown, i);
  if (!wanted) return;
  const iv = state.report.parts[shown.part]?.interval ?? { diatonic: 0, chromatic: 0 };
  const source = transposePitch(wanted, negateInterval(iv));
  edit((doc, index) => editor.setPitch(doc, index, source));
}

function nearbyPitch(n) {
  const notes = state.analysis.notes.filter((x) => x.part === n.part && x.staff === n.staff && x.pitch);
  const before = notes.filter((x) => x.index < n.index).pop();
  const after = notes.find((x) => x.index > n.index);
  return (before ?? after)?.pitch ?? { step: "B", alter: 0, octave: 4 };
}

function withContextAlter(pitch, i) {
  return { ...pitch, alter: editor.contextAlter(state.analysis, i, pitch.step, pitch.octave) };
}

function setAccidental(target) {
  editPitch((n, i) => {
    if (!n.pitch) return null;
    const fallback = editor.contextAlter(state.analysis, i, n.pitch.step, n.pitch.octave);
    const alter = n.pitch.alter === target ? (fallback === target ? 0 : fallback) : target;
    return { ...n.pitch, alter };
  });
}

const ACTIONS = {
  dot: () => edit(editor.toggleDot),
  up: () => editPitch((n, i) => (n.pitch ? withContextAlter(editor.moveStep(n.pitch, 1), i) : null)),
  down: () => editPitch((n, i) => (n.pitch ? withContextAlter(editor.moveStep(n.pitch, -1), i) : null)),
  "octave-up": () => editPitch((n) => (n.pitch ? { ...n.pitch, octave: n.pitch.octave + 1 } : null)),
  "octave-down": () => editPitch((n) => (n.pitch ? { ...n.pitch, octave: n.pitch.octave - 1 } : null)),
  sharp: () => setAccidental(1),
  flat: () => setAccidental(-1),
  natural: () => setAccidental(0),
  "link-left": () => edit((doc, i) => editor.toggleLink(doc, i, "left")),
  "link-right": () => edit((doc, i) => editor.toggleLink(doc, i, "right")),
  delete: () => edit(editor.deleteNote),
  duplicate: () => edit(editor.duplicateNote),
  "to-note": () => editPitch((n, i) => (n.rest ? withContextAlter(nearbyPitch(n), i) : null)),
  split: () => edit(editor.splitMeasureAfter),
  merge: () => edit(editor.mergeWithNextMeasure),
  time: () => {
    const [beats, beatType] = ui.timeSig.value.split("/").map(Number);
    edit((doc, i) => editor.setTimeSignature(doc, i, beats, beatType));
  },
};

function handleEditorKey(e) {
  if (!ui.popup.hidden) {
    if (e.key === "Escape") {
      closeInsertPopup();
      hideInsertLine();
      e.preventDefault();
    }
    return;
  }
  if (e.target.closest?.("input, select, textarea") || !state.sourceXml) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (ctrl && (key === "z" || key === "Z")) {
    e.shiftKey ? redo() : undo();
  } else if (ctrl && (key === "y" || key === "Y")) {
    redo();
  } else if (state.selected == null) {
    return;
  } else if (key === "ArrowUp" || key === "ArrowDown") {
    const up = key === "ArrowUp";
    const n = state.analysis.notes[state.selected];
    if (n?.rest) ACTIONS["to-note"]();
    else ACTIONS[ctrl ? (up ? "octave-up" : "octave-down") : (up ? "up" : "down")]();
  } else if (key === "ArrowLeft" || key === "ArrowRight") {
    const next = state.selected + (key === "ArrowRight" ? 1 : -1);
    if (next >= 0 && next < state.analysis.notes.length) select(next, { scroll: true });
  } else if (key === "Delete" || key === "Backspace") {
    ACTIONS.delete();
  } else if (key === "Insert") {
    ACTIONS.duplicate();
  } else if (key === ".") {
    ACTIONS.dot();
  } else if (DURATION_KEYS[key] && !ctrl) {
    edit((doc, i) => editor.setDuration(doc, i, DURATION_KEYS[key]));
  } else if (!ctrl && (key === "d" || key === "D" || key === "#")) {
    ACTIONS.sharp();
  } else if (!ctrl && (key === "b" || key === "B")) {
    ACTIONS.flat();
  } else if (!ctrl && (key === "n" || key === "N")) {
    ACTIONS.natural();
  } else if (key === "Escape") {
    select(null);
  } else {
    return;
  }
  e.preventDefault();
}

// ---------------------------------------------------------------------------
// Insertion d'une note ou d'un silence entre deux notes
// ---------------------------------------------------------------------------

// Position d'un rectangle écran dans le repère du contenu de la zone partition.
function scoreBox(rect) {
  const box = ui.score.getBoundingClientRect();
  const dx = ui.score.scrollLeft - box.left;
  const dy = ui.score.scrollTop - box.top;
  return { left: rect.left + dx, right: rect.right + dx, top: rect.top + dy, bottom: rect.bottom + dy };
}

// Étendue horizontale d'une note (tête, hampe, altération…) dans ce repère.
function noteExtent(index) {
  let left = Infinity;
  let right = -Infinity;
  for (const el of state.noteEls.get(index) ?? []) {
    const r = scoreBox((el.closest(".vf-stavenote") ?? el).getBoundingClientRect());
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  return left < right ? { left, right } : null;
}

// Emplacements libres : avant chaque note/accord, entre deux, en fin de mesure,
// pour chaque voix de chaque portée.
function computeSlots() {
  const osmd = state.osmd;
  const analysis = state.analysis;
  if (!osmd || !analysis) return [];
  const unit = 10 * osmd.zoom;
  const svgs = [...ui.score.querySelectorAll("svg")];
  const slots = [];

  // Événements (note seule, accord, silence) par mesure / portée / voix.
  const groups = new Map();
  for (const n of analysis.notes) {
    if (n.grace) continue;
    const k = `${n.part}|${n.measure}|${n.staff}`;
    if (!groups.has(k)) groups.set(k, new Map());
    const voices = groups.get(k);
    if (!voices.has(n.voice)) voices.set(n.voice, []);
    const events = voices.get(n.voice);
    if (n.chord && events.length) events[events.length - 1].push(n);
    else events.push([n]);
  }

  for (const m of analysis.measures) {
    const row = osmd.GraphicSheet.MeasureList[m.index];
    if (!row) continue;
    const firstStaff = analysis.staffOffsets[m.part];
    for (let staff = firstStaff; staff < firstStaff + m.staves; staff++) {
      const gm = row[staff];
      const box = gm?.PositionAndShape;
      if (!box) continue;
      const page = gm.ParentStaffLine?.ParentMusicSystem?.Parent;
      const svg = svgs[Math.max(0, osmd.GraphicSheet.MusicPages.indexOf(page))] ?? svgs[0];
      if (!svg) continue;
      const origin = scoreBox(svg.getBoundingClientRect());
      const mLeft = origin.left + (box.AbsolutePosition.x + box.BorderLeft) * unit;
      const mRight = origin.left + (box.AbsolutePosition.x + box.BorderRight) * unit;
      const top = origin.top + box.AbsolutePosition.y * unit; // ligne du haut de la portée
      const base = { part: m.part, measure: m.index, staff, top, bottom: top + 4 * unit, unit, fifths: m.fifths };
      const localStaff = staff - firstStaff + 1;

      const voices = groups.get(`${m.part}|${m.index}|${staff}`);
      if (!voices) {
        slots.push({
          ...base, x1: mLeft, x2: mRight, x: mLeft + (mRight - mLeft) / 3,
          clef: m.clefs.get(localStaff) ?? null, before: Infinity,
          target: { where: "end", part: m.part, measure: m.index, staff: localStaff },
        });
        continue;
      }
      for (const events of voices.values()) {
        const extents = events.map((ev) => {
          const boxes = ev.map((n) => noteExtent(n.index)).filter(Boolean);
          return boxes.length
            ? { left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)) }
            : null;
        });
        for (let k = 0; k <= events.length; k++) {
          const prev = extents[k - 1];
          const next = extents[k];
          if ((k > 0 && !prev) || (k < events.length && !next)) continue;
          let x1;
          let x2;
          let x;
          if (k === 0) {
            x1 = Math.max(mLeft, next.left - 2.5 * unit);
            x2 = next.left;
            x = next.left - 0.7 * unit;
          } else if (k === events.length) {
            x1 = prev.right;
            x2 = mRight;
            x = prev.right + Math.min(1.2 * unit, (mRight - prev.right) / 2);
          } else {
            x1 = prev.right;
            x2 = next.left;
            x = (x1 + x2) / 2;
          }
          if (x2 - x1 < 2) continue;
          const ref = k < events.length ? events[k][0] : events[k - 1][events[k - 1].length - 1];
          slots.push({
            ...base, x1, x2, x,
            clef: ref.clef,
            fifths: ref.fifths,
            before: k < events.length ? ref.index : ref.index + 1,
            target: k < events.length ? { where: "before", index: ref.index } : { where: "after", index: ref.index },
          });
        }
      }
    }
  }
  return slots;
}

const CLEF_NOTES = { G: 4 * 7 + 4, F: 3 * 7 + 3, C: 4 * 7 }; // degré de la note de la clé (Sol4, Fa3, Do4)

// Hauteur (affichée) correspondant à la position verticale de la souris.
function pitchAtY(slot, y) {
  const clef = slot.clef;
  const clefDegree = clef && CLEF_NOTES[clef.sign];
  if (clefDegree == null) return null;
  const topDegree = clefDegree + 7 * (clef.octaveChange || 0) + 2 * (5 - clef.line);
  const degree = topDegree - Math.round((y - slot.top) / (slot.unit / 2));
  const step = ["C", "D", "E", "F", "G", "A", "B"][((degree % 7) + 7) % 7];
  const octave = Math.floor(degree / 7);
  const alter = editor.alterAt(state.analysis, slot, step, octave);
  return { step, alter, octave };
}

function findSlot(x, y) {
  state.slots ??= computeSlots();
  let best = null;
  for (const s of state.slots) {
    const margin = 3 * s.unit;
    if (y < s.top - margin || y > s.bottom + margin || x < s.x1 - 2 || x > s.x2 + 2) continue;
    if (!best || Math.abs(x - s.x) < Math.abs(x - best.x)) best = s;
  }
  return best;
}

let insertLine = null;
let insertLabel = null;

function showInsertLine(slot, pitch) {
  if (!insertLine?.isConnected) {
    insertLine = Object.assign(document.createElement("div"), { className: "insert-line no-print" });
    insertLabel = Object.assign(document.createElement("div"), { className: "insert-label no-print" });
    ui.score.append(insertLine, insertLabel);
  }
  const pad = slot.unit;
  Object.assign(insertLine.style, {
    display: "block", left: `${slot.x}px`, top: `${slot.top - pad}px`, height: `${slot.bottom - slot.top + 2 * pad}px`,
  });
  insertLabel.textContent = pitch ? `+ ${pitchLabel(pitch)}` : "+";
  Object.assign(insertLabel.style, { display: "block", left: `${slot.x}px`, top: `${slot.top - pad - 2}px` });
  ui.score.classList.add("tz-can-insert");
}

function hideInsertLine() {
  if (insertLine) insertLine.style.display = "none";
  if (insertLabel) insertLabel.style.display = "none";
  ui.score.classList.remove("tz-can-insert");
  state.hoverSlot = null;
}

function onScoreMove(e) {
  if (!ui.popup.hidden || state.rendering || !state.analysis) return;
  if (e.target.closest?.("[data-note]")) {
    hideInsertLine();
    return;
  }
  const p = scoreBox({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
  const slot = findSlot(p.left, p.top);
  if (!slot) {
    hideInsertLine();
    return;
  }
  const pitch = pitchAtY(slot, p.top);
  state.hoverSlot = { slot, pitch };
  showInsertLine(slot, pitch);
}

function openInsertPopup(e) {
  const { slot, pitch } = state.hoverSlot;
  const n = slot.target.index != null ? state.analysis.notes[slot.target.index] : null;
  state.pending = { slot, pitch: pitch ?? (n?.pitch ? n.pitch : { step: "B", alter: 0, octave: 4 }) };
  ui.ipPitch.textContent = `(${pitchLabel(state.pending.pitch)})`;
  ui.ipKind.hidden = false;
  ui.ipDuration.hidden = true;
  ui.ipDot.checked = false;
  ui.popup.hidden = false;
  // Sous la souris, sans sortir de la fenêtre.
  const { width, height } = ui.popup.getBoundingClientRect();
  ui.popup.style.left = `${Math.max(8, Math.min(e.clientX - 20, innerWidth - width - 8))}px`;
  ui.popup.style.top = `${Math.min(e.clientY + 14, innerHeight - height - 8)}px`;
  ui.ipKind.querySelector("button").focus();
}

function closeInsertPopup() {
  ui.popup.hidden = true;
  state.pending = null;
}

function chooseKind(kind) {
  state.pending.kind = kind;
  ui.ipTitle.textContent = kind === "rest" ? "Silence :" : `Note ${pitchLabel(state.pending.pitch)} :`;
  ui.ipKind.hidden = true;
  ui.ipDuration.hidden = false;
  ui.ipDuration.querySelector('[data-type="quarter"]').focus();
}

function chooseDuration(type) {
  const { slot, pitch, kind } = state.pending;
  const dots = ui.ipDot.checked ? 1 : 0;
  closeInsertPopup();
  hideInsertLine();
  const rest = kind === "rest";
  let source = null;
  if (!rest) {
    const iv = state.report.parts[slot.part]?.interval ?? { diatonic: 0, chromatic: 0 };
    source = transposePitch(pitch, negateInterval(iv));
  }
  apply((doc) => editor.insertNote(doc, slot.target, { rest, pitch: source, type, dots }));
}

// Redimensionnement de la fenêtre : nouveau rendu, puis décorations.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.osmd || !state.sourceXml || state.rendering || state.pageFormat !== "Endless") return;
    state.osmd.render();
    decorate();
    if (state.cursorTimes) state.osmd.cursor?.update();
  }, 250);
});

// ---------------------------------------------------------------------------
// Impression et export
// ---------------------------------------------------------------------------

async function renderWithFormat(format) {
  state.pageFormat = format;
  const osmd = await getOSMD();
  osmd.setOptions({ pageFormat: format });
  osmd.render();
  if (format === "Endless") decorate();
}

async function print() {
  pausePlayback();
  hideCursor();
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
  decorate();
  if (state.cursorTimes) state.osmd.cursor?.update();
});
ui.printBtn.addEventListener("click", print);
ui.downloadBtn.addEventListener("click", download);
ui.playBtn.addEventListener("click", togglePlayback);
ui.score.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-note]");
  if (el) select(Number(el.getAttribute("data-note")));
  else if (state.hoverSlot) openInsertPopup(e);
});
ui.score.addEventListener("mousemove", onScoreMove);
ui.score.addEventListener("mouseleave", () => {
  if (ui.popup.hidden) hideInsertLine();
});
ui.popup.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.kind) chooseKind(b.dataset.kind);
  else if (b.dataset.type) chooseDuration(b.dataset.type);
});
document.addEventListener("mousedown", (e) => {
  if (!ui.popup.hidden && !ui.popup.contains(e.target)) {
    closeInsertPopup();
    hideInsertLine();
  }
});
ui.editorTools.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.type) edit((doc, i) => editor.setDuration(doc, i, b.dataset.type));
  else ACTIONS[b.dataset.action]?.();
});
ui.undoBtn.addEventListener("click", undo);
ui.redoBtn.addEventListener("click", redo);
document.addEventListener("keydown", handleEditorKey);
ui.stopBtn.addEventListener("click", stopPlayback);
ui.playPitch.addEventListener("change", update);
ui.tempo.addEventListener("input", () => {
  ui.tempoLabel.textContent = ui.tempo.value;
  player.setBpm(Number(ui.tempo.value)).then(() => {
    cancelAnimationFrame(state.cursorFrame);
    followPlayback();
  });
});
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

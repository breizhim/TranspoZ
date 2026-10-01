import {
  addIntervals,
  CLEFS,
  comparePosition,
  intervalFifths,
  intervalFromSemitones,
  negateInterval,
  transposePitch,
  transposeScore,
  keyName,
  keySignatureLabel,
  scoreTitle,
  semitoneLabel,
  UNISON,
} from "./transpose.js";
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
  semitones: $("semitones"),
  semiDown: $("semi-down"),
  semiUp: $("semi-up"),
  semiLabel: $("semi-label"),
  keyPref: $("key-pref"),
  summary: $("summary"),
  printBtn: $("print-btn"),
  downloadBtn: $("download-btn"),
  originalBtn: $("original-btn"),
  zoom: $("zoom"),
  playBtn: $("play-btn"),
  stopBtn: $("stop-btn"),
  tempo: $("tempo"),
  octave: $("octave"),
  tempoLabel: $("tempo-label"),
  editor: $("editor"),
  editorTools: $("editor-tools"),
  selInfo: $("sel-info"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  checks: $("checks"),
  popup: $("popup"),
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  modePanels: [...document.querySelectorAll("[data-panel]")],
  playInfo: $("play-info"),
  playFromStart: $("play-from-start"),
  regionInfo: $("region-info"),
  selectAll: $("select-all"),
  selectNone: $("select-none"),
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
  slots: null, // emplacements entre les notes (calculés au premier survol)
  hoverSlot: null,
  mode: "play", // play | notes | transpose | dynamics | clef
  // Sélection à transposer : "all" (toute la partition), null (rien) ou
  // { start, end } en { measure, offset } (end null pendant le choix de la fin).
  region: "all",
};

const player = new TrumpetPlayer();

// ---------------------------------------------------------------------------
// Formulaires
// ---------------------------------------------------------------------------

const NOTE_FR = { C: "Do", D: "Ré", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };
const ALTER_FR = { "-2": "𝄫", "-1": "♭", "0": "", "1": "♯", "2": "𝄪" };

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
  state.osmd.EngravingRules.RehearsalMarkFontSize = 14; // repères A, B… lisibles de loin
  return state.osmd;
}

// Décalage choisi pour la sélection : tonalité (demi-tons) + octave.
function selectionShift() {
  const octaves = Number(ui.octave.value);
  return addIntervals(intervalFromSemitones(Number(ui.semitones.value)), { diatonic: 7 * octaves, chromatic: 12 * octaves });
}

// Seule la sélection est transposée ; le reste de la partition n'est pas touché.
function buildTransposition() {
  const shift = selectionShift();
  const region = state.region?.end ? state.region : null;
  return {
    options: {
      interval: state.region === "all" ? shift : UNISON,
      keyPreference: ui.keyPref.value,
      title: ui.title.value.trim() || null,
      region: region && { ...region, interval: shift },
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
  if (options.region) {
    lines.push(`<p><strong>Sélection (${regionLabel(options.region)}) :</strong> ${semitoneLabel(part.regionInterval.chromatic)}</p>`);
  } else if (state.region !== "all" && selectionShift().chromatic) {
    lines.push("<p><strong>Changement de tonalité :</strong> sans effet, rien n'est sélectionné.</p>");
  }
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
  updateRegionInfo();
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

// Nouvelle partition : rien de la précédente ne doit subsister (réglages de
// transposition, historique, sélection, lecture, menus).
function resetForNewScore() {
  stopPlayback();
  closePopup();
  setMode("play");
  state.history = [];
  state.future = [];
  state.selected = null;
  state.region = "all";
  state.slots = null;
  state.hoverSlot = null;
  state.noteEls = new Map();
  state.analysis = null;
  ui.semitones.value = "0";
  ui.octave.value = "0";
  ui.keyPref.value = "auto";
  ui.score.scrollLeft = 0;
  updateHistoryButtons();
}

function loadSource(xml, title, fallbackTitle = null) {
  resetForNewScore();
  state.sourceXml = xml;
  state.newSource = true;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  ui.title.value = title || scoreTitle(doc) || fallbackTitle || "";
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
  closePopup();
  pausePlayback();
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
    ui.fileInput.value = ""; // pour pouvoir rouvrir le même fichier
  }
}

async function loadSample() {
  setStatus("Chargement de l'exemple…", "busy");
  try {
    const res = await fetch("samples/au-clair-de-la-lune.musicxml");
    showOriginals([]);
    await loadSource(await res.text());
    setStatus("Exemple chargé : essayez le mode Transposition ou la lecture.");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Lecture audio et curseur
// ---------------------------------------------------------------------------

// Nouvelle partition transposée : la lecture s'arrête (sa position est gardée).
function loadPlayer(doc) {
  player.load(doc);
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
  ui.playInfo.textContent = "Cliquez sur la partition pour choisir où commence la lecture.";
  ui.playFromStart.hidden = true;
}

// Barre de lecture à un instant donné (en noires).
function showCursorAt(quarter) {
  const cursor = state.osmd?.cursor;
  if (!cursor) return;
  cursor.show();
  if (!state.cursorTimes) {
    state.cursorTimes = cursorTimes(cursor);
    state.cursorIndex = 0;
  }
  moveCursor(quarter);
}

// Place la lecture à une position de la partition ({ measure, offset }).
function seekTo(pos) {
  const quarter = player.quarterAt(pos.measure, pos.offset);
  if (quarter == null) return;
  player.seek(quarter).then(() => {
    updatePlayButton();
    if (player.playing) {
      cancelAnimationFrame(state.cursorFrame);
      followPlayback();
    }
  });
  showCursorAt(quarter);
  ui.playInfo.textContent = `Lecture à partir de ${positionLabel(pos)}.`;
  ui.playFromStart.hidden = false;
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
    drawRegion();
    alignRehearsalMarks();
  } catch (err) {
    console.error("Correction indisponible :", err);
  }
  if (player.position > 0 && !player.playing) showCursorAt(player.position);
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
    ui.selInfo.textContent = "Cliquez sur une note pour la corriger, ou entre deux notes pour en ajouter une.";
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
  const iv = intervalAt(shown.part, { measure: shown.measure, offset: shown.start });
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
};

function handleEditorKey(e) {
  if (!ui.popup.hidden) {
    if (e.key === "Escape") {
      closePopup();
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
  } else if (state.mode !== "notes" || state.selected == null) {
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
      const base = {
        part: m.part, measure: m.index, staff, top, bottom: top + 4 * unit, unit, fifths: m.fifths, mLeft, mRight,
      };
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

const HOVER_LABELS = { play: "▶", transpose: "⇆", dynamics: "mf" };

function showInsertLine(slot, pitch, { barline = false } = {}) {
  if (!insertLine?.isConnected) {
    insertLine = document.createElement("div");
    insertLabel = document.createElement("div");
    ui.score.append(insertLine, insertLabel);
  }
  const kind = barline ? "rehearsal" : state.mode;
  insertLine.className = `insert-line no-print mode-${kind}`;
  insertLabel.className = `insert-label no-print mode-${kind}`;
  const pad = slot.unit;
  const box = state.mode === "clef";
  const x = barline ? slot.mLeft : slot.x;
  Object.assign(insertLine.style, {
    display: "block",
    left: `${box ? slot.mLeft : x}px`,
    width: box ? `${slot.mRight - slot.mLeft}px` : "",
    top: `${slot.top - pad}px`,
    height: `${slot.bottom - slot.top + 2 * pad}px`,
  });
  insertLabel.textContent = barline ? "□ repère"
    : state.mode === "notes" ? (pitch ? `+ ${pitchLabel(pitch)}` : "+") : HOVER_LABELS[state.mode] ?? "";
  Object.assign(insertLabel.style, {
    display: insertLabel.textContent ? "block" : "none", left: `${x}px`, top: `${slot.top - pad - 2}px`,
  });
  ui.score.classList.add("tz-can-insert");
}

function hideInsertLine() {
  if (insertLine) insertLine.style.display = "none";
  if (insertLabel) insertLabel.style.display = "none";
  ui.score.classList.remove("tz-can-insert");
  state.hoverSlot = null;
}

// ---------------------------------------------------------------------------
// Positions dans la partition, zone de transposition
// ---------------------------------------------------------------------------

const measureOf = (part, index) => state.analysis.measures.find((m) => m.part === part && m.index === index);

function positionLabel({ measure, offset }) {
  const m = measureOf(0, measure);
  const number = m?.number ?? measure + 1;
  if (!offset || !m?.time) return `la mesure ${number}`;
  const beat = (offset * m.time.beatType) / 4 + 1;
  const text = Number.isInteger(beat) ? String(beat) : beat.toFixed(2).replace(/0+$/, "").replace(".", ",");
  return `la mesure ${number} (temps ${text})`;
}

function regionLabel({ start, end }) {
  const label = (pos) => positionLabel(pos).replace(/^la /, "");
  const last = end.offset === 0 ? { measure: end.measure - 1, offset: 0 } : end;
  return start.offset === 0 && end.offset === 0 && last.measure === start.measure
    ? label(start)
    : `${label(start)} → ${end.offset === 0 ? `fin de la ${label(last)}` : label(end)}`;
}

// Position (mesure, instant) d'un emplacement entre deux notes.
function slotPosition(slot) {
  const t = slot.target;
  if (t.where === "end") return { measure: t.measure, offset: 0 };
  const n = state.analysis.notes[t.index];
  if (t.where === "before") return { measure: n.measure, offset: n.start };
  const end = n.start + n.duration;
  const m = measureOf(n.part, n.measure);
  if (m && end >= m.actual - 1e-6 && measureOf(n.part, n.measure + 1)) return { measure: n.measure + 1, offset: 0 };
  return { measure: n.measure, offset: end };
}

function inRegion(pos) {
  const r = state.region;
  return Boolean(r?.end) && comparePosition(pos, r.start) >= 0 && comparePosition(pos, r.end) < 0;
}

// Intervalle appliqué à une position (sélection ou reste de la partition).
function intervalAt(part, pos) {
  const p = state.report?.parts[part];
  if (!p) return { diatonic: 0, chromatic: 0 };
  return inRegion(pos) ? p.regionInterval : p.interval;
}

function updateRegionInfo() {
  const r = state.region;
  ui.selectAll.disabled = r === "all";
  ui.selectNone.disabled = r === null;
  if (r === "all") ui.regionInfo.textContent = "Toute la partition est sélectionnée.";
  else if (!r) ui.regionInfo.textContent = "Rien n'est sélectionné : la tonalité ne change pas.";
  else if (!r.end) ui.regionInfo.textContent = `Début : ${positionLabel(r.start)}. Cliquez pour placer la fin.`;
  else ui.regionInfo.innerHTML = `<strong>Sélection :</strong> ${regionLabel(r)}`;
}

function setRegion(region) {
  state.region = region;
  update();
}

function setRegionBoundary(pos) {
  const r = state.region;
  if (!r || r === "all" || r.end) state.region = { start: pos, end: null };
  else {
    const c = comparePosition(pos, r.start);
    if (c === 0) return;
    state.region = c > 0 ? { start: r.start, end: pos } : { start: pos, end: r.start };
  }
  update();
}

// Colonne d'une mesure (toutes portées), dans le repère du SVG de sa page.
function measureColumn(index) {
  const osmd = state.osmd;
  const row = (osmd.GraphicSheet.MeasureList[index] ?? []).filter((gm) => gm?.PositionAndShape);
  if (!row.length) return null;
  const unit = 10 * osmd.zoom;
  const first = row[0].PositionAndShape;
  const last = row[row.length - 1].PositionAndShape;
  const page = row[0].ParentStaffLine?.ParentMusicSystem?.Parent;
  const svgs = ui.score.querySelectorAll("svg");
  const svg = svgs[Math.max(0, osmd.GraphicSheet.MusicPages.indexOf(page))] ?? svgs[0];
  return {
    svg,
    unit,
    systemStart: row[0].ParentStaffLine?.Measures?.[0] === row[0], // première mesure de la ligne
    left: (first.AbsolutePosition.x + first.BorderLeft) * unit,
    right: (first.AbsolutePosition.x + first.BorderRight) * unit,
    top: (first.AbsolutePosition.y + first.BorderTop - 1.5) * unit,
    bottom: (last.AbsolutePosition.y + last.BorderBottom + 1.5) * unit,
  };
}

// Abscisse (repère du SVG) d'une position : juste avant les notes qui y commencent.
function positionX(pos, column) {
  if (pos.offset === 0) return column.left;
  const origin = scoreBox(column.svg.getBoundingClientRect());
  const later = state.analysis.notes.filter((n) => n.measure === pos.measure && !n.grace && n.start >= pos.offset - 1e-6);
  if (!later.length) return column.right;
  const first = Math.min(...later.map((n) => n.start));
  const lefts = later.filter((n) => Math.abs(n.start - first) < 1e-6).map((n) => noteExtent(n.index)?.left).filter((x) => x != null);
  return lefts.length ? Math.min(...lefts) - origin.left - 0.6 * column.unit : column.right;
}

function svgRect(svg, cls, x, y, width, height, title) {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("class", cls);
  rect.setAttribute("x", x);
  rect.setAttribute("y", y);
  rect.setAttribute("width", Math.max(0, width));
  rect.setAttribute("height", height);
  rect.setAttribute("rx", 4);
  if (title) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = title;
    rect.appendChild(t);
  }
  svg.insertBefore(rect, svg.firstChild);
}

// Sélection à transposer en orange pastel (ou barre de début seule), en mode Transposition.
function drawRegion() {
  for (const old of ui.score.querySelectorAll(".tz-region, .tz-region-mark")) old.remove();
  let r = state.region;
  if (!r || !state.osmd || !state.analysis || state.mode !== "transpose") return;
  if (r === "all") {
    const last = Math.max(...state.analysis.measures.map((m) => m.index));
    r = { start: { measure: 0, offset: 0 }, end: { measure: last + 1, offset: 0 } };
  }
  if (!r.end) {
    const column = measureColumn(r.start.measure);
    if (column) {
      svgRect(column.svg, "tz-region-mark", positionX(r.start, column) - 1.5, column.top, 3, column.bottom - column.top,
        "Début de la zone à transposer");
    }
    return;
  }
  const lastMeasure = r.end.offset > 0 ? r.end.measure : r.end.measure - 1;
  const title = state.region === "all" ? "Toute la partition est sélectionnée" : `Sélection : ${regionLabel(r)}`;
  for (let m = r.start.measure; m <= lastMeasure; m++) {
    const column = measureColumn(m);
    if (!column) continue;
    const x1 = m === r.start.measure ? positionX(r.start, column) : column.left;
    const x2 = m === r.end.measure && r.end.offset > 0 ? positionX(r.end, column) : column.right;
    svgRect(column.svg, "tz-region", x1, column.top, x2 - x1, column.bottom - column.top, title);
  }
}

// ---------------------------------------------------------------------------
// Clics et survol selon le mode
// ---------------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  for (const b of ui.modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  for (const p of ui.modePanels) p.hidden = p.dataset.panel !== mode;
  ui.score.className = ui.score.className.replace(/\btz-mode-\S+/g, "").trim();
  ui.score.classList.add(`tz-mode-${mode}`);
  closePopup();
  hideInsertLine();
  if (mode !== "notes" && state.selected != null) select(null);
  updateRegionInfo();
  drawRegion();
}

function onScoreMove(e) {
  if (!ui.popup.hidden || state.rendering || !state.analysis) return;
  const onNote = e.target.closest?.("[data-note]");
  if (onNote && state.mode !== "clef") {
    hideInsertLine();
    return;
  }
  const p = scoreBox({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
  const barline = state.mode === "dynamics" ? findBarline(p.left, p.top) : null;
  const slot = barline ?? (state.mode === "clef" ? findMeasure(p.left, p.top) : findSlot(p.left, p.top));
  if (!slot) {
    hideInsertLine();
    return;
  }
  const pitch = state.mode === "notes" ? pitchAtY(slot, p.top) : null;
  state.hoverSlot = { slot, pitch, barline: Boolean(barline) };
  showInsertLine(slot, pitch, { barline: Boolean(barline) });
}

// Barre de mesure (début de mesure) sous la souris, pour les repères encadrés.
function findBarline(x, y) {
  state.slots ??= computeSlots();
  let best = null;
  for (const s of state.slots) {
    if (y < s.top - 3 * s.unit || y > s.bottom + 3 * s.unit) continue;
    const d = Math.abs(x - s.mLeft);
    if (d <= 0.7 * s.unit && (!best || d < Math.abs(x - best.mLeft))) best = s;
  }
  return best;
}

function findMeasure(x, y) {
  state.slots ??= computeSlots();
  return state.slots.find((s) => y >= s.top - 3 * s.unit && y <= s.bottom + 3 * s.unit && x >= s.mLeft && x <= s.mRight) ?? null;
}

function onScoreClick(e) {
  const el = e.target.closest?.("[data-note]");
  const note = el ? state.analysis?.notes[Number(el.getAttribute("data-note"))] : null;
  const slot = state.hoverSlot?.slot;
  if (!note && !slot) return;
  // Une note vaut l'emplacement juste avant elle.
  const target = note ? { where: "before", index: note.index } : slot.target;
  const pos = note ? { measure: note.measure, offset: note.start } : slotPosition(slot);
  switch (state.mode) {
    case "play":
      seekTo(pos);
      break;
    case "notes":
      if (note) select(note.index);
      else openInsertPopup(e);
      break;
    case "transpose":
      setRegionBoundary(pos);
      break;
    case "dynamics":
      if (!note && state.hoverSlot?.barline) openRehearsalPopup(e, slot.measure);
      else openDynamicsPopup(e, target, note);
      break;
    case "clef":
      openMeasurePopup(e, note ? { part: note.part, measure: note.measure, staff: note.staff } : slot);
      break;
  }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

// Petit constructeur d'éléments : h("button", { class, onclick, … }, enfants…).
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null));
  return el;
}

const nodes = (content) => [content].flat().filter((c) => c != null);

function openPopup(e, content) {
  ui.popup.replaceChildren(...nodes(content));
  ui.popup.hidden = false;
  const { width, height } = ui.popup.getBoundingClientRect();
  ui.popup.style.left = `${Math.max(8, Math.min(e.clientX - 20, innerWidth - width - 8))}px`;
  ui.popup.style.top = `${Math.max(8, Math.min(e.clientY + 14, innerHeight - height - 8))}px`;
  ui.popup.querySelector("button, select, input")?.focus();
}

function setPopup(content) {
  ui.popup.replaceChildren(...nodes(content));
  ui.popup.querySelector("button, select, input")?.focus();
}

function closePopup() {
  ui.popup.hidden = true;
  ui.popup.replaceChildren();
  hideInsertLine();
}

const DURATIONS = [
  ["whole", "Ronde"], ["half", "Blanche"], ["quarter", "Noire"],
  ["eighth", "Croche"], ["16th", "Double"], ["32nd", "Triple"],
];

// Notes : ajouter une note ou un silence (puis choisir la durée).
function openInsertPopup(e) {
  const { slot, pitch: hovered } = state.hoverSlot;
  const n = slot.target.index != null ? state.analysis.notes[slot.target.index] : null;
  const pitch = hovered ?? n?.pitch ?? { step: "B", alter: 0, octave: 4 };
  const chooseDuration = (rest) => {
    const dot = h("input", { type: "checkbox" });
    setPopup([
      h("div", { class: "title" }, rest ? "Silence :" : `Note ${pitchLabel(pitch)} :`),
      h("div", { class: "grid" }, DURATIONS.map(([type, label]) => h("button", {
        type: "button",
        onclick: () => insertAt(slot, rest ? null : pitch, type, dot.checked ? 1 : 0),
      }, label))),
      h("label", {}, dot, "pointée"),
    ]);
  };
  openPopup(e, h("div", { class: "row" },
    h("button", { type: "button", onclick: () => chooseDuration(false) }, "♪ Note ", h("span", { class: "muted" }, `(${pitchLabel(pitch)})`)),
    h("button", { type: "button", onclick: () => chooseDuration(true) }, "Silence"),
  ));
}

function insertAt(slot, pitch, type, dots) {
  closePopup();
  let source = null;
  if (pitch) source = transposePitch(pitch, negateInterval(intervalAt(slot.part, slotPosition(slot))));
  apply((doc) => editor.insertNote(doc, slot.target, { rest: !pitch, pitch: source, type, dots }));
}

const WORDS = ["cresc.", "dim.", "rit.", "a tempo"];

// Nuances : ajouter, remplacer ou retirer une nuance / indication à cet instant.
function openDynamicsPopup(e, target, note) {
  let where;
  if (target.where === "end") {
    const m = measureOf(target.part, target.measure);
    const hasNotes = state.analysis.notes.some((x) => x.part === m.part && x.measure === m.index);
    where = { part: m.part, measure: m.index, start: hasNotes ? m.actual : 0 };
  } else {
    const n = state.analysis.notes[target.index];
    where = { part: n.part, measure: n.measure, start: target.where === "before" ? n.start : n.start + n.duration };
  }
  const existing = editor.annotationsAt(state.analysis, where);
  const add = (what) => {
    closePopup();
    apply((doc) => editor.addAnnotation(doc, target, what));
  };
  const text = h("input", { type: "text", placeholder: "Texte (dolce, solo…)", size: 14 });
  const m = measureOf(where.part, where.measure);
  openPopup(e, [
    h("div", { class: "title" }, `Mesure ${m?.number ?? where.measure + 1}${note?.pitch ? ` · ${pitchLabel(note.pitch)}` : ""}`),
    existing.length
      ? h("div", { class: "row" }, existing.map((d) => h("span", { class: "chip" }, d.value,
        h("button", {
          type: "button", title: "Retirer",
          onclick: () => {
            closePopup();
            apply((doc) => editor.removeAnnotation(doc, d.index));
          },
        }, "✕"))))
      : null,
    h("div", { class: "row" }, editor.DYNAMICS.map((d) => h("button", { type: "button", class: "dyn", onclick: () => add({ dynamics: d }) }, d))),
    h("div", { class: "row" }, WORDS.map((w) => h("button", { type: "button", onclick: () => add({ words: w }) }, w))),
    h("form", {
      class: "row",
      onsubmit: (ev) => {
        ev.preventDefault();
        if (text.value.trim()) add({ words: text.value.trim() });
      },
    }, text, h("button", { type: "submit" }, "Ajouter")),
  ]);
}

// Repère encadré (A, B, C…) au début d'une mesure.
function openRehearsalPopup(e, measureIndex) {
  const m = measureOf(0, measureIndex);
  const existing = state.analysis.directions.find((d) => d.kind === "rehearsal" && d.part === 0 && d.measure === measureIndex);
  const suggestion = editor.nextRehearsal(state.analysis, measureIndex);
  const set = (text) => {
    closePopup();
    apply((doc) => editor.setRehearsal(doc, measureIndex, text));
  };
  const input = h("input", { type: "text", value: existing?.value ?? suggestion, size: 10, "aria-label": "Texte du repère" });
  const letters = [...new Set([suggestion, ..."ABCDEFGH"])].slice(0, 8);
  openPopup(e, [
    h("div", { class: "title" }, `Mesure ${m?.number ?? measureIndex + 1} — repère encadré`),
    existing
      ? h("div", { class: "row" }, h("span", { class: "chip rehearsal" }, existing.value,
        h("button", { type: "button", title: "Retirer le repère", onclick: () => set(null) }, "✕")))
      : null,
    h("div", { class: "row" }, letters.map((l) => h("button", { type: "button", class: "rehearsal-btn", onclick: () => set(l) }, l))),
    h("form", {
      class: "row",
      onsubmit: (ev) => {
        ev.preventDefault();
        if (input.value.trim()) set(input.value);
      },
    }, input, h("button", { type: "submit" }, existing ? "Remplacer" : "Ajouter")),
  ]);
  input.select();
}

// OSMD place les repères encadrés un peu après la barre : on déplace le cadre et
// son texte pour les centrer sur la barre de mesure (alignés sur le bord en début de ligne).
function alignRehearsalMarks() {
  const marks = state.analysis?.directions.filter((d) => d.kind === "rehearsal") ?? [];
  for (const mark of marks) {
    const column = measureColumn(mark.measure);
    if (!column) continue;
    for (const text of column.svg.querySelectorAll("text")) {
      if (text.textContent.trim() !== mark.value || text.hasAttribute("data-tz-moved")) continue;
      // Le cadre dessiné par VexFlow précède le texte.
      let frame = text.previousElementSibling;
      while (frame && frame.nodeName !== "rect" && frame.nodeName === "path") frame = frame.previousElementSibling;
      if (frame?.nodeName !== "rect" || frame.getAttribute("fill") !== "none") continue;
      const x = Number(frame.getAttribute("x"));
      const width = Number(frame.getAttribute("width"));
      if (Math.abs(x - column.left) > 6 * column.unit) continue; // repère d'une autre mesure
      const target = column.systemStart ? column.left : column.left - width / 2;
      const dx = target - x;
      for (const el of [frame, text]) {
        el.setAttribute("transform", `translate(${dx} 0)`);
        el.setAttribute("data-tz-moved", "");
      }
      break;
    }
  }
}

const TIME_CHOICES = ["2/4", "3/4", "4/4", "2/2", "3/8", "6/8", "9/8", "12/8", "5/4", "7/8"];

// Clé & mesure : clé, armure et chiffrage à partir d'une mesure.
function openMeasurePopup(e, where) {
  const m = measureOf(where.part, where.measure);
  if (!m) return;
  const localStaff = where.staff - state.analysis.staffOffsets[m.part] + 1;
  const clef = m.clefs.get(localStaff);
  const clefKey = Object.entries(CLEFS).find(([, c]) =>
    clef && c.sign === clef.sign && c.line === clef.line && c.octave === (clef.octaveChange || 0))?.[0] ?? "G";
  const clefSelect = h("select", {}, Object.entries(CLEFS).map(([k, c]) => h("option", { value: k, selected: k === clefKey }, c.label)));
  const keySelect = h("select", {}, Array.from({ length: 15 }, (_, i) => i - 7).map((f) =>
    h("option", { value: f, selected: f === m.fifths }, `${keySignatureLabel(f)} — ${keyName(f)}`)));
  const applyToNotes = h("input", { type: "checkbox", checked: true });
  const timeValue = m.time ? `${m.time.beats}/${m.time.beatType}` : "4/4";
  const timeSelect = h("select", {}, [...new Set([timeValue, ...TIME_CHOICES])].map((t) =>
    h("option", { value: t, selected: t === timeValue }, t)));

  const submit = () => {
    const newClef = clefSelect.value !== clefKey ? CLEFS[clefSelect.value] : null;
    const shown = Number(keySelect.value);
    const newTime = timeSelect.value !== timeValue ? timeSelect.value.split("/").map(Number) : null;
    closePopup();
    if (!newClef && shown === m.fifths && !newTime) return;
    // Armure choisie sur la partition affichée → armure d'origine.
    let fifths = shown - intervalFifths(intervalAt(m.part, { measure: m.index, offset: 0 }));
    while (fifths > 7) fifths -= 12;
    while (fifths < -7) fifths += 12;
    apply((doc) => {
      if (shown !== m.fifths) {
        const r = editor.setKeyAt(doc, m.part, m.index, fifths, { applyToNotes: applyToNotes.checked });
        if (r.error) return r;
      }
      if (newClef) {
        editor.setClefAt(doc, m.part, m.index, localStaff, { sign: newClef.sign, line: newClef.line, octaveChange: newClef.octave });
      }
      if (newTime) editor.setTimeAt(doc, m.index, newTime[0], newTime[1]);
      return {};
    });
  };
  openPopup(e, h("form", {
    class: "popup-form",
    onsubmit: (ev) => {
      ev.preventDefault();
      submit();
    },
  },
  h("div", { class: "title" }, `Mesure ${m.number}${m.staves > 1 ? `, portée ${localStaff}` : ""} — à partir d'ici`),
  h("div", { class: "field-line" }, "Clé", clefSelect),
  h("div", { class: "field-line" }, "Armure", keySelect),
  h("label", {}, applyToNotes, "Appliquer l'armure aux notes (corrige la reconnaissance)"),
  h("div", { class: "field-line" }, "Chiffrage", timeSelect),
  h("div", { class: "row" },
    h("button", { type: "submit", class: "primary" }, "Appliquer"),
    h("button", { type: "button", onclick: closePopup }, "Annuler")),
  ));
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
  else alignRehearsalMarks(); // aussi pour l'impression
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
  const base = `${ui.title.value.trim() || "partition"} - transposé`;
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
ui.score.addEventListener("click", onScoreClick);
ui.score.addEventListener("mousemove", onScoreMove);
ui.score.addEventListener("mouseleave", () => {
  if (ui.popup.hidden) hideInsertLine();
});
document.addEventListener("mousedown", (e) => {
  if (!ui.popup.hidden && !ui.popup.contains(e.target)) closePopup();
});
for (const b of ui.modeButtons) b.addEventListener("click", () => setMode(b.dataset.mode));
ui.playFromStart.addEventListener("click", stopPlayback);
ui.selectAll.addEventListener("click", () => setRegion("all"));
ui.selectNone.addEventListener("click", () => setRegion(null));
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
ui.octave.addEventListener("change", update);
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

setMode("play");
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

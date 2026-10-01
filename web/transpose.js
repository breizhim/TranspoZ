// Transposition de partitions MusicXML (score-partwise).
//
// N'utilise que l'API DOM standard (getElementsByTagName, createElement…) pour
// fonctionner à l'identique dans le navigateur et sous Node (avec @xmldom/xmldom).
//
// Un intervalle est représenté par { diatonic, chromatic } :
//   diatonic  = nombre de degrés (C→D = 1), chromatic = nombre de demi-tons.
// Cette représentation conserve l'orthographe : une seconde mineure (1, 1)
// transforme C en D♭, alors qu'un unisson augmenté (0, 1) le transforme en C♯.

export const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

const ACCIDENTAL_NAMES = {
  "-2": "flat-flat",
  "-1": "flat",
  "0": "natural",
  "1": "sharp",
  "2": "double-sharp",
};

// Fenêtres d'armures acceptées selon la préférence (12 ou 13 valeurs consécutives).
const KEY_WINDOWS = {
  auto: [-6, 6],
  sharps: [-5, 6],
  flats: [-6, 5],
};

const mod = (n, m) => ((n % m) + m) % m;

export const UNISON = Object.freeze({ diatonic: 0, chromatic: 0 });

export function addIntervals(...intervals) {
  return intervals.reduce(
    (acc, iv) => ({
      diatonic: acc.diatonic + (iv?.diatonic ?? 0),
      chromatic: acc.chromatic + (iv?.chromatic ?? 0),
    }),
    { diatonic: 0, chromatic: 0 },
  );
}

export function negateInterval(iv) {
  return { diatonic: -iv.diatonic, chromatic: -iv.chromatic };
}

// Orthographe par défaut d'une transposition en demi-tons (seconde mineure,
// seconde majeure, tierce mineure…). L'armure résultante est ensuite
// éventuellement réorthographiée par resolveInterval().
const DEFAULT_DIATONIC = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];

export function intervalFromSemitones(semitones) {
  const sign = semitones < 0 ? -1 : 1;
  const abs = Math.abs(semitones);
  const octaves = Math.floor(abs / 12);
  const diatonic = octaves * 7 + DEFAULT_DIATONIC[abs % 12];
  return { diatonic: sign * diatonic, chromatic: semitones };
}

// Variation (en quintes) de l'armure provoquée par un intervalle.
export function intervalFifths({ diatonic, chromatic }) {
  return 7 * chromatic - 12 * diatonic;
}

// Ajuste l'orthographe de l'intervalle pour que l'armure d'arrivée reste
// lisible (au plus 6 altérations par défaut). Une variation de ±12 quintes
// correspond à une seconde diminuée, d'où l'ajustement de ±1 degré.
export function resolveInterval(interval, fifths, keyPreference = "auto") {
  let { diatonic, chromatic } = interval;
  let target = fifths + intervalFifths(interval);
  if (target === fifths) return { diatonic, chromatic };
  const [lo, hi] = KEY_WINDOWS[keyPreference] ?? KEY_WINDOWS.auto;
  while (target > hi) {
    target -= 12;
    diatonic += 1;
  }
  while (target < lo) {
    target += 12;
    diatonic -= 1;
  }
  return { diatonic, chromatic };
}

export function transposePitch({ step, alter = 0, octave }, interval) {
  const idx = STEPS.indexOf(step);
  if (idx < 0) throw new Error(`Nom de note invalide : ${step}`);
  let degree = octave * 7 + idx + interval.diatonic;
  const semitone = octave * 12 + STEP_SEMITONES[idx] + alter + interval.chromatic;
  const spell = (d) => {
    const o = Math.floor(d / 7);
    const s = mod(d, 7);
    return { step: STEPS[s], octave: o, alter: semitone - (o * 12 + STEP_SEMITONES[s]) };
  };
  let result = spell(degree);
  // Évite les triples altérations en changeant de nom de note.
  while (result.alter > 2) result = spell(++degree);
  while (result.alter < -2) result = spell(--degree);
  return result;
}

// Transposition d'une classe de hauteur (sans octave), pour les accords.
export function transposePitchClass(step, alter, interval) {
  const { step: s, alter: a } = transposePitch({ step, alter, octave: 4 }, interval);
  return { step: s, alter: a };
}

export function keyAlter(fifths, step) {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

const MAJOR_KEYS = ["Do♭", "Sol♭", "Ré♭", "La♭", "Mi♭", "Si♭", "Fa", "Do", "Sol", "Ré", "La", "Mi", "Si", "Fa♯", "Do♯"];
const MINOR_KEYS = ["La♭", "Mi♭", "Si♭", "Fa", "Do", "Sol", "Ré", "La", "Mi", "Si", "Fa♯", "Do♯", "Sol♯", "Ré♯", "La♯"];

export function keySignatureLabel(fifths) {
  if (fifths === 0) return "aucune altération";
  const n = Math.abs(fifths);
  return `${n}${fifths > 0 ? "♯" : "♭"}`;
}

export function keyName(fifths, mode) {
  if (fifths < -7 || fifths > 7) return keySignatureLabel(fifths);
  const major = `${MAJOR_KEYS[fifths + 7]} majeur`;
  const minor = `${MINOR_KEYS[fifths + 7]} mineur`;
  if (mode === "major") return major;
  if (mode === "minor") return minor;
  return `${major} / ${minor}`;
}

// Libellé d'un décalage en demi-tons (« tierce majeure vers le haut (+4 demi-tons) »).
const INTERVAL_NAMES = [
  "unisson", "seconde mineure", "seconde majeure", "tierce mineure", "tierce majeure",
  "quarte juste", "triton", "quinte juste", "sixte mineure", "sixte majeure",
  "septième mineure", "septième majeure",
];

export function semitoneLabel(semitones) {
  if (semitones === 0) return "aucune";
  const abs = Math.abs(semitones);
  const dir = semitones > 0 ? "vers le haut" : "vers le bas";
  const octaves = Math.floor(abs / 12);
  const rest = abs % 12;
  const parts = [];
  if (octaves) parts.push(octaves === 1 ? "une octave" : `${octaves} octaves`);
  if (rest) parts.push(INTERVAL_NAMES[rest]);
  return `${parts.join(" + ")} ${dir} (${semitones > 0 ? "+" : "−"}${abs} demi-ton${abs > 1 ? "s" : ""})`;
}

// ---------------------------------------------------------------------------
// Aides DOM
// ---------------------------------------------------------------------------

function children(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || n.nodeName === name)) out.push(n);
  }
  return out;
}

function child(el, name) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.nodeName === name) return n;
  }
  return null;
}

function childText(el, name) {
  const c = child(el, name);
  return c ? c.textContent.trim() : null;
}

function setText(el, text) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument.createTextNode(String(text)));
}

function makeElement(doc, name, text) {
  const el = doc.createElement(name);
  if (text !== undefined) el.appendChild(doc.createTextNode(String(text)));
  return el;
}

// Insère `node` dans `parent` avant le premier enfant dont le nom figure dans
// `before` (pour respecter l'ordre imposé par le schéma MusicXML).
function insertOrdered(parent, node, before) {
  const ref = children(parent).find((c) => before.includes(c.nodeName));
  if (ref) parent.insertBefore(node, ref);
  else parent.appendChild(node);
}

const NOTE_AFTER_ACCIDENTAL = [
  "time-modification", "stem", "notehead", "notehead-text", "staff", "beam",
  "notations", "lyric", "play", "listen",
];
const ATTRIBUTES_AFTER_TRANSPOSE = ["for-part", "directive", "measure-style"];
const ATTRIBUTES_AFTER_KEY = [
  "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose",
  ...ATTRIBUTES_AFTER_TRANSPOSE,
];
const ATTRIBUTES_AFTER_CLEF = ["staff-details", "transpose", ...ATTRIBUTES_AFTER_TRANSPOSE];
const SCORE_AFTER_MOVEMENT_TITLE = ["identification", "defaults", "credit", "part-list"];

// ---------------------------------------------------------------------------
// Clés
// ---------------------------------------------------------------------------

export const CLEFS = {
  G: { sign: "G", line: 2, octave: 0, label: "Sol" },
  G8vb: { sign: "G", line: 2, octave: -1, label: "Sol octaviée" },
  F: { sign: "F", line: 4, octave: 0, label: "Fa" },
  C3: { sign: "C", line: 3, octave: 0, label: "Ut 3e ligne" },
  C4: { sign: "C", line: 4, octave: 0, label: "Ut 4e ligne" },
};

function applyClef(clefEl, clef) {
  const doc = clefEl.ownerDocument;
  for (const c of children(clefEl)) clefEl.removeChild(c);
  clefEl.appendChild(makeElement(doc, "sign", clef.sign));
  clefEl.appendChild(makeElement(doc, "line", clef.line));
  if (clef.octave) clefEl.appendChild(makeElement(doc, "clef-octave-change", clef.octave));
}

// ---------------------------------------------------------------------------
// Transposition d'une partition complète
// ---------------------------------------------------------------------------

function readPitch(pitchEl) {
  return {
    step: childText(pitchEl, "step"),
    alter: Number(childText(pitchEl, "alter") ?? 0) || 0,
    octave: Number(childText(pitchEl, "octave")),
  };
}

function writePitch(pitchEl, { step, alter, octave }) {
  const doc = pitchEl.ownerDocument;
  for (const c of children(pitchEl)) pitchEl.removeChild(c);
  pitchEl.appendChild(makeElement(doc, "step", step));
  if (alter) pitchEl.appendChild(makeElement(doc, "alter", alter));
  pitchEl.appendChild(makeElement(doc, "octave", octave));
}

function hasTieStop(note) {
  return children(note, "tie").some((t) => t.getAttribute("type") === "stop");
}

function setAccidental(note, alter) {
  const doc = note.ownerDocument;
  for (const a of children(note, "accidental")) note.removeChild(a);
  if (alter === null) return;
  const name = ACCIDENTAL_NAMES[String(alter)];
  if (!name) return;
  insertOrdered(note, makeElement(doc, "accidental", name), NOTE_AFTER_ACCIDENTAL);
}

function transposeHarmony(harmony, interval) {
  const pairs = [
    ["root", "root-step", "root-alter"],
    ["bass", "bass-step", "bass-alter"],
  ];
  for (const [container, stepName, alterName] of pairs) {
    for (const c of children(harmony, container)) {
      const stepEl = child(c, stepName);
      if (!stepEl) continue;
      const alterEl = child(c, alterName);
      const alter = alterEl ? Number(alterEl.textContent) || 0 : 0;
      const res = transposePitchClass(stepEl.textContent.trim(), alter, interval);
      setText(stepEl, res.step);
      if (res.alter) {
        if (alterEl) setText(alterEl, res.alter);
        else {
          const el = makeElement(c.ownerDocument, alterName, res.alter);
          if (stepEl.nextSibling) c.insertBefore(el, stepEl.nextSibling);
          else c.appendChild(el);
        }
      } else if (alterEl) {
        c.removeChild(alterEl);
      }
    }
  }
}

function firstKey(part) {
  const key = part.getElementsByTagName("key")[0];
  if (!key) return { fifths: 0, mode: null };
  const fifths = Number(childText(key, "fifths"));
  return { fifths: Number.isFinite(fifths) ? fifths : 0, mode: childText(key, "mode") };
}

function writeTransposeElement(attributes, iv) {
  const doc = attributes.ownerDocument;
  const octaves = Math.trunc(iv.chromatic / 12);
  const el = doc.createElement("transpose");
  el.appendChild(makeElement(doc, "diatonic", iv.diatonic - 7 * octaves));
  el.appendChild(makeElement(doc, "chromatic", iv.chromatic - 12 * octaves));
  if (octaves) el.appendChild(makeElement(doc, "octave-change", octaves));
  insertOrdered(attributes, el, ATTRIBUTES_AFTER_TRANSPOSE);
}

function setTitle(root, title) {
  const doc = root.ownerDocument;
  let found = false;
  for (const el of children(root, "movement-title")) {
    setText(el, title);
    found = true;
  }
  const work = child(root, "work");
  const workTitle = work && child(work, "work-title");
  if (workTitle) {
    setText(workTitle, title);
    found = true;
  }
  if (!found) insertOrdered(root, makeElement(doc, "movement-title", title), SCORE_AFTER_MOVEMENT_TITLE);
  // Les crédits de type « title » (souvent produits par l'OMR) sont aussi mis à jour.
  for (const credit of children(root, "credit")) {
    const type = childText(credit, "credit-type");
    const words = child(credit, "credit-words");
    if (type === "title" && words) setText(words, title);
  }
}

/**
 * Transpose un document MusicXML (modifié sur place).
 *
 * @param {Document} doc
 * @param {object} options
 * @param {{diatonic:number, chromatic:number}} options.interval   intervalle écrit à appliquer
 * @param {"auto"|"sharps"|"flats"} [options.keyPreference]         orthographe des armures
 * @param {string|null} [options.clef]                              clé imposée (clé de CLEFS) pour les portées simples
 * @param {{diatonic:number, chromatic:number}|null} [options.instrumentTransposition]
 *        transposition de l'instrument de sortie (élément <transpose>), null pour ne pas toucher
 * @param {string|null} [options.partName]   nom de partie à afficher (partitions à une seule partie)
 * @param {string|null} [options.title]      titre du morceau
 * @param {{start:{measure:number, offset:number}, end:{measure:number, offset:number},
 *          interval:{diatonic:number, chromatic:number}}|null} [options.region]
 *        zone (de start inclus à end exclu, offset en noires dans la mesure) qui reçoit en plus
 *        `region.interval` ; alignée sur des barres de mesure, l'armure change au début et revient à la fin
 * @returns {{parts: Array<{id:string, from:{fifths:number, mode:string|null}, to:{fifths:number, mode:string|null},
 *            interval:object, regionInterval:object}>}}
 */
export function transposeScore(doc, options = {}) {
  const root = doc.documentElement;
  if (!root || root.nodeName !== "score-partwise") {
    throw new Error("Seul le format MusicXML « score-partwise » est pris en charge.");
  }
  const {
    interval = UNISON,
    keyPreference = "auto",
    clef = null,
    instrumentTransposition = null,
    partName = null,
    title = null,
    region = null,
  } = options;

  if (title) setTitle(root, title);

  const parts = children(root, "part");
  if (partName && parts.length === 1) {
    const partList = child(root, "part-list");
    const scorePart = partList && child(partList, "score-part");
    const nameEl = scorePart && child(scorePart, "part-name");
    if (nameEl) setText(nameEl, partName);
    const instName = scorePart && scorePart.getElementsByTagName("instrument-name")[0];
    if (instName) setText(instName, partName);
  }

  const report = { parts: [] };
  const clefDef = clef ? CLEFS[clef] : null;
  const zone = region && comparePosition(region.end, region.start) > 0 ? region : null;
  const isIdentityInterval = (iv) => iv.diatonic === 0 && iv.chromatic === 0;

  for (const part of parts) {
    const initial = firstKey(part);
    const ivOut = resolveInterval(interval, initial.fifths, keyPreference);
    const ivIn = zone
      ? resolveInterval(addIntervals(interval, zone.interval), initial.fifths, keyPreference)
      : ivOut;
    const shift = { out: intervalFifths(ivOut), in: intervalFifths(ivIn) };
    // Zone alignée sur les barres de mesure : changement d'armure au début et retour à la fin.
    const keyChanges = zone && zone.start.offset === 0 && zone.end.offset === 0 && shift.in !== shift.out;
    let staves = 1;
    let transposeWritten = false;
    let divisions = 1;
    // Armures d'origine et affichées, par portée (« * » = toutes les portées).
    const sourceKeys = new Map([["*", initial.fifths]]);
    const keyByStaff = new Map([["*", initial.fifths]]);
    const currentKey = (staff) => keyByStaff.get(staff) ?? keyByStaff.get("*");

    children(part, "measure").forEach((measure, mi) => {
      const alterations = new Map();
      const inZone = (offset) => Boolean(zone) &&
        comparePosition({ measure: mi, offset }, zone.start) >= 0 &&
        comparePosition({ measure: mi, offset }, zone.end) < 0;
      if (keyChanges && (mi === zone.start.measure || mi === zone.end.measure)) {
        ensureKeyAtStart(measure, sourceKeys.get("*"));
      }
      let pos = 0;
      let lastStart = 0;

      for (const el of children(measure)) {
        if (el.nodeName === "attributes") {
          divisions = Number(childText(el, "divisions")) || divisions;
          const stavesText = childText(el, "staves");
          if (stavesText) staves = Number(stavesText) || 1;
          const iv = inZone(pos) ? ivIn : ivOut;

          for (const key of children(el, "key")) {
            const fifthsEl = child(key, "fifths");
            if (!fifthsEl) continue;
            const source = Number(fifthsEl.textContent);
            let fifths = source + (iv === ivIn ? shift.in : shift.out);
            while (fifths > 7) fifths -= 12;
            while (fifths < -7) fifths += 12;
            if (fifths !== source) setText(fifthsEl, fifths);
            const number = key.getAttribute("number");
            if (number) {
              sourceKeys.set(number, source);
              keyByStaff.set(number, fifths);
            } else {
              sourceKeys.clear();
              sourceKeys.set("*", source);
              keyByStaff.clear();
              keyByStaff.set("*", fifths);
            }
          }

          if (clefDef && staves === 1) {
            for (const c of children(el, "clef")) applyClef(c, clefDef);
          }

          if (instrumentTransposition) {
            for (const t of children(el, "transpose")) el.removeChild(t);
            const isInstrumentTransposing =
              instrumentTransposition.diatonic !== 0 || instrumentTransposition.chromatic !== 0;
            if (!transposeWritten && isInstrumentTransposing) {
              writeTransposeElement(el, instrumentTransposition);
            }
            transposeWritten = true;
          }
        } else if (el.nodeName === "backup") {
          pos -= (Number(childText(el, "duration")) || 0) / divisions;
        } else if (el.nodeName === "forward") {
          pos += (Number(childText(el, "duration")) || 0) / divisions;
        } else if (el.nodeName === "note") {
          const isChord = Boolean(child(el, "chord"));
          const duration = child(el, "grace") ? 0 : (Number(childText(el, "duration")) || 0) / divisions;
          const start = isChord ? lastStart : pos;
          if (!isChord) {
            lastStart = pos;
            pos += duration;
          }
          const pitchEl = child(el, "pitch");
          if (!pitchEl) continue;
          const iv = inZone(start) ? ivIn : ivOut;
          const isIdentity = isIdentityInterval(iv);
          const pitch = transposePitch(readPitch(pitchEl), iv);
          if (!isIdentity) writePitch(pitchEl, pitch);

          const staff = childText(el, "staff") ?? "1";
          const slot = `${staff}|${pitch.step}${pitch.octave}`;
          const expected = alterations.has(slot)
            ? alterations.get(slot)
            : keyAlter(currentKey(staff), pitch.step);
          if (hasTieStop(el)) {
            // Note liée : pas de nouvelle altération affichée.
            if (!isIdentity) setAccidental(el, null);
          } else {
            if (!isIdentity || pitch.alter !== expected) {
              setAccidental(el, pitch.alter !== expected ? pitch.alter : null);
            }
            alterations.set(slot, pitch.alter);
          }
        } else if (el.nodeName === "harmony") {
          const iv = inZone(pos) ? ivIn : ivOut;
          if (!isIdentityInterval(iv)) transposeHarmony(el, iv);
        }
      }
    });

    // Pas d'attributs du tout : on ajoute l'élément <transpose> en tête.
    if (instrumentTransposition && !transposeWritten) {
      const firstMeasure = child(part, "measure");
      const isInstrumentTransposing =
        instrumentTransposition.diatonic !== 0 || instrumentTransposition.chromatic !== 0;
      if (firstMeasure && isInstrumentTransposing) {
        const attributes = doc.createElement("attributes");
        firstMeasure.insertBefore(attributes, firstMeasure.firstChild);
        writeTransposeElement(attributes, instrumentTransposition);
      }
    }

    report.parts.push({
      id: part.getAttribute("id"),
      from: initial,
      to: normalizeKey({ fifths: initial.fifths + shift.out, mode: initial.mode }),
      interval: ivOut,
      regionInterval: ivIn,
    });
  }
  return report;
}

/** Compare deux positions { measure, offset } (offset en noires dans la mesure). */
export function comparePosition(a, b) {
  return a.measure - b.measure || (Math.abs(a.offset - b.offset) < 1e-6 ? 0 : a.offset - b.offset);
}

// Rend explicite l'armure en vigueur au début d'une mesure (pour pouvoir la changer).
function ensureKeyAtStart(measure, fifths) {
  const doc = measure.ownerDocument;
  const first = children(measure).find((el) => !["print", "barline"].includes(el.nodeName));
  let attributes = first?.nodeName === "attributes" ? first : null;
  if (attributes && child(attributes, "key")) return;
  if (!attributes) {
    attributes = doc.createElement("attributes");
    measure.insertBefore(attributes, first ?? null);
  }
  const key = doc.createElement("key");
  key.appendChild(makeElement(doc, "fifths", fifths));
  insertOrdered(attributes, key, ATTRIBUTES_AFTER_KEY);
}

function normalizeKey(key) {
  let { fifths } = key;
  while (fifths > 7) fifths -= 12;
  while (fifths < -7) fifths += 12;
  return { ...key, fifths };
}

// Titre d'une partition (movement-title, work-title ou crédit « title »).
export function scoreTitle(doc) {
  const root = doc.documentElement;
  const movement = childText(root, "movement-title");
  if (movement) return movement;
  const work = child(root, "work");
  const workTitle = work && childText(work, "work-title");
  if (workTitle) return workTitle;
  for (const credit of children(root, "credit")) {
    if (childText(credit, "credit-type") === "title") return childText(credit, "credit-words");
  }
  return null;
}

// Nombre de portées de chaque partie (pour savoir si une clé peut être imposée).
export function scoreParts(doc) {
  return children(doc.documentElement, "part").map((part) => {
    const stavesEl = part.getElementsByTagName("staves")[0];
    return { id: part.getAttribute("id"), staves: stavesEl ? Number(stavesEl.textContent) || 1 : 1 };
  });
}

// Correction de partitions MusicXML : analyse (durées des mesures, voix,
// liaisons) et opérations d'édition sur une note.
//
// Les notes sont repérées par leur rang parmi les éléments <note> du document.
// La transposition ne crée ni ne supprime de note : ce rang est le même dans
// la partition d'origine et dans la partition transposée affichée.
//
// Chaque opération modifie le document sur place et renvoie éventuellement
// { error } (rien n'a été modifié) ou { select } (note à sélectionner ensuite).

const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const EPS = 1e-6;

/** Valeurs de notes, en noires. */
export const NOTE_TYPES = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

const NOTE_ORDER = [
  "grace", "chord", "pitch", "unpitched", "rest", "cue", "duration", "tie", "instrument",
  "voice", "type", "dot", "accidental", "time-modification", "stem", "notehead",
  "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen",
];
const ATTRIBUTES_ORDER = [
  "footnote", "level", "divisions", "key", "time", "staves", "part-symbol", "instruments",
  "clef", "staff-details", "transpose", "for-part", "directive", "measure-style",
];

// ---------------------------------------------------------------------------
// Utilitaires DOM
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

function numberOr(text, fallback) {
  const n = Number(text);
  return text != null && text !== "" && Number.isFinite(n) ? n : fallback;
}

function setText(el, text) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument.createTextNode(String(text)));
}

function makeElement(doc, name, text = null, attrs = {}) {
  const el = doc.createElement(name);
  if (text != null) el.appendChild(doc.createTextNode(String(text)));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Insère `node` à sa place selon l'ordre imposé par MusicXML.
function insertOrdered(parent, node, order) {
  const rank = order.indexOf(node.nodeName);
  for (const c of children(parent)) {
    if (order.indexOf(c.nodeName) > rank) {
      parent.insertBefore(node, c);
      return node;
    }
  }
  parent.appendChild(node);
  return node;
}

function removeAll(el, name) {
  for (const c of children(el, name)) el.removeChild(c);
}

// ---------------------------------------------------------------------------
// Hauteurs
// ---------------------------------------------------------------------------

export function readPitch(pitchEl) {
  return {
    step: childText(pitchEl, "step"),
    alter: numberOr(childText(pitchEl, "alter"), 0),
    octave: numberOr(childText(pitchEl, "octave"), 4),
  };
}

export function pitchMidi({ step, alter = 0, octave }) {
  return (octave + 1) * 12 + STEP_SEMITONES[step] + alter;
}

/** Monte ou descend d'un nombre de degrés (sans altération). */
export function moveStep({ step, octave }, delta) {
  const degree = octave * 7 + STEPS.indexOf(step) + delta;
  return { step: STEPS[((degree % 7) + 7) % 7], alter: 0, octave: Math.floor(degree / 7) };
}

function writePitch(note, pitch) {
  const doc = note.ownerDocument;
  let pitchEl = child(note, "pitch");
  if (!pitchEl) {
    const rest = child(note, "rest");
    pitchEl = doc.createElement("pitch");
    if (rest) note.replaceChild(pitchEl, rest);
    else insertOrdered(note, pitchEl, NOTE_ORDER);
  }
  while (pitchEl.firstChild) pitchEl.removeChild(pitchEl.firstChild);
  pitchEl.appendChild(makeElement(doc, "step", pitch.step));
  if (pitch.alter) pitchEl.appendChild(makeElement(doc, "alter", pitch.alter));
  pitchEl.appendChild(makeElement(doc, "octave", pitch.octave));
  // L'altération affichée est recalculée par la transposition.
  removeAll(note, "accidental");
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

function timeSignature(attributes) {
  const time = child(attributes, "time");
  if (!time) return undefined;
  if (child(time, "senza-misura")) return null;
  const beats = (childText(time, "beats") || "").split("+").reduce((s, b) => s + numberOr(b, 0), 0);
  const beatType = numberOr(childText(time, "beat-type"), 0);
  return beats > 0 && beatType > 0 ? { beats, beatType, quarters: (beats * 4) / beatType } : null;
}

/**
 * Analyse une partition.
 *
 * @returns {{
 *   notes: Array<{index:number, el:Element, part:number, measure:number, staff:number,
 *     voice:string, start:number, duration:number, divisions:number, grace:boolean,
 *     chord:boolean, rest:boolean, pitch:object|null, fifths:number, dots:number, type:string|null}>,
 *   measures: Array<{part:number, index:number, number:string, el:Element,
 *     expected:number|null, actual:number, time:object|null, status:"ok"|"short"|"long"}>,
 *   partCount:number, staffOffsets:number[]
 * }}  temps en noires (début relatif à la mesure), portées numérotées sur toute la partition
 */
export function analyzeScore(doc) {
  const parts = children(doc.documentElement, "part");
  const notes = [];
  const measures = [];
  const directions = [];
  const staffOffsets = [];
  let staffOffset = 0;

  parts.forEach((part, p) => {
    staffOffsets.push(staffOffset);
    let staves = 1;
    for (const s of part.getElementsByTagName("staves")) staves = Math.max(staves, numberOr(s.textContent, 1));
    let divisions = 1;
    let time = null;
    const keys = new Map([["*", 0]]);
    const keyOf = (staff) => keys.get(String(staff)) ?? keys.get("*");
    const clefs = new Map(); // portée locale → { sign, line, octaveChange }
    const partMeasures = [];

    children(part, "measure").forEach((m, mi) => {
      let pos = 0;
      let maxPos = 0;
      let lastStart = 0;
      const before = { fifths: keyOf(1), clefs: new Map(clefs), time };
      const changes = { key: false, clefs: new Set(), time: false };
      for (const el of children(m)) {
        if (el.nodeName === "attributes") {
          divisions = numberOr(childText(el, "divisions"), divisions);
          for (const key of children(el, "key")) {
            const fifths = numberOr(childText(key, "fifths"), 0);
            const number = key.getAttribute("number");
            if (number) keys.set(number, fifths);
            else {
              keys.clear();
              keys.set("*", fifths);
            }
          }
          const t = timeSignature(el);
          if (t !== undefined) {
            time = t;
            changes.time = true;
          }
          if (child(el, "key")) changes.key = true;
          for (const c of children(el, "clef")) {
            changes.clefs.add(numberOr(c.getAttribute("number"), 1));
            clefs.set(numberOr(c.getAttribute("number"), 1), {
              sign: childText(c, "sign"),
              line: numberOr(childText(c, "line"), childText(c, "sign") === "F" ? 4 : 2),
              octaveChange: numberOr(childText(c, "clef-octave-change"), 0),
            });
          }
        } else if (el.nodeName === "backup") {
          pos -= numberOr(childText(el, "duration"), 0) / divisions;
        } else if (el.nodeName === "forward") {
          pos += numberOr(childText(el, "duration"), 0) / divisions;
        } else if (el.nodeName === "direction") {
          const localStaff = numberOr(childText(el, "staff"), 1);
          for (const type of children(el, "direction-type")) {
            const dyn = child(type, "dynamics");
            const words = child(type, "words");
            const rehearsal = child(type, "rehearsal");
            const value = dyn ? children(dyn)[0]?.nodeName : (rehearsal ?? words)?.textContent.trim();
            if (!value) continue;
            const kind = dyn ? "dynamics" : rehearsal ? "rehearsal" : "words";
            directions.push({
              index: directions.length, el, part: p, measure: mi, start: pos,
              staff: staffOffset + localStaff - 1, localStaff, kind, value,
            });
            break;
          }
        } else if (el.nodeName === "note") {
          const grace = Boolean(child(el, "grace"));
          const chord = Boolean(child(el, "chord"));
          const duration = grace ? 0 : numberOr(childText(el, "duration"), 0) / divisions;
          const start = chord ? lastStart : pos;
          if (!chord) {
            lastStart = pos;
            pos += duration;
          }
          const localStaff = numberOr(childText(el, "staff"), 1);
          const pitchEl = child(el, "pitch");
          notes.push({
            index: notes.length,
            el,
            part: p,
            measure: mi,
            staff: staffOffset + localStaff - 1,
            localStaff,
            clef: clefs.get(localStaff) ?? null,
            voice: childText(el, "voice") || "1",
            start,
            duration,
            divisions,
            grace,
            chord,
            rest: Boolean(child(el, "rest")),
            pitch: pitchEl ? readPitch(pitchEl) : null,
            fifths: keyOf(localStaff),
            dots: children(el, "dot").length,
            type: childText(el, "type"),
          });
        }
        maxPos = Math.max(maxPos, pos);
      }
      const measure = {
        part: p,
        index: mi,
        number: m.getAttribute("number") || String(mi + 1),
        el: m,
        implicit: m.getAttribute("implicit") === "yes",
        time,
        expected: time ? time.quarters : null,
        actual: maxPos,
        status: "ok",
        divisions,
        staves,
        fifths: keyOf(1),
        clefs: new Map(clefs),
        before, // armure, clés et chiffrage en vigueur avant la mesure
        changes, // ce que la mesure change elle-même
      };
      partMeasures.push(measure);
      measures.push(measure);
    });

    // Une mesure incomplète au début (levée) et à la fin est normale.
    const first = partMeasures[0];
    const pickup = first && first.expected != null && first.actual < first.expected - EPS;
    partMeasures.forEach((m, i) => {
      if (m.expected == null || m.implicit) return;
      if (m.actual > m.expected + EPS) m.status = "long";
      else if (m.actual < m.expected - EPS) {
        const allowed = i === 0 || (pickup && i === partMeasures.length - 1);
        if (!allowed) m.status = "short";
      }
    });
    staffOffset += staves;
  });

  return { notes, measures, directions, partCount: parts.length, staffOffsets };
}

// Suite des « événements » (note seule, accord ou silence) d'une voix, dans l'ordre.
function voiceEvents(analysis, i) {
  const n = analysis.notes[i];
  const events = [];
  let eventOfNote = -1;
  for (const x of analysis.notes) {
    if (x.part !== n.part || x.staff !== n.staff || x.voice !== n.voice || x.grace) continue;
    if (x.chord && events.length) events[events.length - 1].notes.push(x);
    else events.push({ notes: [x] });
    if (x.index === i) eventOfNote = events.length - 1;
  }
  return { events, event: eventOfNote };
}

function chordOf(analysis, i) {
  const n = analysis.notes[i];
  if (n.grace) return [n];
  const { events, event } = voiceEvents(analysis, i);
  return event >= 0 ? events[event].notes : [n];
}

// Altération en vigueur pour un degré à cet endroit (armure puis altérations de la mesure).
export function contextAlter(analysis, i, step, octave) {
  const n = analysis.notes[i];
  return alterAt(analysis, { part: n.part, measure: n.measure, staff: n.staff, fifths: n.fifths, before: i }, step, octave);
}

/** Même chose pour un endroit quelconque : avant la note de rang `before` de la mesure. */
export function alterAt(analysis, { part, measure, staff, fifths, before }, step, octave) {
  let alter = null;
  for (const x of analysis.notes) {
    if (x.index >= before) break;
    if (x.part === part && x.measure === measure && x.staff === staff && x.pitch &&
        x.pitch.step === step && x.pitch.octave === octave) {
      alter = x.pitch.alter;
    }
  }
  return alter ?? keyAlter(fifths, step);
}

const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
function keyAlter(fifths, step) {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

// ---------------------------------------------------------------------------
// Liaisons
// ---------------------------------------------------------------------------

function hasTie(note, type) {
  return children(note, "tie").some((t) => t.getAttribute("type") === type);
}

function notationsOf(note, create = false) {
  let n = child(note, "notations");
  if (!n && create) n = insertOrdered(note, note.ownerDocument.createElement("notations"), NOTE_ORDER);
  return n;
}

function dropEmptyNotations(note) {
  const n = child(note, "notations");
  if (n && !children(n).length) note.removeChild(n);
}

function addTie(note, type) {
  if (hasTie(note, type)) return;
  const doc = note.ownerDocument;
  insertOrdered(note, makeElement(doc, "tie", null, { type }), NOTE_ORDER);
  notationsOf(note, true).appendChild(makeElement(doc, "tied", null, { type }));
}

function removeTie(note, type) {
  for (const t of children(note, "tie")) if (t.getAttribute("type") === type) note.removeChild(t);
  const notations = child(note, "notations");
  if (notations) {
    for (const t of children(notations, "tied")) if (t.getAttribute("type") === type) notations.removeChild(t);
    dropEmptyNotations(note);
  }
}

const samePitch = (a, b) => a.pitch && b.pitch && pitchMidi(a.pitch) === pitchMidi(b.pitch);

// Supprime les liaisons de prolongation qui ne relient plus deux notes de même hauteur.
function repairTies(events, around) {
  for (const k of around) {
    const ev = events[k];
    if (!ev) continue;
    for (const x of ev.notes) {
      if (hasTie(x.el, "start") && !(events[k + 1]?.notes.some((y) => samePitch(x, y)))) removeTie(x.el, "start");
      if (hasTie(x.el, "stop") && !(events[k - 1]?.notes.some((y) => samePitch(x, y)))) removeTie(x.el, "stop");
    }
  }
}

// Liaisons d'expression d'une voix : [{start, stop}] en indices d'événements.
function readSlurs(events) {
  const spans = [];
  const open = new Map();
  events.forEach((ev, k) => {
    for (const x of ev.notes) {
      const notations = child(x.el, "notations");
      if (!notations) continue;
      for (const s of children(notations, "slur")) {
        const number = s.getAttribute("number") || "1";
        const type = s.getAttribute("type");
        if (type === "start") open.set(number, k);
        else if (type === "stop" && open.has(number)) {
          if (open.get(number) < k) spans.push({ start: open.get(number), stop: k });
          open.delete(number);
        }
      }
    }
  });
  return spans;
}

function writeSlurs(events, spans) {
  const doc = events[0]?.notes[0].el.ownerDocument;
  for (const ev of events) {
    for (const x of ev.notes) {
      const notations = child(x.el, "notations");
      if (!notations) continue;
      removeAll(notations, "slur");
      dropEmptyNotations(x.el);
    }
  }
  const sorted = spans.filter((s) => s.start < s.stop).sort((a, b) => a.start - b.start || a.stop - b.stop);
  const placed = [];
  for (const s of sorted) {
    const used = new Set(placed.filter((o) => o.stop >= s.start).map((o) => o.number));
    let number = 1;
    while (used.has(number)) number++;
    placed.push({ ...s, number });
    notationsOf(events[s.start].notes[0].el, true)
      .appendChild(makeElement(doc, "slur", null, { type: "start", number }));
    notationsOf(events[s.stop].notes[0].el, true)
      .appendChild(makeElement(doc, "slur", null, { type: "stop", number }));
  }
}

/** Liaisons de la note avec ses voisines : { left, right } = "tie" | "slur" | null. */
export function linkState(analysis, i) {
  const n = analysis.notes[i];
  const state = { left: null, right: null };
  if (!n || n.grace || !n.pitch) return state;
  const { events, event } = voiceEvents(analysis, i);
  const spans = readSlurs(events);
  const side = (a, b) => {
    if (!events[a] || !events[b]) return null;
    const first = a === event ? n : events[a].notes.find((y) => samePitch(n, y));
    const second = b === event ? n : events[b].notes.find((y) => samePitch(n, y));
    if (first && second && hasTie(first.el, "start") && hasTie(second.el, "stop")) return "tie";
    return spans.some((s) => s.start <= a && s.stop >= b) ? "slur" : null;
  };
  state.left = side(event - 1, event);
  state.right = side(event, event + 1);
  return state;
}

/**
 * Lie ou délie la note à sa voisine (à gauche ou à droite).
 * Même hauteur : liaison de prolongation ; sinon liaison d'expression, qui
 * s'étend si la voisine est déjà liée plus loin.
 */
export function toggleLink(doc, i, direction) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n || n.grace) return { error: "Choisissez une note." };
  if (!n.pitch) return { error: "Un silence ne peut pas être lié." };
  const { events, event } = voiceEvents(analysis, i);
  const other = direction === "left" ? event - 1 : event + 1;
  if (!events[other]) return { error: `Pas de note à ${direction === "left" ? "gauche" : "droite"} dans cette voix.` };
  if (events[other].notes.some((y) => y.rest)) return { error: "Impossible de lier la note à un silence." };
  const [a, b] = other < event ? [other, event] : [event, other];

  const partner = events[other].notes.find((y) => samePitch(n, y));
  if (partner) {
    const [first, second] = other < event ? [partner, n] : [n, partner];
    if (hasTie(first.el, "start") && hasTie(second.el, "stop")) {
      removeTie(first.el, "start");
      removeTie(second.el, "stop");
    } else {
      addTie(first.el, "start");
      addTie(second.el, "stop");
    }
    return {};
  }

  let spans = readSlurs(events);
  if (spans.some((s) => s.start <= a && s.stop >= b)) {
    spans = spans.flatMap((s) => (s.start <= a && s.stop >= b
      ? [{ start: s.start, stop: a }, { start: b, stop: s.stop }]
      : [s]));
  } else {
    const before = spans.find((s) => s.stop === a);
    const after = spans.find((s) => s.start === b);
    if (before && after) {
      before.stop = after.stop;
      spans = spans.filter((s) => s !== after);
    } else if (before) before.stop = b;
    else if (after) after.start = a;
    else spans.push({ start: a, stop: b });
  }
  writeSlurs(events, spans);
  return {};
}

// ---------------------------------------------------------------------------
// Durées
// ---------------------------------------------------------------------------

const dotFactor = (dots) => 2 - 1 / 2 ** dots;

/** Valeur (type + points) correspondant à une durée en noires, ou null. */
export function typeFromQuarters(quarters) {
  for (const [type, value] of Object.entries(NOTE_TYPES)) {
    for (let dots = 0; dots <= 2; dots++) {
      if (Math.abs(value * dotFactor(dots) - quarters) < EPS) return { type, dots };
    }
  }
  return null;
}

// Multiplie toutes les durées (et les <divisions>) d'une partie.
function rescalePart(part, factor) {
  for (const d of part.getElementsByTagName("divisions")) setText(d, numberOr(d.textContent, 1) * factor);
  for (const d of part.getElementsByTagName("duration")) setText(d, Math.round(numberOr(d.textContent, 0) * factor));
}

function partOf(note) {
  let el = note;
  while (el && el.nodeName !== "part") el = el.parentNode;
  return el;
}

// Nombre de divisions (entier) pour une durée donnée, en affinant la partie si besoin.
function durationUnits(inPart, divisions, quarters) {
  let units = quarters * divisions;
  if (Math.abs(units - Math.round(units)) < EPS) return Math.round(units);
  for (let k = 2; k <= 96; k++) {
    if (Math.abs(units * k - Math.round(units * k)) < EPS) {
      rescalePart(partOf(inPart), k);
      return Math.round(units * k);
    }
  }
  return Math.max(1, Math.round(units));
}

// Les ligatures de la voix dans la mesure ne sont plus valables : OSMD dessinera des crochets.
function removeBeams(analysis, n) {
  for (const x of analysis.notes) {
    if (x.part === n.part && x.measure === n.measure && x.staff === n.staff && x.voice === n.voice) {
      removeAll(x.el, "beam");
    }
  }
}

/** Change la valeur de la note (et de tout son accord) : type MusicXML + points. */
export function setDuration(doc, i, type, dots = 0) {
  if (!(type in NOTE_TYPES)) return { error: `Valeur inconnue : ${type}` };
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  const group = chordOf(analysis, i);
  let quarters = NOTE_TYPES[type] * dotFactor(dots);
  const tm = child(n.el, "time-modification");
  if (tm) {
    quarters *= numberOr(childText(tm, "normal-notes"), 1) / numberOr(childText(tm, "actual-notes"), 1);
  }
  const units = n.grace ? null : durationUnits(n.el, n.divisions, quarters);
  const doc_ = n.el.ownerDocument;
  for (const x of group) {
    const note = x.el;
    const rest = child(note, "rest");
    if (rest) rest.removeAttribute("measure");
    if (units != null) {
      const d = child(note, "duration") || insertOrdered(note, doc_.createElement("duration"), NOTE_ORDER);
      setText(d, units);
    }
    const t = child(note, "type") || insertOrdered(note, doc_.createElement("type"), NOTE_ORDER);
    setText(t, type);
    removeAll(note, "dot");
    for (let k = 0; k < dots; k++) insertOrdered(note, doc_.createElement("dot"), NOTE_ORDER);
  }
  removeBeams(analysis, n);
  return {};
}

/** Ajoute ou enlève le point. */
export function toggleDot(doc, i) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  let { type, dots } = n;
  if (!type) {
    const found = typeFromQuarters(n.duration);
    if (!found) return { error: "Valeur de note inconnue : choisissez d'abord une durée." };
    ({ type, dots } = found);
  }
  return setDuration(doc, i, type, dots ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Hauteur, suppression, duplication
// ---------------------------------------------------------------------------

/** Change la hauteur écrite (un silence devient une note). */
export function setPitch(doc, i, pitch) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  if (n.rest) {
    const rest = child(n.el, "rest");
    const full = rest?.getAttribute("measure") === "yes";
    writePitch(n.el, pitch);
    if (!child(n.el, "type") || full) {
      const found = typeFromQuarters(n.duration);
      if (found) {
        const t = child(n.el, "type") || insertOrdered(n.el, doc.createElement("type"), NOTE_ORDER);
        setText(t, found.type);
        removeAll(n.el, "dot");
        for (let k = 0; k < found.dots; k++) insertOrdered(n.el, doc.createElement("dot"), NOTE_ORDER);
      }
    }
    return {};
  }
  writePitch(n.el, pitch);
  const after = analyzeScore(doc);
  const { events, event } = voiceEvents(after, i);
  if (event >= 0) repairTies(events, [event - 1, event, event + 1]);
  return {};
}

/**
 * Supprime : une note d'accord disparaît, une note seule devient un silence
 * de même durée, un silence est retiré (la mesure raccourcit).
 */
export function deleteNote(doc, i) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  if (n.grace) {
    n.el.parentNode.removeChild(n.el);
    return { select: Math.min(i, analysis.notes.length - 2) };
  }
  const { events, event } = voiceEvents(analysis, i);
  const spans = readSlurs(events);
  const group = events[event].notes;

  // Liaisons de prolongation vers les notes voisines.
  if (hasTie(n.el, "start")) {
    const partner = events[event + 1]?.notes.find((y) => samePitch(n, y));
    if (partner) removeTie(partner.el, "stop");
  }
  if (hasTie(n.el, "stop")) {
    const partner = events[event - 1]?.notes.find((y) => samePitch(n, y));
    if (partner) removeTie(partner.el, "start");
  }

  if (group.length > 1) {
    const rest = group.filter((x) => x !== n);
    if (!n.chord) removeAll(rest[0].el, "chord");
    n.el.parentNode.removeChild(n.el);
    events[event].notes = rest;
    writeSlurs(events, spans);
    return { select: rest[0].index > i ? i : rest[0].index };
  }

  if (n.rest) {
    removeBeams(analysis, n);
    n.el.parentNode.removeChild(n.el);
    return { select: Math.min(i, analysis.notes.length - 2) };
  }

  // Note seule → silence de même durée.
  const note = n.el;
  note.replaceChild(doc.createElement("rest"), child(note, "pitch"));
  for (const name of ["tie", "accidental", "stem", "notehead"]) removeAll(note, name);
  const notations = child(note, "notations");
  if (notations) {
    for (const name of ["tied", "slur"]) removeAll(notations, name);
    dropEmptyNotations(note);
  }
  removeBeams(analysis, n);
  const moved = spans
    .map((s) => ({ start: s.start === event ? event + 1 : s.start, stop: s.stop === event ? event - 1 : s.stop }))
    .filter((s) => s.start < s.stop && !events[s.start].notes[0].rest && !events[s.stop].notes[0].rest);
  events[event].notes = [{ ...n, rest: true, pitch: null }];
  writeSlurs(events, moved);
  return { select: i };
}

/** Recopie la note (ou l'accord) juste après elle, sans liaisons. */
export function duplicateNote(doc, i) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  const group = chordOf(analysis, i);
  const last = group[group.length - 1].el;
  const anchor = last.nextSibling;
  for (const x of group) {
    const copy = x.el.cloneNode(true);
    for (const name of ["tie", "beam"]) removeAll(copy, name);
    const notations = child(copy, "notations");
    if (notations) {
      for (const name of ["tied", "slur"]) removeAll(notations, name);
      dropEmptyNotations(copy);
    }
    last.parentNode.insertBefore(copy, anchor);
  }
  removeBeams(analysis, n);
  return { select: group[group.length - 1].index + 1 };
}

/**
 * Insère une note ou un silence dans une voix.
 *
 * @param {{where:"before"|"after", index:number} | {where:"end", part:number, measure:number, staff:number}} target
 *        avant ou après la note (l'accord) de rang `index`, ou à la fin d'une mesure vide sur cette portée
 * @param {{rest?:boolean, pitch?:object, type?:string, dots?:number}} what
 */
export function insertNote(doc, target, { rest = false, pitch = null, type = "quarter", dots = 0 } = {}) {
  if (!(type in NOTE_TYPES)) return { error: `Valeur inconnue : ${type}` };
  if (!rest && !pitch) return { error: "Hauteur de la note manquante." };
  const analysis = analyzeScore(doc);
  let parent;
  let before;
  let voice;
  let staff;
  let divisions;
  let staves;
  let startAt = null; // « fin » : position (en divisions) à rejoindre avec un <backup>
  let anchor = null;

  if (target.where === "end") {
    const measure = analysis.measures.find((m) => m.part === target.part && m.index === target.measure);
    if (!measure) return { error: "Mesure introuvable." };
    parent = measure.el;
    before = children(parent, "barline").find((b) => b.getAttribute("location") !== "left") ?? null;
    staff = target.staff ?? 1;
    voice = String(target.voice ?? (staff > 1 ? (staff - 1) * 4 + 1 : 1));
    divisions = measure.divisions;
    staves = measure.staves;
    if (analysis.notes.some((n) => n.part === measure.part && n.measure === measure.index)) startAt = measure.actual;
  } else {
    const n = analysis.notes[target.index];
    if (!n) return { error: "Choisissez un emplacement." };
    anchor = n;
    const group = chordOf(analysis, target.index);
    const ref = target.where === "before" ? group[0].el : group[group.length - 1].el;
    parent = ref.parentNode;
    before = target.where === "before" ? ref : ref.nextSibling;
    voice = n.voice;
    staff = n.localStaff;
    divisions = n.divisions;
    staves = analysis.measures.find((m) => m.part === n.part && m.index === n.measure)?.staves ?? 1;
  }

  const units = durationUnits(parent, divisions, NOTE_TYPES[type] * dotFactor(dots));
  if (startAt != null) {
    // Mesure déjà remplie sur une autre portée : on revient au début de la mesure
    // (en divisions actuelles, la partie ayant pu être affinée juste avant).
    const backup = doc.createElement("backup");
    backup.appendChild(makeElement(doc, "duration", Math.round(startAt * currentDivisions(parent, divisions))));
    parent.insertBefore(backup, before);
  }

  const note = doc.createElement("note");
  if (rest) note.appendChild(doc.createElement("rest"));
  else note.appendChild(doc.createElement("pitch"));
  note.appendChild(makeElement(doc, "duration", units));
  note.appendChild(makeElement(doc, "voice", voice));
  note.appendChild(makeElement(doc, "type", type));
  for (let k = 0; k < dots; k++) note.appendChild(doc.createElement("dot"));
  if (staves > 1 || staff > 1) note.appendChild(makeElement(doc, "staff", staff));
  parent.insertBefore(note, before);
  if (!rest) writePitch(note, pitch);

  // La voix s'allonge : le <backup> qui la termine doit revenir d'autant plus loin.
  if (startAt == null) {
    for (let el = note.nextSibling; el; el = el.nextSibling) {
      if (el.nodeName === "backup") {
        const d = child(el, "duration");
        if (d) setText(d, numberOr(d.textContent, 0) + units);
        break;
      }
    }
  }
  if (anchor) removeBeams(analysis, anchor);
  const after = analyzeScore(doc);
  return { select: after.notes.findIndex((x) => x.el === note) };
}

// <divisions> en vigueur à la fin d'une mesure (après un éventuel affinage de la partie).
function currentDivisions(measure, fallback) {
  let divisions = fallback;
  for (const m of children(measure.parentNode, "measure")) {
    for (const a of children(m, "attributes")) divisions = numberOr(childText(a, "divisions"), divisions);
    if (m === measure) break;
  }
  return divisions;
}

// ---------------------------------------------------------------------------
// Mesures
// ---------------------------------------------------------------------------

function renumberMeasures(doc) {
  for (const part of children(doc.documentElement, "part")) {
    const measures = children(part, "measure");
    let number = measures[0]?.getAttribute("implicit") === "yes" ? 0 : 1;
    for (const m of measures) m.setAttribute("number", String(number++));
  }
}

function singleVoiceMeasure(measure) {
  return !children(measure, "backup").length;
}

/** Coupe la mesure après la note (nouvelle barre de mesure). */
export function splitMeasureAfter(doc, i) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  if (analysis.partCount > 1) return { error: "Couper une mesure n'est possible que pour une partition à une seule partie." };
  const measure = analysis.measures.find((m) => m.part === n.part && m.index === n.measure);
  if (!singleVoiceMeasure(measure.el)) return { error: "Cette mesure contient plusieurs voix : impossible de la couper ici." };
  const cut = n.start + n.duration;
  if (cut >= measure.actual - EPS) return { error: "La note est déjà en fin de mesure." };

  const m = measure.el;
  const next = doc.createElement("measure");
  m.parentNode.insertBefore(next, m.nextSibling);
  let pos = 0;
  let lastStart = 0;
  let divisions = n.divisions;
  for (const el of children(m)) {
    let after = pos >= cut - EPS;
    if (el.nodeName === "attributes") divisions = numberOr(childText(el, "divisions"), divisions);
    if (el.nodeName === "note") {
      const d = child(el, "grace") ? 0 : numberOr(childText(el, "duration"), 0) / divisions;
      const start = child(el, "chord") ? lastStart : pos;
      if (!child(el, "chord")) {
        lastStart = pos;
        pos += d;
      }
      after = start >= cut - EPS;
    } else if (el.nodeName === "forward") {
      pos += numberOr(childText(el, "duration"), 0) / divisions;
    } else if (el.nodeName === "barline") {
      after = el.getAttribute("location") !== "left";
    } else if (el.nodeName === "print") {
      after = false;
    }
    if (after) next.appendChild(el);
  }
  removeBeams(analysis, n);
  renumberMeasures(doc);
  return { select: i };
}

/** Supprime la barre de mesure entre cette mesure et la suivante. */
export function mergeWithNextMeasure(doc, i) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  if (analysis.partCount > 1) return { error: "Fusionner des mesures n'est possible que pour une partition à une seule partie." };
  const m = analysis.measures.find((x) => x.part === n.part && x.index === n.measure).el;
  const next = children(m.parentNode, "measure")[n.measure + 1];
  if (!next) return { error: "C'est la dernière mesure." };
  if (!singleVoiceMeasure(m) || !singleVoiceMeasure(next)) {
    return { error: "Une des mesures contient plusieurs voix : impossible de les fusionner." };
  }
  const isRepeat = (b) => child(b, "repeat") || child(b, "ending");
  const right = children(m, "barline").filter((b) => b.getAttribute("location") !== "left");
  const left = children(next, "barline").filter((b) => b.getAttribute("location") === "left");
  if ([...right, ...left].some(isRepeat)) return { error: "Il y a une reprise entre ces mesures : impossible de les fusionner." };
  for (const b of [...right, ...left]) b.parentNode.removeChild(b);
  for (const el of children(next)) {
    if (el.nodeName !== "print") m.appendChild(el);
  }
  next.parentNode.removeChild(next);
  renumberMeasures(doc);
  return { select: i };
}

// Attributs du début de la mesure (créés si besoin, avant tout contenu).
function startAttributes(measure) {
  const doc = measure.ownerDocument;
  const first = children(measure).find((el) => el.nodeName !== "print" &&
    !(el.nodeName === "barline" && el.getAttribute("location") === "left"));
  if (first?.nodeName === "attributes") return first;
  const attributes = doc.createElement("attributes");
  measure.insertBefore(attributes, first ?? null);
  return attributes;
}

function dropEmptyAttributes(measure) {
  for (const a of children(measure, "attributes")) if (!children(a).length) measure.removeChild(a);
}

const sameTime = (a, b) => (a && b ? a.beats === b.beats && a.beatType === b.beatType : a === b);

/** Chiffrage de mesure à partir de la mesure de la note (toutes les parties). */
export function setTimeSignature(doc, i, beats, beatType) {
  const analysis = analyzeScore(doc);
  const n = analysis.notes[i];
  if (!n) return { error: "Choisissez une note." };
  setTimeAt(doc, n.measure, beats, beatType);
  return { select: i };
}

/** Chiffrage à partir d'une mesure (toutes les parties) ; retiré s'il ne change rien. */
export function setTimeAt(doc, measureIndex, beats, beatType) {
  const analysis = analyzeScore(doc);
  for (const part of children(doc.documentElement, "part")) {
    const m = children(part, "measure")[measureIndex];
    if (!m) continue;
    const info = analysis.measures.find((x) => x.el === m);
    const attributes = startAttributes(m);
    removeAll(attributes, "time");
    const wanted = { beats, beatType };
    if (measureIndex === 0 || !sameTime(info?.before.time, wanted)) {
      const time = doc.createElement("time");
      time.appendChild(makeElement(doc, "beats", beats));
      time.appendChild(makeElement(doc, "beat-type", beatType));
      insertOrdered(attributes, time, ATTRIBUTES_ORDER);
    }
    dropEmptyAttributes(m);
  }
  return {};
}

/**
 * Armure à partir d'une mesure (d'une partie), jusqu'au prochain changement d'armure.
 * `applyToNotes` : les notes qui suivaient l'ancienne armure suivent la nouvelle
 * (les notes avec une altération écrite, et celles qui en dépendent dans la mesure, ne bougent pas).
 */
export function setKeyAt(doc, part, measureIndex, fifths, { applyToNotes = true } = {}) {
  const analysis = analyzeScore(doc);
  const info = analysis.measures.find((m) => m.part === part && m.index === measureIndex);
  if (!info) return { error: "Mesure introuvable." };
  const oldFifths = info.fifths;
  const attributes = startAttributes(info.el);
  removeAll(attributes, "key");
  if (measureIndex === 0 || info.before.fifths !== fifths) {
    const key = doc.createElement("key");
    key.appendChild(makeElement(doc, "fifths", fifths));
    insertOrdered(attributes, key, ATTRIBUTES_ORDER);
  }
  dropEmptyAttributes(info.el);

  if (applyToNotes && oldFifths !== fifths) {
    const later = analysis.measures.find((m) => m.part === part && m.index > measureIndex && m.changes.key);
    const end = later ? later.index : Infinity;
    const written = new Set(); // degrés altérés explicitement dans la mesure en cours
    let currentMeasure = -1;
    for (const n of analysis.notes) {
      if (n.part !== part || n.measure < measureIndex || n.measure >= end || !n.pitch) continue;
      if (n.measure !== currentMeasure) {
        currentMeasure = n.measure;
        written.clear();
      }
      const slot = `${n.staff}|${n.pitch.step}${n.pitch.octave}`;
      if (child(n.el, "accidental")) {
        written.add(slot);
        continue;
      }
      if (written.has(slot) || n.pitch.alter !== keyAlter(oldFifths, n.pitch.step)) continue;
      const pitchEl = child(n.el, "pitch");
      const alter = keyAlter(fifths, n.pitch.step);
      removeAll(pitchEl, "alter");
      if (alter) pitchEl.insertBefore(makeElement(doc, "alter", alter), child(pitchEl, "octave"));
    }
  }
  return {};
}

/** Clé d'une portée à partir d'une mesure ; retirée si elle ne change rien. */
export function setClefAt(doc, part, measureIndex, localStaff, { sign, line, octaveChange = 0 }) {
  const analysis = analyzeScore(doc);
  const info = analysis.measures.find((m) => m.part === part && m.index === measureIndex);
  if (!info) return { error: "Mesure introuvable." };
  const attributes = startAttributes(info.el);
  for (const c of children(attributes, "clef")) {
    if (numberOr(c.getAttribute("number"), 1) === localStaff) attributes.removeChild(c);
  }
  const previous = info.before.clefs.get(localStaff);
  const same = previous && previous.sign === sign && previous.line === line && (previous.octaveChange || 0) === octaveChange;
  if (measureIndex === 0 || !same) {
    const clef = doc.createElement("clef");
    if (info.staves > 1) clef.setAttribute("number", String(localStaff));
    clef.appendChild(makeElement(doc, "sign", sign));
    clef.appendChild(makeElement(doc, "line", line));
    if (octaveChange) clef.appendChild(makeElement(doc, "clef-octave-change", octaveChange));
    insertOrdered(attributes, clef, ATTRIBUTES_ORDER);
  }
  dropEmptyAttributes(info.el);
  return {};
}

// ---------------------------------------------------------------------------
// Nuances et indications
// ---------------------------------------------------------------------------

export const DYNAMICS = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sfz", "fp"];

/** Indications (nuances, textes) placées au même instant d'une mesure. */
export function annotationsAt(analysis, { part, measure, start }) {
  return analysis.directions.filter((d) => d.part === part && d.measure === measure && Math.abs(d.start - start) < EPS);
}

/**
 * Ajoute une nuance ({ dynamics: "mf" }) ou une indication ({ words: "rit." })
 * à un emplacement (même cible que insertNote). Une nuance remplace celle déjà là.
 */
export function addAnnotation(doc, target, { dynamics = null, words = null }) {
  if (!dynamics && !words) return { error: "Indication vide." };
  if (dynamics && !DYNAMICS.includes(dynamics)) return { error: `Nuance inconnue : ${dynamics}` };
  const analysis = analyzeScore(doc);
  let parent;
  let before;
  let staff;
  let staves;
  let part;
  let measureIndex;
  let start;
  if (target.where === "end") {
    const m = analysis.measures.find((x) => x.part === target.part && x.index === target.measure);
    if (!m) return { error: "Mesure introuvable." };
    parent = m.el;
    before = children(parent, "barline").find((b) => b.getAttribute("location") !== "left") ?? null;
    ({ staff = 1 } = target);
    staves = m.staves;
    part = m.part;
    measureIndex = m.index;
    start = analysis.notes.some((x) => x.part === part && x.measure === measureIndex) ? m.actual : 0;
  } else {
    const n = analysis.notes[target.index];
    if (!n) return { error: "Choisissez un emplacement." };
    const group = chordOf(analysis, target.index);
    const ref = target.where === "before" ? group[0].el : group[group.length - 1].el;
    parent = ref.parentNode;
    before = target.where === "before" ? ref : ref.nextSibling;
    staff = n.localStaff;
    staves = analysis.measures.find((m) => m.part === n.part && m.index === n.measure)?.staves ?? 1;
    part = n.part;
    measureIndex = n.measure;
    start = target.where === "before" ? n.start : n.start + n.duration;
  }

  if (dynamics) {
    for (const d of annotationsAt(analysis, { part, measure: measureIndex, start })) {
      if (d.kind === "dynamics" && d.localStaff === staff) d.el.parentNode.removeChild(d.el);
    }
  }
  const below = Boolean(dynamics) || /^(cresc|dim|decresc)/i.test(words ?? "");
  const direction = makeElement(doc, "direction", null, { placement: below ? "below" : "above" });
  const type = doc.createElement("direction-type");
  if (dynamics) {
    const dyn = doc.createElement("dynamics");
    dyn.appendChild(doc.createElement(dynamics));
    type.appendChild(dyn);
  } else {
    type.appendChild(makeElement(doc, "words", words, /^(cresc|dim|decresc|dolce|espr)/i.test(words) ? { "font-style": "italic" } : {}));
  }
  direction.appendChild(type);
  if (staves > 1 || staff > 1) direction.appendChild(makeElement(doc, "staff", staff));
  parent.insertBefore(direction, before);
  return {};
}

/** Repère encadré (A, B, C…) au début d'une mesure, sur la première partie ; null pour le retirer. */
export function setRehearsal(doc, measureIndex, text) {
  const analysis = analyzeScore(doc);
  const info = analysis.measures.find((m) => m.part === 0 && m.index === measureIndex);
  if (!info) return { error: "Mesure introuvable." };
  for (const d of analysis.directions) {
    if (d.kind === "rehearsal" && d.part === 0 && d.measure === measureIndex) d.el.parentNode.removeChild(d.el);
  }
  const value = text?.trim();
  if (!value) return {};
  const direction = makeElement(doc, "direction", null, { placement: "above" });
  const type = doc.createElement("direction-type");
  type.appendChild(makeElement(doc, "rehearsal", value, { enclosure: "square" }));
  direction.appendChild(type);
  // Au tout début de la mesure, après la barre de gauche et les attributs.
  const first = children(info.el).find((el) => !["print", "attributes"].includes(el.nodeName) &&
    !(el.nodeName === "barline" && el.getAttribute("location") === "left"));
  info.el.insertBefore(direction, first ?? null);
  return {};
}

/** Repère proposé pour une mesure : la lettre (ou le nombre) qui suit le repère précédent. */
export function nextRehearsal(analysis, measureIndex) {
  const before = analysis.directions
    .filter((d) => d.kind === "rehearsal" && d.part === 0 && d.measure < measureIndex)
    .sort((a, b) => a.measure - b.measure);
  const last = before[before.length - 1]?.value;
  if (!last) return "A";
  if (/^\d+$/.test(last)) return String(Number(last) + 1);
  if (/^[A-Y]$/i.test(last)) return String.fromCharCode(last.charCodeAt(0) + 1);
  return "A";
}

/** Retire une indication (rang dans analysis.directions). */
export function removeAnnotation(doc, index) {
  const d = analyzeScore(doc).directions[index];
  if (!d) return { error: "Indication introuvable." };
  d.el.parentNode.removeChild(d.el);
  return {};
}

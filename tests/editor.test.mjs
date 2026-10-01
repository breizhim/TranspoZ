import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import {
  analyzeScore,
  setDuration,
  toggleDot,
  setPitch,
  deleteNote,
  duplicateNote,
  toggleLink,
  linkState,
  splitMeasureAfter,
  mergeWithNextMeasure,
  setTimeSignature,
  contextAlter,
  moveStep,
  typeFromQuarters,
  insertNote,
  alterAt,
  setTimeAt,
  setKeyAt,
  setClefAt,
  addAnnotation,
  removeAnnotation,
  annotationsAt,
  setRehearsal,
  nextRehearsal,
} from "../web/editor.js";

const parse = (xml) => new DOMParser().parseFromString(xml, "text/xml");
const serialize = (doc) => new XMLSerializer().serializeToString(doc);

// Partition à une partie, 2/4, divisions = 4 (noire = 4, croche = 2).
function score(measures, { time = "<time><beats>2</beats><beat-type>4</beat-type></time>", divisions = 4, fifths = 0 } = {}) {
  const body = measures
    .map((m, i) => {
      const attrs = i === 0
        ? `<attributes><divisions>${divisions}</divisions><key><fifths>${fifths}</fifths></key>${time}<clef><sign>G</sign><line>2</line></clef></attributes>`
        : "";
      return `<measure number="${i + 1}">${attrs}${m}</measure>`;
    })
    .join("");
  return parse(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`);
}

const TYPES = { 4: "quarter", 2: "eighth", 8: "half", 1: "16th" };
const n = (step, octave, duration = 2, extra = "") =>
  `<note>${extra.includes("<chord/>") ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
  `<duration>${duration}</duration>${extra.replace("<chord/>", "")}<voice>1</voice><type>${TYPES[duration] ?? "quarter"}</type></note>`;
const r = (duration = 2) => `<note><rest/><duration>${duration}</duration><voice>1</voice></note>`;

const summary = (doc) => analyzeScore(doc).notes.map((x) =>
  `${x.measure}:${x.rest ? "r" : `${x.pitch.step}${x.pitch.alter || ""}${x.pitch.octave}`}/${x.duration}`);
const statuses = (doc) => analyzeScore(doc).measures.map((m) => m.status);
const tagCount = (doc, name) => doc.getElementsByTagName(name).length;

// ---------------------------------------------------------------------------

test("mesures incomplètes ou trop longues (levée et fin tolérées)", () => {
  const doc = score([n("C", 5, 2), n("C", 5, 4) + n("D", 5, 4), n("E", 5, 4), n("F", 5, 4) + n("G", 5, 4) + n("A", 5, 2), n("B", 5, 2)]);
  // levée (1 croche), complète, incomplète, trop longue, fin incomplète qui complète la levée
  assert.deepEqual(statuses(doc), ["ok", "ok", "short", "long", "ok"]);
  const noPickup = score([n("C", 5, 4) + n("C", 5, 4), n("E", 5, 4)]);
  assert.deepEqual(statuses(noPickup), ["ok", "short"]);
  assert.deepEqual(statuses(score([n("C", 5, 4)], { time: "" })), ["ok"], "sans chiffrage : pas de vérification");
});

test("durée : noire → croche pointée → croche, accord compris", () => {
  const doc = score([n("C", 5, 4) + n("E", 5, 4, "<chord/>") + n("D", 5, 4)]);
  setDuration(doc, 0, "eighth", 1);
  assert.deepEqual(summary(doc), ["0:C5/0.75", "0:E5/0.75", "0:D5/1"]);
  assert.equal(doc.getElementsByTagName("type")[1].textContent, "eighth");
  assert.equal(tagCount(doc, "dot"), 2);
  toggleDot(doc, 0);
  assert.deepEqual(summary(doc).slice(0, 2), ["0:C5/0.5", "0:E5/0.5"]);
  assert.equal(tagCount(doc, "dot"), 0);
  toggleDot(doc, 2);
  assert.deepEqual(summary(doc)[2], "0:D5/1.5");
});

test("durée plus courte que la division : la partie est affinée", () => {
  const doc = score([n("C", 5, 4) + n("D", 5, 4)]);
  setDuration(doc, 0, "32nd");
  assert.equal(doc.getElementsByTagName("divisions")[0].textContent, "8");
  assert.deepEqual(summary(doc), ["0:C5/0.125", "0:D5/1"]);
});

test("hauteur : degré, altération de l'armure et de la mesure", () => {
  assert.deepEqual(moveStep({ step: "B", octave: 4 }, 1), { step: "C", alter: 0, octave: 5 });
  assert.deepEqual(moveStep({ step: "C", octave: 5 }, -1), { step: "B", alter: 0, octave: 4 });
  const sharp = `<note><pitch><step>C</step><alter>0</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>`;
  const doc = score([sharp + n("F", 5, 2) + n("C", 5, 2)], { fifths: 2 });
  const a = analyzeScore(doc);
  assert.equal(contextAlter(a, 1, "F", 5), 1, "armure");
  assert.equal(contextAlter(a, 2, "C", 5), 0, "bécarre plus tôt dans la mesure");
  setPitch(doc, 1, { step: "G", alter: 1, octave: 5 });
  assert.deepEqual(summary(doc)[1], "0:G15/0.5");
});

test("un silence devient une note", () => {
  const doc = score([r(4) + n("D", 5, 4)]);
  setPitch(doc, 0, { step: "B", alter: 0, octave: 4 });
  assert.deepEqual(summary(doc)[0], "0:B4/1");
  assert.equal(doc.getElementsByTagName("type")[0].textContent, "quarter");
});

test("supprimer : note → silence, silence retiré, note d'accord retirée", () => {
  const doc = score([n("C", 5, 4) + n("E", 5, 4, "<chord/>") + n("D", 5, 4)]);
  deleteNote(doc, 0); // tête d'accord : Mi devient la tête
  assert.deepEqual(summary(doc), ["0:E5/1", "0:D5/1"]);
  assert.equal(tagCount(doc, "chord"), 0);
  deleteNote(doc, 1);
  assert.deepEqual(summary(doc), ["0:E5/1", "0:r/1"]);
  deleteNote(doc, 1);
  assert.deepEqual(summary(doc), ["0:E5/1"]);
  assert.deepEqual(statuses(doc), ["ok"], "première mesure : considérée comme une levée");
});

test("supprimer une note liée retire la liaison de l'autre note", () => {
  const doc = score([n("C", 5, 4, '<tie type="start"/>') + n("C", 5, 4, '<tie type="stop"/>')]);
  deleteNote(doc, 0);
  assert.equal(tagCount(doc, "tie"), 0);
});

test("dupliquer une note", () => {
  const doc = score([n("C", 5, 2, '<tie type="start"/>') + n("C", 5, 2, '<tie type="stop"/>')]);
  const res = duplicateNote(doc, 0);
  assert.equal(res.select, 1);
  assert.deepEqual(summary(doc), ["0:C5/1", "0:C5/1", "0:C5/1"].map((s) => s.replace("/1", "/0.5")));
  assert.equal(tagCount(doc, "tie"), 2, "la copie n'est pas liée");
});

test("liaison de prolongation entre notes de même hauteur (à droite puis à gauche)", () => {
  const doc = score([n("C", 5, 4), n("C", 5, 4)]);
  toggleLink(doc, 0, "right");
  let a = analyzeScore(doc);
  assert.deepEqual(linkState(a, 0), { left: null, right: "tie" });
  assert.deepEqual(linkState(a, 1), { left: "tie", right: null });
  toggleLink(doc, 1, "left");
  assert.equal(tagCount(doc, "tie"), 0);
  assert.equal(tagCount(doc, "tied"), 0);
});

test("liaison d'expression : création, extension, fusion, coupure", () => {
  const doc = score([n("C", 5, 2) + n("D", 5, 2) + n("E", 5, 2) + n("F", 5, 2), n("G", 5, 2) + n("A", 5, 2)]);
  const spans = () => {
    const a = analyzeScore(doc);
    return a.notes.map((_, i) => linkState(a, i).right ? "‿" : "|").join("");
  };
  toggleLink(doc, 0, "right");
  assert.equal(spans(), "‿|||||");
  toggleLink(doc, 1, "right"); // étend la liaison existante
  assert.equal(spans(), "‿‿||||");
  assert.equal(tagCount(doc, "slur"), 2);
  toggleLink(doc, 4, "left"); // nouvelle liaison Fa–Sol (par-dessus la barre)
  toggleLink(doc, 3, "left"); // Mi–Fa : fusionne les deux liaisons
  assert.equal(spans(), "‿‿‿‿||");
  assert.equal(tagCount(doc, "slur"), 2);
  toggleLink(doc, 2, "right"); // coupe entre Mi et Fa
  assert.equal(spans(), "‿‿|‿||");
  assert.equal(tagCount(doc, "slur"), 4);
});

test("impossible de lier à un silence", () => {
  const doc = score([n("C", 5, 4) + r(4)]);
  assert.match(toggleLink(doc, 0, "right").error, /silence/);
  assert.match(toggleLink(doc, 0, "left").error, /gauche/);
});

test("couper et fusionner des mesures", () => {
  const doc = score([n("C", 5, 4) + n("D", 5, 4) + n("E", 5, 4) + n("F", 5, 4) + '<barline location="right"><bar-style>light-heavy</bar-style></barline>']);
  assert.deepEqual(statuses(doc), ["long"]);
  splitMeasureAfter(doc, 1);
  assert.deepEqual(summary(doc), ["0:C5/1", "0:D5/1", "1:E5/1", "1:F5/1"]);
  assert.deepEqual(statuses(doc), ["ok", "ok"]);
  const measures = doc.getElementsByTagName("measure");
  assert.equal(measures[1].getAttribute("number"), "2");
  assert.equal(measures[1].getElementsByTagName("barline").length, 1, "la barre finale suit la fin de la mesure");
  assert.match(splitMeasureAfter(doc, 3).error, /fin de mesure/);
  mergeWithNextMeasure(doc, 0);
  assert.deepEqual(summary(doc), ["0:C5/1", "0:D5/1", "0:E5/1", "0:F5/1"]);
  assert.equal(doc.getElementsByTagName("measure").length, 1);
});

test("fusion refusée à travers une reprise", () => {
  const doc = score([n("C", 5, 8) + '<barline location="right"><repeat direction="backward"/></barline>', n("D", 5, 8)]);
  assert.match(mergeWithNextMeasure(doc, 0).error, /reprise/);
});

test("chiffrage de mesure", () => {
  const doc = score([n("C", 5, 4) + n("D", 5, 4), n("E", 5, 4) + n("F", 5, 4) + n("G", 5, 4)]);
  assert.deepEqual(statuses(doc), ["ok", "long"]);
  setTimeSignature(doc, 2, 3, 4);
  assert.deepEqual(statuses(doc), ["ok", "ok"]);
  const attrs = doc.getElementsByTagName("measure")[1].getElementsByTagName("attributes")[0];
  assert.ok(attrs, "attributs créés dans la mesure 2");
  assert.ok(serialize(doc).indexOf("<beats>3</beats>") > 0);
});

test("typeFromQuarters", () => {
  assert.deepEqual(typeFromQuarters(1.5), { type: "quarter", dots: 1 });
  assert.deepEqual(typeFromQuarters(4), { type: "whole", dots: 0 });
  assert.equal(typeFromQuarters(1 / 3), null);
});

test("insérer une note ou un silence avant / après", () => {
  const doc = score([n("C", 5, 4) + n("E", 5, 4, "<chord/>") + n("D", 5, 4)]);
  let res = insertNote(doc, { where: "before", index: 2 }, { rest: true, type: "eighth" });
  assert.equal(res.select, 2);
  assert.deepEqual(summary(doc), ["0:C5/1", "0:E5/1", "0:r/0.5", "0:D5/1"]);
  res = insertNote(doc, { where: "after", index: 0 }, { pitch: { step: "G", alter: 1, octave: 4 }, type: "quarter", dots: 1 });
  assert.equal(res.select, 2, "après l'accord entier");
  assert.deepEqual(summary(doc), ["0:C5/1", "0:E5/1", "0:G14/1.5", "0:r/0.5", "0:D5/1"]);
  assert.deepEqual(statuses(doc), ["long"]);
  const inserted = analyzeScore(doc).notes[2].el;
  assert.equal(inserted.getElementsByTagName("voice")[0].textContent, "1");
  assert.equal(inserted.getElementsByTagName("dot").length, 1);
});

test("insérer dans une voix suivie d'un <backup> allonge le retour", () => {
  const doc = score([n("E", 5, 4) + n("F", 5, 4) + "<backup><duration>8</duration></backup>" +
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>2</voice><type>half</type></note>']);
  insertNote(doc, { where: "after", index: 1 }, { pitch: { step: "G", alter: 0, octave: 5 }, type: "eighth" });
  assert.equal(doc.getElementsByTagName("backup")[0].getElementsByTagName("duration")[0].textContent, "10");
  const notes = analyzeScore(doc).notes;
  assert.deepEqual(notes.map((x) => x.start), [0, 1, 2, 0], "la voix 2 commence toujours au début de la mesure");
});

test("insérer une triple croche affine la partie ; mesure vide", () => {
  const doc = score([n("C", 5, 4) + n("D", 5, 4), ""]);
  insertNote(doc, { where: "before", index: 1 }, { rest: true, type: "32nd" });
  assert.equal(doc.getElementsByTagName("divisions")[0].textContent, "8");
  assert.deepEqual(summary(doc), ["0:C5/1", "0:r/0.125", "0:D5/1"]);
  const res = insertNote(doc, { where: "end", part: 0, measure: 1, staff: 1 }, { pitch: { step: "A", alter: 0, octave: 4 }, type: "half" });
  assert.deepEqual(summary(doc)[res.select], "1:A4/2");
});

test("altération en vigueur à un endroit quelconque", () => {
  const sharp = `<note><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>4</duration><voice>1</voice></note>`;
  const a = analyzeScore(score([sharp + n("C", 5, 4)]));
  assert.equal(alterAt(a, { part: 0, measure: 0, staff: 0, fifths: 0, before: 2 }, "F", 5), 1);
  assert.equal(alterAt(a, { part: 0, measure: 0, staff: 0, fifths: 0, before: 0 }, "F", 5), 0);
  assert.equal(alterAt(a, { part: 0, measure: 0, staff: 0, fifths: -1, before: 0 }, "B", 4), -1);
});

test("clé connue pour chaque note", () => {
  const a = analyzeScore(score([n("C", 5, 4)]));
  assert.deepEqual(a.notes[0].clef, { sign: "G", line: 2, octaveChange: 0 });
  assert.deepEqual(a.measures[0].clefs.get(1), { sign: "G", line: 2, octaveChange: 0 });
});

test("armure : les notes qui la suivaient changent, pas celles avec une altération écrite", () => {
  const bNat = `<note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><accidental>natural</accidental></note>`;
  const doc = score([n("B", 4, 4) + n("E", 5, 4), bNat + n("B", 4, 4), n("B", 4, 4) + n("A", 4, 4)]);
  setKeyAt(doc, 0, 1, -2);
  // mesure 1 : rien ; mesure 2 : Si bécarre écrit, le Si suivant en dépend ; mesure 3 : Si → Si♭
  assert.deepEqual(summary(doc), ["0:B4/1", "0:E5/1", "1:B4/1", "1:B4/1", "2:B-14/1", "2:A4/1"]);
  const a = analyzeScore(doc);
  assert.equal(a.measures[1].fifths, -2);
  assert.equal(a.measures[0].fifths, 0);
  setKeyAt(doc, 0, 1, 0, { applyToNotes: false });
  assert.equal(doc.getElementsByTagName("key").length, 1, "changement retiré : même armure qu'avant");
  assert.deepEqual(summary(doc)[4], "2:B-14/1", "notes inchangées");
});

test("chiffrage et clé à partir d'une mesure", () => {
  const doc = score([n("C", 5, 4) + n("D", 5, 4), n("E", 5, 4) + n("F", 5, 4) + n("G", 5, 4)]);
  setTimeAt(doc, 1, 3, 4);
  assert.deepEqual(statuses(doc), ["ok", "ok"]);
  setTimeAt(doc, 1, 2, 4);
  assert.equal(doc.getElementsByTagName("time").length, 1, "retour au chiffrage précédent : changement retiré");
  setClefAt(doc, 0, 1, 1, { sign: "F", line: 4 });
  const a = analyzeScore(doc);
  assert.deepEqual(a.measures[1].clefs.get(1), { sign: "F", line: 4, octaveChange: 0 });
  assert.equal(a.notes[2].clef.sign, "F");
  setClefAt(doc, 0, 0, 1, { sign: "G", line: 2, octaveChange: -1 });
  assert.equal(analyzeScore(doc).notes[0].clef.octaveChange, -1);
});

test("nuances et indications", () => {
  const doc = score([n("C", 5, 4) + n("D", 5, 4)]);
  addAnnotation(doc, { where: "before", index: 1 }, { dynamics: "mf" });
  addAnnotation(doc, { where: "before", index: 1 }, { words: "cresc." });
  let a = analyzeScore(doc);
  assert.deepEqual(annotationsAt(a, { part: 0, measure: 0, start: 1 }).map((d) => d.value), ["mf", "cresc."]);
  assert.equal(a.directions[1].el.getAttribute("placement"), "below");
  addAnnotation(doc, { where: "before", index: 1 }, { dynamics: "ff" }); // remplace mf
  a = analyzeScore(doc);
  assert.deepEqual(a.directions.map((d) => d.value).sort(), ["cresc.", "ff"]);
  assert.equal(a.notes[1].start, 1, "la note ne bouge pas");
  removeAnnotation(doc, a.directions.find((d) => d.value === "cresc.").index);
  assert.deepEqual(analyzeScore(doc).directions.map((d) => d.value), ["ff"]);
  addAnnotation(doc, { where: "after", index: 1 }, { words: "rit." });
  const rit = analyzeScore(doc).directions.find((d) => d.value === "rit.");
  assert.equal(rit.start, 2);
  assert.equal(rit.el.getAttribute("placement"), "above");
});

test("repères encadrés (A, B…) au début des mesures", () => {
  const doc = score([n("C", 5, 8), n("D", 5, 8), n("E", 5, 8), n("F", 5, 8)]);
  assert.equal(nextRehearsal(analyzeScore(doc), 1), "A");
  setRehearsal(doc, 1, "A");
  let a = analyzeScore(doc);
  const mark = a.directions.find((d) => d.kind === "rehearsal");
  assert.deepEqual([mark.measure, mark.start, mark.value], [1, 0, "A"]);
  assert.equal(mark.el.getElementsByTagName("rehearsal")[0].getAttribute("enclosure"), "square");
  assert.equal(nextRehearsal(a, 3), "B");
  assert.equal(nextRehearsal(a, 1), "A", "pas de repère avant la mesure 2");
  setRehearsal(doc, 1, "Intro"); // remplace
  a = analyzeScore(doc);
  assert.deepEqual(a.directions.map((d) => d.value), ["Intro"]);
  assert.equal(nextRehearsal(a, 2), "A");
  setRehearsal(doc, 1, "12");
  assert.equal(nextRehearsal(analyzeScore(doc), 2), "13");
  setRehearsal(doc, 1, null);
  assert.equal(analyzeScore(doc).directions.length, 0);
  assert.deepEqual(summary(doc), ["0:C5/2", "1:D5/2", "2:E5/2", "3:F5/2"]);
  // Placé après les attributs d'une mesure qui en a.
  setRehearsal(doc, 0, "A");
  const first = doc.getElementsByTagName("measure")[0];
  const names = [];
  for (let c = first.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) names.push(c.nodeName);
  assert.deepEqual(names.slice(0, 3), ["attributes", "direction", "note"]);
});

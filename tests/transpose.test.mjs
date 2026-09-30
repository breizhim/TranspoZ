import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import {
  transposePitch,
  intervalFromSemitones,
  resolveInterval,
  transposeScore,
  keyName,
  scoreTitle,
} from "../web/transpose.js";
import { findInstrument, instrumentInterval, semitoneLabel } from "../web/instruments.js";

const parse = (xml) => new DOMParser().parseFromString(xml, "text/xml");
const serialize = (doc) => new XMLSerializer().serializeToString(doc);

function score(measures, { fifths = 0, mode = "major", extraAttributes = "" } = {}) {
  const body = measures
    .map((notes, i) => {
      const attrs = i === 0
        ? `<attributes><divisions>1</divisions><key><fifths>${fifths}</fifths><mode>${mode}</mode></key>` +
          `<clef><sign>G</sign><line>2</line></clef>${extraAttributes}</attributes>`
        : "";
      return `<measure number="${i + 1}">${attrs}${notes}</measure>`;
    })
    .join("");
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flûte</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
}

const note = (step, octave, alter = 0, extra = "") =>
  `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>` +
  `<duration>1</duration><type>quarter</type>${extra}</note>`;

function notesOf(doc) {
  return [...doc.getElementsByTagName("note")].map((n) => {
    const get = (name) => n.getElementsByTagName(name)[0]?.textContent ?? null;
    const alter = Number(get("alter") ?? 0);
    const sign = alter > 0 ? "#".repeat(alter) : "b".repeat(-alter);
    return { name: `${get("step")}${sign}${get("octave")}`, accidental: get("accidental") };
  });
}

const fifthsOf = (doc) => [...doc.getElementsByTagName("fifths")].map((f) => Number(f.textContent));

test("transposePitch conserve l'orthographe des intervalles", () => {
  assert.deepEqual(transposePitch({ step: "C", alter: 0, octave: 4 }, { diatonic: 1, chromatic: 2 }), { step: "D", alter: 0, octave: 4 });
  assert.deepEqual(transposePitch({ step: "B", alter: 0, octave: 4 }, { diatonic: 1, chromatic: 1 }), { step: "C", alter: 0, octave: 5 });
  assert.deepEqual(transposePitch({ step: "E", alter: 0, octave: 4 }, { diatonic: 1, chromatic: 2 }), { step: "F", alter: 1, octave: 4 });
  assert.deepEqual(transposePitch({ step: "C", alter: 0, octave: 4 }, { diatonic: -1, chromatic: -2 }), { step: "B", alter: -1, octave: 3 });
  // Pas de triple dièse : réorthographié.
  assert.deepEqual(transposePitch({ step: "F", alter: 2, octave: 4 }, { diatonic: 0, chromatic: 1 }), { step: "G", alter: 1, octave: 4 });
});

test("intervalFromSemitones", () => {
  assert.deepEqual(intervalFromSemitones(2), { diatonic: 1, chromatic: 2 });
  assert.deepEqual(intervalFromSemitones(-3), { diatonic: -2, chromatic: -3 });
  assert.deepEqual(intervalFromSemitones(12), { diatonic: 7, chromatic: 12 });
  assert.deepEqual(intervalFromSemitones(-14), { diatonic: -8, chromatic: -14 });
});

test("resolveInterval choisit une armure lisible", () => {
  // Do majeur + 1 demi-ton → Ré♭ (5♭) plutôt que Do♯ (7♯).
  assert.deepEqual(resolveInterval(intervalFromSemitones(1), 0), { diatonic: 1, chromatic: 1 });
  // Ré♭ majeur + 1 demi-ton → Ré (2♯), pas Mi♭♭.
  assert.deepEqual(resolveInterval(intervalFromSemitones(1), -5), { diatonic: 0, chromatic: 1 });
  // Préférence dièses : Fa majeur + 1 demi-ton → Fa♯ (6♯) plutôt que Sol♭.
  assert.deepEqual(resolveInterval({ diatonic: 1, chromatic: 1 }, -1, "sharps"), { diatonic: 0, chromatic: 1 });
  assert.deepEqual(resolveInterval({ diatonic: 1, chromatic: 1 }, -1, "flats"), { diatonic: 1, chromatic: 1 });
});

test("instruments : partie en Ut vers clarinette Si♭ = seconde majeure au-dessus", () => {
  const iv = instrumentInterval(findInstrument("ut"), findInstrument("clarinette-sib"));
  assert.deepEqual(iv, { diatonic: 1, chromatic: 2 });
  // Ut → saxophone alto : sixte majeure au-dessus.
  assert.deepEqual(instrumentInterval(findInstrument("flute"), findInstrument("sax-alto")), { diatonic: 5, chromatic: 9 });
  // Sax ténor → sax alto : quinte juste au-dessus (sonorité identique).
  assert.deepEqual(instrumentInterval(findInstrument("sax-tenor"), findInstrument("sax-alto")), { diatonic: -3, chromatic: -5 });
  // Cor en Fa : Do5 écrit sonne Fa4, que la trompette en Si♭ écrit Sol4.
  const hornToTrumpet = instrumentInterval(findInstrument("cor-fa"), findInstrument("trompette-sib"));
  assert.deepEqual(transposePitch({ step: "C", octave: 5 }, hornToTrumpet), { step: "G", alter: 0, octave: 4 });
});

test("transposeScore : notes, armure et altérations", () => {
  // Sol majeur : F# dans l'armure, F naturel altéré, puis F# de nouveau altéré.
  const doc = parse(score([note("G", 4) + note("F", 4, 1) + note("F", 4, 0, "<accidental>natural</accidental>") + note("F", 4, 1, "<accidental>sharp</accidental>")], { fifths: 1 }));
  const report = transposeScore(doc, { interval: { diatonic: 1, chromatic: 2 } });
  assert.deepEqual(fifthsOf(doc), [3]);
  assert.deepEqual(notesOf(doc), [
    { name: "A4", accidental: null },
    { name: "G#4", accidental: null },
    { name: "G4", accidental: "natural" },
    { name: "G#4", accidental: "sharp" },
  ]);
  assert.equal(report.parts[0].to.fifths, 3);
  assert.equal(keyName(report.parts[0].to.fifths, report.parts[0].to.mode), "La majeur");
});

test("transposeScore : les altérations se réinitialisent à chaque mesure", () => {
  const doc = parse(score([note("C", 4, 1) + note("C", 4, 1), note("C", 4, 1)]));
  transposeScore(doc, { interval: { diatonic: 1, chromatic: 2 } });
  assert.deepEqual(notesOf(doc).map((n) => n.accidental), ["sharp", null, "sharp"]);
  assert.deepEqual(notesOf(doc).map((n) => n.name), ["D#4", "D#4", "D#4"]);
});

test("transposeScore : note liée sans altération répétée", () => {
  const tieStart = '<tie type="start"/>';
  const tieStop = '<tie type="stop"/>';
  const doc = parse(score([note("C", 4, 1, tieStart), note("C", 4, 1, tieStop) + note("C", 4, 1)]));
  transposeScore(doc, { interval: { diatonic: 0, chromatic: 0 } });
  assert.deepEqual(notesOf(doc).map((n) => n.accidental), ["sharp", null, "sharp"]);
});

test("transposeScore : accords chiffrés, titre, nom de partie, élément transpose", () => {
  const harmony = "<harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>major</kind><bass><bass-step>D</bass-step></bass></harmony>";
  const doc = parse(score([harmony + note("B", 4, -1)], { fifths: -2 }));
  transposeScore(doc, {
    interval: { diatonic: 1, chromatic: 2 },
    title: "Mon morceau",
    partName: "Clarinette en Si♭",
    instrumentTransposition: { diatonic: -1, chromatic: -2 },
  });
  const xml = serialize(doc);
  assert.match(xml, /<root-step>C<\/root-step><\/root>/);
  assert.match(xml, /<bass-step>E<\/bass-step>/);
  assert.match(xml, /<movement-title>Mon morceau<\/movement-title>/);
  assert.match(xml, /<part-name>Clarinette en Si♭<\/part-name>/);
  assert.match(xml, /<transpose><diatonic>-1<\/diatonic><chromatic>-2<\/chromatic><\/transpose>/);
  assert.deepEqual(fifthsOf(doc), [0]);
  assert.equal(scoreTitle(doc), "Mon morceau");
});

test("transposeScore : transposition d'octave dans l'élément transpose", () => {
  const doc = parse(score([note("C", 4)]));
  transposeScore(doc, { interval: { diatonic: 8, chromatic: 14 }, instrumentTransposition: { diatonic: -8, chromatic: -14 } });
  assert.match(serialize(doc), /<transpose><diatonic>-1<\/diatonic><chromatic>-2<\/chromatic><octave-change>-1<\/octave-change><\/transpose>/);
  assert.deepEqual(notesOf(doc).map((n) => n.name), ["D5"]);
});

test("transposeScore : clé imposée", () => {
  const doc = parse(score([note("C", 4)]));
  transposeScore(doc, { clef: "F" });
  assert.match(serialize(doc), /<clef><sign>F<\/sign><line>4<\/line><\/clef>/);
});

test("transposeScore : partition d'exemple, aller-retour", () => {
  const xml = readFileSync(new URL("../web/samples/au-clair-de-la-lune.musicxml", import.meta.url), "utf8");
  const original = notesOf(parse(xml)).map((n) => n.name);
  const doc = parse(xml);
  transposeScore(doc, { interval: intervalFromSemitones(5) });
  const back = parse(serialize(doc));
  transposeScore(back, { interval: intervalFromSemitones(-5) });
  assert.deepEqual(notesOf(back).map((n) => n.name), original);
});

test("semitoneLabel", () => {
  assert.equal(semitoneLabel(0), "aucune");
  assert.equal(semitoneLabel(2), "seconde majeure vers le haut (+2 demi-tons)");
  assert.equal(semitoneLabel(-13), "une octave + seconde mineure vers le bas (−13 demi-tons)");
});

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
  semitoneLabel,
  simplifyPitch,
} from "../web/transpose.js";

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

test("transposeScore : zone alignée sur les mesures (changement d'armure aller-retour)", () => {
  const doc = parse(score([note("C", 4) + note("E", 4), note("C", 4) + note("F", 4), note("C", 4) + note("B", 4, -1)]));
  const report = transposeScore(doc, {
    interval: intervalFromSemitones(0),
    region: { start: { measure: 1, offset: 0 }, end: { measure: 2, offset: 0 }, interval: intervalFromSemitones(2) },
  });
  assert.deepEqual(notesOf(doc).map((n) => n.name), ["C4", "E4", "D4", "G4", "C4", "Bb4"]);
  assert.deepEqual(fifthsOf(doc), [0, 2, 0], "Ré majeur dans la zone, retour à Do ensuite");
  assert.equal(notesOf(doc)[5].accidental, "flat");
  assert.deepEqual(report.parts[0].regionInterval, { diatonic: 1, chromatic: 2 });
  assert.deepEqual(report.parts[0].interval, { diatonic: 0, chromatic: 0 });
});

test("transposeScore : zone au milieu d'une mesure (altérations, sans armure)", () => {
  const doc = parse(score([note("C", 4) + note("D", 4) + note("E", 4) + note("F", 4)]));
  transposeScore(doc, {
    region: { start: { measure: 0, offset: 1 }, end: { measure: 0, offset: 3 }, interval: intervalFromSemitones(1) },
  });
  const notes = notesOf(doc);
  assert.deepEqual(notes.map((n) => n.name), ["C4", "Eb4", "F4", "F4"]);
  assert.deepEqual(notes.map((n) => n.accidental), [null, "flat", null, null]);
  assert.deepEqual(fifthsOf(doc), [0]);
});

test("transposeScore : zone + transposition globale (instrument)", () => {
  const doc = parse(score([note("C", 4), note("C", 4), note("C", 4)]));
  transposeScore(doc, {
    interval: intervalFromSemitones(2),
    region: { start: { measure: 1, offset: 0 }, end: { measure: 2, offset: 0 }, interval: intervalFromSemitones(12) },
  });
  assert.deepEqual(notesOf(doc).map((n) => n.name), ["D4", "D5", "D4"]);
  assert.deepEqual(fifthsOf(doc), [2], "même armure dans et hors de la zone (octave)");
});

test("transposeScore : zone vide ou inversée ignorée", () => {
  const doc = parse(score([note("C", 4)]));
  transposeScore(doc, { region: { start: { measure: 0, offset: 1 }, end: { measure: 0, offset: 0 }, interval: intervalFromSemitones(5) } });
  assert.deepEqual(notesOf(doc).map((n) => n.name), ["C4"]);
});

// ---------------------------------------------------------------------------
// Simplification de l'écriture
// ---------------------------------------------------------------------------

const sNote = (step, alter, octave, extra = "") =>
  `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>` +
  `<duration>1</duration>${extra}<type>quarter</type></note>`;
const pitches = (doc) => [...doc.getElementsByTagName("note")].map((n) => {
  const t = (name) => n.getElementsByTagName(name)[0]?.textContent;
  const alter = Number(t("alter") ?? 0);
  return `${t("step")}${alter > 0 ? "#".repeat(alter) : "b".repeat(-alter)}${t("octave")}`;
});
const accidentals = (doc) => [...doc.getElementsByTagName("note")].map((n) => n.getElementsByTagName("accidental")[0]?.textContent ?? "-");
const spell = (p, fifths, mode) => {
  const r = simplifyPitch(p, fifths, mode);
  return `${r.step}${r.alter > 0 ? "#".repeat(r.alter) : "b".repeat(-r.alter)}${r.octave}`;
};

test("simplification : mi♯, si♯, fa♭, do♭ et doubles altérations (octave comprise)", () => {
  assert.equal(spell({ step: "E", alter: 1, octave: 4 }, 0), "F4");
  assert.equal(spell({ step: "B", alter: 1, octave: 3 }, 0), "C4");
  assert.equal(spell({ step: "C", alter: -1, octave: 5 }, 0), "B4");
  assert.equal(spell({ step: "F", alter: -1, octave: 4 }, 0), "E4");
  assert.equal(spell({ step: "C", alter: 2, octave: 4 }, 0), "D4");
  assert.equal(spell({ step: "B", alter: -2, octave: 4 }, 0), "A4");
  assert.equal(spell({ step: "F", alter: 2, octave: 4 }, 0), "G4");
  assert.equal(spell({ step: "B", alter: 2, octave: 4 }, 0), "C#5");
});

test("simplification : altérations les plus courantes selon la tonalité", () => {
  // Do majeur : fa♯, do♯, sol♯, mi♭, si♭.
  assert.deepEqual(
    [["G", -1], ["D", -1], ["A", -1], ["D", 1], ["A", 1]].map(([s, a]) => spell({ step: s, alter: a, octave: 4 }, 0)),
    ["F#4", "C#4", "G#4", "Eb4", "Bb4"],
  );
  // Sol majeur : la♯ → si♭ ; Ré majeur : la♯ (sensible de si mineur) gardé.
  assert.equal(spell({ step: "A", alter: 1, octave: 4 }, 1), "Bb4");
  assert.equal(spell({ step: "A", alter: 1, octave: 4 }, 2), "A#4");
  // Fa majeur / ré mineur : do♯ (sensible) gardé, ré♯ → mi♭.
  assert.equal(spell({ step: "D", alter: -1, octave: 4 }, -1), "C#4");
  assert.equal(spell({ step: "D", alter: 1, octave: 4 }, -1), "Eb4");
  // Mineur explicite : la mineur, sol♯ et fa♯ ; ré mineur, mi♭ (napolitaine).
  assert.equal(spell({ step: "A", alter: -1, octave: 4 }, 0, "minor"), "G#4");
  assert.equal(spell({ step: "G", alter: -1, octave: 4 }, 0, "minor"), "F#4");
  assert.equal(spell({ step: "D", alter: 1, octave: 4 }, -1, "minor"), "Eb4");
  // Notes de la gamme : écriture de l'armure, même mi♯ en Fa♯ majeur.
  assert.equal(spell({ step: "F", alter: 0, octave: 4 }, 6), "E#4");
  assert.equal(spell({ step: "B", alter: 0, octave: 4 }, -6), "Cb5");
  assert.equal(spell({ step: "A", alter: 1, octave: 4 }, -2), "Bb4");
  // Écriture déjà simple : inchangée.
  assert.equal(spell({ step: "F", alter: 1, octave: 4 }, 0), "F#4");
});

test("simplification d'une partition : notes, altérations affichées, accords, liaisons", () => {
  const harmony = "<harmony><root><root-step>E</root-step><root-alter>1</root-alter></root><kind>major</kind>" +
    "<bass><bass-step>A</bass-step><bass-alter>1</bass-alter></bass></harmony>";
  const xml = score([
    harmony +
    sNote("A", 1, 4, "<accidental>sharp</accidental>") +
    sNote("A", 0, 4, "<accidental>natural</accidental>") +
    sNote("E", 1, 4, '<tie type="start"/><accidental>sharp</accidental>') +
    sNote("E", 1, 4, '<tie type="stop"/>'),
    sNote("F", 1, 4, "<accidental>sharp</accidental>") + sNote("B", 1, 3, "<accidental>sharp</accidental>"),
  ]);
  const doc = parse(xml);
  const report = transposeScore(doc, { simplify: true });
  assert.deepEqual(pitches(doc), ["Bb4", "A4", "F4", "F4", "F#4", "C4"]);
  // si♭ affiché, bécarre du la devenu inutile retiré, fa sans altération, liaison sans altération.
  assert.deepEqual(accidentals(doc), ["flat", "-", "-", "-", "sharp", "-"]);
  assert.deepEqual(report.parts[0].simplified, { notes: 4, chords: 2, keys: 0 });
  const out = serialize(doc);
  assert.ok(out.includes("<root-step>F</root-step></root>"));
  assert.ok(out.includes("<bass-step>B</bass-step><bass-alter>-1</bass-alter>"));
  // Deuxième passage : plus rien à simplifier.
  const again = transposeScore(doc, { simplify: true });
  assert.deepEqual(again.parts[0].simplified, { notes: 0, chords: 0, keys: 0 });
});

test("simplification : armure à 7 altérations remplacée, sélection respectée", () => {
  const doc = parse(score([sNote("C", 1, 4) + sNote("E", 1, 4)], { fifths: 7 }));
  const report = transposeScore(doc, { simplify: true });
  assert.equal(doc.getElementsByTagName("fifths")[0].textContent, "-5");
  assert.deepEqual(pitches(doc), ["Db4", "F4"]);
  assert.equal(report.parts[0].simplified.keys, 1);

  // Sélection : seule la 2e mesure est réécrite, l'armure n'est pas changée.
  const doc2 = parse(score([sNote("E", 1, 4), sNote("E", 1, 4)]));
  const zone = { start: { measure: 1, offset: 0 }, end: { measure: 2, offset: 0 }, interval: { diatonic: 0, chromatic: 0 } };
  transposeScore(doc2, { simplify: true, region: zone });
  assert.deepEqual(pitches(doc2), ["E#4", "F4"]);
  const doc3 = parse(score([sNote("C", 1, 4)], { fifths: 7 }));
  transposeScore(doc3, { simplify: true, region: { ...zone, start: { measure: 0, offset: 0 } } });
  assert.equal(doc3.getElementsByTagName("fifths")[0].textContent, "7");
});

test("simplification : sens de la mélodie (dièse en montant, bémol en descendant)", () => {
  const run = (notes, fifths = 2) => {
    const doc = parse(score([notes.map(([st, a]) => sNote(st, a, 4)).join("")], { fifths }));
    transposeScore(doc, { simplify: true });
    return pitches(doc).join(" ");
  };
  // Ré majeur (CABARET) : si → la♯ → la devient si♭ ; la → la♯ → si reste la♯.
  assert.equal(run([["B", 0], ["A", 1], ["A", 0]]), "B4 Bb4 A4");
  assert.equal(run([["A", 0], ["A", 1], ["B", 0]]), "A4 A#4 B4");
  // Broderie ré♯ mi fa♯ mi ré♯ : les deux ré♯ restent identiques.
  assert.equal(run([["D", 1], ["E", 0], ["F", 1], ["E", 0], ["D", 1]]), "D#4 E4 F#4 E4 D#4");
  // Notes répétées : même écriture, d'après la note qui suit.
  assert.equal(run([["D", 1], ["D", 1], ["D", 0]]), "Eb4 Eb4 D4");
  // Do majeur : sol → sol♭ → fa en bémol, même si fa♯ est l'écriture habituelle.
  assert.equal(run([["G", 0], ["F", 1], ["F", 0]], 0), "G4 Gb4 F4");
  // Jamais de mi♯ pour monter vers fa♯ : fa ♮ gardé.
  assert.equal(run([["F", 0], ["F", 1]]), "F4 F#4");
});

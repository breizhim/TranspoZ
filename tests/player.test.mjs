import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";

import { scoreEvents, playbackOrder } from "../web/player.js";

const parse = (xml) => new DOMParser().parseFromString(xml, "text/xml");

const SAMPLE = readFileSync(new URL("../web/samples/au-clair-de-la-lune.musicxml", import.meta.url), "utf8");

// Partition à une partie ; divisions = 1 (une noire = 1).
function score(measures, attributes = "") {
  const body = measures
    .map((m, i) => {
      const attrs = i === 0 ? `<attributes><divisions>1</divisions>${attributes}</attributes>` : "";
      return `<measure number="${i + 1}">${attrs}${m}</measure>`;
    })
    .join("");
  return parse(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`);
}

const note = (step, octave, duration = 1, extra = "") =>
  `<note>${extra.includes("<chord/>") ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
  `<duration>${duration}</duration>${extra.replace("<chord/>", "")}</note>`;
const rest = (duration = 1) => `<note><rest/><duration>${duration}</duration></note>`;
const bar = (inner, location = "right") => `<barline location="${location}">${inner}</barline>`;

const simple = (events) => events.notes.map((n) => [n.start, n.duration, n.midi]);

test("notes, silences et accords", () => {
  const ev = scoreEvents(score([note("C", 4) + rest() + note("E", 4, 2) + note("G", 4, 2, "<chord/>")]));
  assert.deepEqual(simple(ev), [[0, 1, 60], [2, 2, 64], [2, 2, 67]]);
  assert.equal(ev.length, 4);
});

test("les liaisons de prolongation fusionnent les notes", () => {
  const ev = scoreEvents(score([
    note("C", 4, 1) + note("D", 4, 3, '<tie type="start"/>'),
    note("D", 4, 2, '<tie type="stop"/>') + note("D", 4, 2),
  ]));
  assert.deepEqual(simple(ev), [[0, 1, 60], [1, 5, 62], [6, 2, 62]]);
});

test("altérations ; notes écrites ou sons réels (élément <transpose>)", () => {
  const sharp = `<note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration></note>`;
  const doc = score([sharp + note("C", 5)], "<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>");
  assert.deepEqual(simple(scoreEvents(doc)).map((n) => n[2]), [66, 72]);
  assert.deepEqual(simple(scoreEvents(doc, { concertPitch: true })).map((n) => n[2]), [64, 70]);
  const octave = scoreEvents(score([note("C", 4)],
    "<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>"),
  { concertPitch: true });
  assert.equal(octave.notes[0].midi, 48);
});

test("<backup> : deux voix dans la même mesure", () => {
  const ev = scoreEvents(score([note("E", 5, 2) + note("F", 5, 2) + "<backup><duration>4</duration></backup>" + note("C", 4, 4)]));
  assert.deepEqual(simple(ev), [[0, 4, 60], [0, 2, 76], [2, 2, 77]]);
  assert.equal(ev.length, 4);
});

test("reprise simple", () => {
  const doc = score([
    note("C", 4, 4),
    bar('<repeat direction="forward"/>', "left") + note("D", 4, 4),
    note("E", 4, 4) + bar('<repeat direction="backward"/>'),
    note("F", 4, 4),
  ]);
  assert.deepEqual(playbackOrder([...doc.getElementsByTagName("measure")]), [0, 1, 2, 1, 2, 3]);
  const ev = scoreEvents(doc);
  assert.deepEqual(ev.notes.map((n) => n.midi), [60, 62, 64, 62, 64, 65]);
  assert.equal(ev.length, 24);
});

test("reprise depuis le début, fins alternatives 1 et 2", () => {
  const doc = score([
    note("C", 4, 4),
    bar('<ending number="1" type="start"/>', "left") + note("D", 4, 4) +
      bar('<ending number="1" type="stop"/><repeat direction="backward"/>'),
    bar('<ending number="2" type="start"/>', "left") + note("E", 4, 4) + bar('<ending number="2" type="discontinue"/>'),
    note("F", 4, 4),
  ]);
  assert.deepEqual(playbackOrder([...doc.getElementsByTagName("measure")]), [0, 1, 0, 2, 3]);
});

test("reprise jouée trois fois (times) et deux reprises successives", () => {
  const measures = (xml) => [...score(xml).getElementsByTagName("measure")];
  assert.deepEqual(
    playbackOrder(measures([note("C", 4, 4) + bar('<repeat direction="backward" times="3"/>'), note("D", 4, 4)])),
    [0, 0, 0, 1],
  );
  assert.deepEqual(
    playbackOrder(measures([
      note("C", 4, 4) + bar('<repeat direction="backward"/>'),
      note("D", 4, 4) + bar('<repeat direction="backward"/>'),
    ])),
    [0, 0, 1, 1],
  );
});

test("tempo lu dans <sound tempo>, 100 par défaut", () => {
  assert.deepEqual(scoreEvents(score([note("C", 4)])).tempos, [{ at: 0, bpm: 100 }]);
  const ev = scoreEvents(score([
    '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction>' + note("C", 4, 4),
    '<direction><sound tempo="120"/></direction>' + note("D", 4, 4),
  ]));
  assert.deepEqual(ev.tempos, [{ at: 0, bpm: 72 }, { at: 4, bpm: 120 }]);
});

test("exemple fourni : Au clair de la lune", () => {
  const ev = scoreEvents(parse(SAMPLE));
  assert.ok(ev.notes.length > 10);
  // Do Do Do Ré Mi…
  assert.deepEqual(ev.notes.slice(0, 5).map((n) => n.midi % 12), [0, 0, 0, 2, 4]);
  assert.ok(ev.notes.every((n, i, a) => i === 0 || n.start >= a[i - 1].start));
});

test("début de chaque mesure dans la lecture (reprises)", () => {
  const doc = score([
    note("C", 4, 4),
    bar('<repeat direction="forward"/>', "left") + note("D", 4, 4),
    note("E", 4, 4) + bar('<repeat direction="backward"/>'),
    note("F", 4, 4),
  ]);
  const { measureStarts } = scoreEvents(doc);
  assert.deepEqual([...measureStarts], [[0, 0], [1, 4], [2, 8], [3, 20]]);
});

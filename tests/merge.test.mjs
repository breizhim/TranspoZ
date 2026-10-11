import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { mergeScores } from "../web/merge.js";

const dom = { DOMParser, XMLSerializer };

// Mêmes pages que dans tests/test_api.py (fusion côté serveur).
const page = (notes, key = 0) =>
  '<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1">' +
  '<part-name>X</part-name></score-part></part-list><part id="P1"><measure number="1">' +
  `<attributes><divisions>1</divisions><key><fifths>${key}</fifths></key>` +
  "<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>" +
  `${notes}</measure></part></score-partwise>`;

const NOTE = "<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>";
const count = (text, s) => text.split(s).length - 1;

test("fusion : renumérotation et attributs répétés retirés (comme le serveur)", () => {
  const merged = mergeScores([page(NOTE), page(NOTE), page(NOTE, 2)], dom);
  assert.equal(count(merged, "<measure "), 3);
  assert.ok(merged.includes('number="3"'));
  // La 2e page répète armure/chiffrage/clé : retirés ; la 3e change d'armure.
  assert.equal(count(merged, "<time>"), 1);
  assert.equal(count(merged, "<key>"), 2);
  assert.equal(count(merged, "<divisions>"), 3);
  assert.ok(merged.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});

test("fusion : une seule page est rendue telle quelle, aucune est une erreur", () => {
  assert.equal(mergeScores([page(NOTE)], dom), page(NOTE));
  assert.throws(() => mergeScores([], dom), /Aucune/);
  assert.throws(() => mergeScores([page(NOTE), "<html/>"], dom), /invalide/);
});

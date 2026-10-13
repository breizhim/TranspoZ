import { test } from "node:test";
import assert from "node:assert/strict";

import { forceTimeInSheet, parseTime } from "../web/omr-time.js";

test("parseTime", () => {
  assert.deepEqual(parseTime("2/2"), { beats: 2, beatType: 2 });
  assert.deepEqual(parseTime(" 12 / 8 "), { beats: 12, beatType: 8 });
  assert.equal(parseTime("3/5"), null);
  assert.equal(parseTime("auto"), null);
  assert.equal(parseTime(null), null);
});

test("chiffrage d'un seul symbole (lu 3/4, imposé 2/2)", () => {
  const xml = '<inters><time-whole time-rational="3/4" shape="TIME_THREE_FOUR" glyph="292" grade="0.758" staff="1" id="294">' +
    '<bounds x="1" y="2" w="3" h="4"/></time-whole></inters>';
  const { xml: out, count } = forceTimeInSheet(xml, { beats: 2, beatType: 2 });
  assert.equal(count, 1);
  assert.ok(out.includes('<time-whole time-rational="2/2" shape="TIME_TWO_TWO" glyph="292"'));
  assert.ok(out.includes('<bounds x="1" y="2" w="3" h="4"/>'), "le reste est intact");
});

test("chiffrage en deux chiffres (9/8 imposé 6/8), paire écartée ignorée", () => {
  const xml = '<time-number side="TOP" value="9" shape="TIME_NINE" id="25"><bounds/></time-number>' +
    '<time-number side="BOTTOM" value="8" shape="TIME_EIGHT" id="27"></time-number>' +
    '<time-pair grade="0" abnormal="true" staff="1" id="28"></time-pair>' +
    '<time-pair time-rational="9/8" grade="0.807" staff="1" id="29"></time-pair>';
  const { xml: out, count } = forceTimeInSheet(xml, { beats: 6, beatType: 8 });
  assert.equal(count, 1);
  assert.ok(out.includes('<time-number side="TOP" value="6" shape="TIME_SIX" id="25">'));
  assert.ok(out.includes('<time-number side="BOTTOM" value="8" shape="TIME_EIGHT" id="27">'));
  assert.ok(out.includes('<time-pair grade="0" abnormal="true" staff="1" id="28">'));
  assert.ok(out.includes('<time-pair time-rational="6/8" grade="0.807"'));
});

test("symboles C et ¢ gardés s'ils conviennent, chiffrage rare en TIME_CUSTOM", () => {
  const cut = '<time-whole time-rational="2/2" shape="CUT_TIME" id="1">';
  assert.equal(forceTimeInSheet(cut, { beats: 2, beatType: 2 }).xml, cut);
  assert.ok(forceTimeInSheet(cut, { beats: 4, beatType: 4 }).xml.includes('shape="TIME_FOUR_FOUR"'));
  assert.ok(forceTimeInSheet(cut, { beats: 7, beatType: 8 }).xml.includes('time-rational="7/8" shape="TIME_CUSTOM"'));
  assert.equal(forceTimeInSheet("<inters/>", { beats: 2, beatType: 2 }).count, 0, "aucun chiffrage trouvé");
});

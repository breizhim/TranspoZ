// Chiffrage imposé à la reconnaissance (Audiveris).
//
// Audiveris lit parfois mal le chiffrage (ex. 2/2 lu 3/4) et retire alors des notes
// pour que chaque mesure tombe juste. Pour l'éviter, on arrête Audiveris après
// l'étape HEADERS (clé, armure, chiffrage en début de portée), on remplace le
// chiffrage dans son projet (.omr : sheet#N/sheet#N.xml), puis on le laisse finir.
// Même transformation que server/omr.py (force_time_signature).

const NUMBER_SHAPES = {
  0: "TIME_ZERO", 1: "TIME_ONE", 2: "TIME_TWO", 3: "TIME_THREE", 4: "TIME_FOUR", 5: "TIME_FIVE",
  6: "TIME_SIX", 7: "TIME_SEVEN", 8: "TIME_EIGHT", 9: "TIME_NINE", 12: "TIME_TWELVE", 16: "TIME_SIXTEEN",
};
const WHOLE_SHAPES = {
  "2/2": "TIME_TWO_TWO", "2/4": "TIME_TWO_FOUR", "3/4": "TIME_THREE_FOUR", "4/4": "TIME_FOUR_FOUR",
  "5/4": "TIME_FIVE_FOUR", "6/4": "TIME_SIX_FOUR", "3/8": "TIME_THREE_EIGHT", "6/8": "TIME_SIX_EIGHT",
  "12/8": "TIME_TWELVE_EIGHT",
};
// Symboles C et ¢, gardés s'ils correspondent déjà au chiffrage voulu.
const SYMBOLS = { COMMON_TIME: "4/4", CUT_TIME: "2/2" };

/** "2/2" → { beats: 2, beatType: 2 }, ou null si invalide. */
export function parseTime(text) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(text ?? "");
  if (!m) return null;
  const beats = Number(m[1]);
  const beatType = Number(m[2]);
  return beats > 0 && [1, 2, 4, 8, 16, 32].includes(beatType) ? { beats, beatType } : null;
}

const setAttr = (tag, name, value) => (new RegExp(`\\s${name}="[^"]*"`).test(tag)
  ? tag.replace(new RegExp(`(\\s${name}=)"[^"]*"`), `$1"${value}"`)
  : tag.replace(/^<([\w-]+)/, `<$1 ${name}="${value}"`));

/**
 * Remplace les chiffrages d'une page Audiveris (contenu de sheet#N.xml).
 * @returns {{ xml: string, count: number }} count = chiffrages modifiés
 */
export function forceTimeInSheet(xml, time) {
  const { beats, beatType } = time;
  const rational = `${beats}/${beatType}`;
  let count = 0;
  let out = xml.replace(/<time-whole\b[^>]*>/g, (tag) => {
    count++;
    const shape = /\sshape="([A-Z_]+)"/.exec(tag)?.[1];
    const keep = SYMBOLS[shape] === rational;
    return setAttr(setAttr(tag, "time-rational", rational), "shape", keep ? shape : WHOLE_SHAPES[rational] ?? "TIME_CUSTOM");
  });
  out = out.replace(/<time-pair\b[^>]*>/g, (tag) => {
    if (!/\stime-rational="/.test(tag)) return tag; // paire écartée par Audiveris
    count++;
    return setAttr(tag, "time-rational", rational);
  });
  out = out.replace(/<time-number\b[^>]*>/g, (tag) => {
    const value = /\sside="TOP"/.test(tag) ? beats : /\sside="BOTTOM"/.test(tag) ? beatType : null;
    if (value == null) return tag;
    return setAttr(setAttr(tag, "value", value), "shape", NUMBER_SHAPES[value] ?? "TIME_CUSTOM");
  });
  return { xml: out, count };
}

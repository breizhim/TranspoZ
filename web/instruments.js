// Hauteurs d'instruments et catalogue des instruments courants.
//
// La « hauteur » d'un instrument est la note réelle entendue quand il joue un Do
// écrit. On la représente comme la transposition MusicXML (<transpose>) :
// l'intervalle à ajouter à la note écrite pour obtenir le son réel.

import { addIntervals, negateInterval } from "./transpose.js";

export const PITCHES = {
  C: { label: "Ut (Do)", diatonic: 0, chromatic: 0 },
  Bb: { label: "Si♭", diatonic: -1, chromatic: -2 },
  A: { label: "La", diatonic: -2, chromatic: -3 },
  G: { label: "Sol", diatonic: -3, chromatic: -5 },
  F: { label: "Fa", diatonic: -4, chromatic: -7 },
  Eb: { label: "Mi♭", diatonic: 2, chromatic: 3 },
  D: { label: "Ré", diatonic: 1, chromatic: 2 },
};

// octave : décalage d'octave du son réel par rapport à la hauteur ci-dessus
// (ex. saxophone alto en Mi♭ : sonne une sixte majeure plus bas = Mi♭ aigu – 1 octave).
export const INSTRUMENTS = [
  { id: "ut", name: "Instrument en Ut (piano, flûte, violon, voix…)", pitch: "C", octave: 0, clef: "G" },
  { id: "piano", name: "Piano", pitch: "C", octave: 0, clef: null },
  { id: "flute", name: "Flûte traversière", pitch: "C", octave: 0, clef: "G" },
  { id: "piccolo", name: "Piccolo", pitch: "C", octave: 1, clef: "G" },
  { id: "flute-alto", name: "Flûte alto en Sol", pitch: "G", octave: 0, clef: "G" },
  { id: "hautbois", name: "Hautbois", pitch: "C", octave: 0, clef: "G" },
  { id: "cor-anglais", name: "Cor anglais", pitch: "F", octave: 0, clef: "G" },
  { id: "basson", name: "Basson", pitch: "C", octave: 0, clef: "F" },
  { id: "clarinette-sib", name: "Clarinette en Si♭", pitch: "Bb", octave: 0, clef: "G" },
  { id: "clarinette-la", name: "Clarinette en La", pitch: "A", octave: 0, clef: "G" },
  { id: "clarinette-mib", name: "Petite clarinette en Mi♭", pitch: "Eb", octave: 0, clef: "G" },
  { id: "clarinette-basse", name: "Clarinette basse en Si♭", pitch: "Bb", octave: -1, clef: "G" },
  { id: "sax-soprano", name: "Saxophone soprano en Si♭", pitch: "Bb", octave: 0, clef: "G" },
  { id: "sax-alto", name: "Saxophone alto en Mi♭", pitch: "Eb", octave: -1, clef: "G" },
  { id: "sax-tenor", name: "Saxophone ténor en Si♭", pitch: "Bb", octave: -1, clef: "G" },
  { id: "sax-baryton", name: "Saxophone baryton en Mi♭", pitch: "Eb", octave: -2, clef: "G" },
  { id: "trompette-sib", name: "Trompette en Si♭", pitch: "Bb", octave: 0, clef: "G" },
  { id: "trompette-ut", name: "Trompette en Ut", pitch: "C", octave: 0, clef: "G" },
  { id: "cornet", name: "Cornet / bugle en Si♭", pitch: "Bb", octave: 0, clef: "G" },
  { id: "cor-fa", name: "Cor en Fa", pitch: "F", octave: 0, clef: "G" },
  { id: "trombone", name: "Trombone (clé de fa, en Ut)", pitch: "C", octave: 0, clef: "F" },
  { id: "trombone-sib", name: "Trombone en Si♭ (clé de sol)", pitch: "Bb", octave: -1, clef: "G" },
  { id: "euphonium-sib", name: "Euphonium / saxhorn en Si♭ (clé de sol)", pitch: "Bb", octave: -1, clef: "G" },
  { id: "tuba", name: "Tuba (clé de fa, en Ut)", pitch: "C", octave: 0, clef: "F" },
  { id: "tuba-sib", name: "Tuba en Si♭ (clé de sol)", pitch: "Bb", octave: -2, clef: "G" },
  { id: "alto", name: "Alto (violon alto)", pitch: "C", octave: 0, clef: "C3" },
  { id: "violoncelle", name: "Violoncelle", pitch: "C", octave: 0, clef: "F" },
  { id: "contrebasse", name: "Contrebasse", pitch: "C", octave: -1, clef: "F" },
  { id: "guitare", name: "Guitare", pitch: "C", octave: -1, clef: "G" },
  { id: "custom", name: "Autre (hauteur personnalisée)", pitch: "C", octave: 0, clef: null },
];

export function findInstrument(id) {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
}

// Transposition réelle (écrit → son réel) d'un instrument de hauteur `pitch`
// décalé de `octave` octaves.
export function soundingOffset(pitch, octave = 0) {
  const p = PITCHES[pitch] ?? PITCHES.C;
  return { diatonic: p.diatonic + 7 * octave, chromatic: p.chromatic + 12 * octave };
}

// Intervalle écrit pour passer d'une partie écrite pour `source` à une partie
// écrite pour `target` sonnant à la même hauteur réelle :
//   écrit_cible = écrit_source + offset_source − offset_cible
export function instrumentInterval(source, target) {
  return addIntervals(
    soundingOffset(source.pitch, source.octave),
    negateInterval(soundingOffset(target.pitch, target.octave)),
  );
}

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

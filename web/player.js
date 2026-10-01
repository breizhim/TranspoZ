// Lecture audio d'une partition MusicXML avec un son de trompette synthétisé
// (Web Audio, sans échantillons ni dépendance).
//
// scoreEvents() est une fonction pure (testée sous Node) : elle transforme le
// MusicXML en liste de notes (hauteurs écrites, ou réelles en tenant compte de
// l'élément <transpose>), avec les reprises, les fins alternatives et les
// liaisons de prolongation. Les temps sont exprimés en noires.

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DEFAULT_BPM = 100;
const MAX_MEASURE_PLAYS = 5000;

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

// Reprises et fins alternatives d'une mesure, lues sur ses barres.
function measureRepeats(measure) {
  const info = { forward: false, backward: 0, endingStart: null, endingEnd: false };
  for (const bar of children(measure, "barline")) {
    const repeat = child(bar, "repeat");
    if (repeat?.getAttribute("direction") === "forward") info.forward = true;
    if (repeat?.getAttribute("direction") === "backward") {
      info.backward = numberOr(repeat.getAttribute("times"), 2);
    }
    const ending = child(bar, "ending");
    if (ending) {
      const type = ending.getAttribute("type");
      if (type === "start") {
        info.endingStart = (ending.getAttribute("number") || "1")
          .split(/[\s,]+/).map(Number).filter(Number.isFinite);
      } else if (type === "stop" || type === "discontinue") {
        info.endingEnd = true;
      }
    }
  }
  return info;
}

/**
 * Ordre de lecture des mesures (indices), reprises et fins alternatives dépliées.
 * Les renvois D.C./D.S./Coda ne sont pas suivis.
 */
export function playbackOrder(measures) {
  const infos = measures.map(measureRepeats);
  // Fins alternatives : numéros de passage de chaque mesure (null = toujours jouée).
  const endings = [];
  let current = null;
  for (const info of infos) {
    if (info.endingStart) current = info.endingStart;
    endings.push(current);
    if (info.endingEnd) current = null;
  }

  const order = [];
  const counts = new Map();
  let repeatStart = 0;
  let pass = 1;
  let jumped = false;
  let i = 0;
  while (i < infos.length && order.length < MAX_MEASURE_PLAYS) {
    const info = infos[i];
    if (info.forward && !jumped) {
      repeatStart = i;
      pass = 1;
    }
    jumped = false;
    if (endings[i] && !endings[i].includes(pass)) {
      i++;
      continue;
    }
    order.push(i);
    if (info.backward) {
      const count = counts.get(i) ?? 1;
      if (count < info.backward) {
        counts.set(i, count + 1);
        pass = count + 1;
        i = repeatStart;
        jumped = true;
        continue;
      }
      counts.delete(i);
    }
    if (info.backward || info.endingEnd) {
      repeatStart = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

function midiOf(pitchEl, transpose) {
  const step = childText(pitchEl, "step");
  const alter = numberOr(childText(pitchEl, "alter"), 0);
  const octave = numberOr(childText(pitchEl, "octave"), 4);
  return (octave + 1) * 12 + (STEP_SEMITONES[step] ?? 0) + alter + transpose;
}

function hasTie(note, type) {
  return children(note, "tie").some((t) => t.getAttribute("type") === type);
}

function soundTempo(el) {
  const sounds = el.nodeName === "sound" ? [el] : el.getElementsByTagName("sound");
  for (const s of sounds) {
    const tempo = Number(s.getAttribute("tempo"));
    if (tempo > 0) return tempo;
  }
  return null;
}

/**
 * Notes d'une partition, prêtes à jouer.
 *
 * @param {Document} doc  MusicXML « score-partwise »
 * @param {object} [options]
 * @param {boolean} [options.concertPitch=false]  hauteurs réelles (applique <transpose>)
 *        plutôt que les notes écrites
 * @returns {{notes: Array<{start:number, duration:number, midi:number, part:number}>,
 *            tempos: Array<{at:number, bpm:number}>, length:number, measureStarts:Map<number, number>}}
 *          temps en noires ; tempos triés, le premier à 0 ; measureStarts : début de la
 *          première lecture de chaque mesure
 */
export function scoreEvents(doc, { concertPitch = false } = {}) {
  const root = doc.documentElement;
  const parts = children(root, "part");
  const notes = [];
  const tempoChanges = new Map();
  const measureStarts = new Map();
  let length = 0;
  if (!parts.length) return { notes, tempos: [{ at: 0, bpm: DEFAULT_BPM }], length, measureStarts };

  // Les reprises sont lues sur la première partie et appliquées à toutes.
  const order = playbackOrder(children(parts[0], "measure"));

  parts.forEach((part, partIndex) => {
    const measures = children(part, "measure");
    let divisions = 1;
    let transpose = 0;
    let measureStart = 0;
    const tied = new Map(); // hauteur → note en cours de prolongation

    for (const index of order) {
      const measure = measures[index];
      if (!measure) continue;
      if (partIndex === 0 && !measureStarts.has(index)) measureStarts.set(index, measureStart);
      let pos = 0;
      let maxPos = 0;
      let lastStart = 0;

      for (const el of children(measure)) {
        switch (el.nodeName) {
          case "attributes": {
            divisions = numberOr(childText(el, "divisions"), divisions);
            const t = child(el, "transpose");
            if (t && concertPitch) {
              transpose = numberOr(childText(t, "chromatic"), 0) +
                12 * numberOr(childText(t, "octave-change"), 0);
            }
            break;
          }
          case "backup":
            pos -= numberOr(childText(el, "duration"), 0) / divisions;
            break;
          case "forward":
            pos += numberOr(childText(el, "duration"), 0) / divisions;
            break;
          case "direction":
          case "sound": {
            const bpm = partIndex === 0 ? soundTempo(el) : null;
            if (bpm) tempoChanges.set(measureStart + pos, bpm);
            break;
          }
          case "note": {
            if (child(el, "grace") || child(el, "cue")) break;
            const duration = numberOr(childText(el, "duration"), 0) / divisions;
            const isChord = Boolean(child(el, "chord"));
            const start = isChord ? lastStart : pos;
            if (!isChord) {
              lastStart = pos;
              pos += duration;
            }
            const pitchEl = child(el, "pitch");
            if (pitchEl && duration > 0) {
              const midi = midiOf(pitchEl, transpose);
              const at = measureStart + start;
              const previous = hasTie(el, "stop") ? tied.get(midi) : null;
              let current;
              if (previous && Math.abs(previous.start + previous.duration - at) < 1e-6) {
                previous.duration += duration;
                current = previous;
              } else {
                current = { start: at, duration, midi, part: partIndex };
                notes.push(current);
              }
              if (hasTie(el, "start")) tied.set(midi, current);
              else tied.delete(midi);
            }
            break;
          }
        }
        maxPos = Math.max(maxPos, pos);
      }
      measureStart += maxPos;
    }
    length = Math.max(length, measureStart);
  });

  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const tempos = [...tempoChanges].sort((a, b) => a[0] - b[0]).map(([at, bpm]) => ({ at, bpm }));
  if (!tempos.length || tempos[0].at > 0) tempos.unshift({ at: 0, bpm: tempos[0]?.bpm ?? DEFAULT_BPM });
  return { notes, tempos, length, measureStarts };
}

// Conversion noires ↔ secondes selon les changements de tempo (multipliés par `speed`).
function timeline(tempos, speed) {
  const segments = [];
  let seconds = 0;
  tempos.forEach((t, i) => {
    const secPerQuarter = 60 / (t.bpm * speed);
    segments.push({ at: t.at, seconds, secPerQuarter });
    const next = tempos[i + 1];
    if (next) seconds += (next.at - t.at) * secPerQuarter;
  });
  const find = (key, value) => {
    let s = segments[0];
    for (const seg of segments) if (seg[key] <= value) s = seg;
    return s;
  };
  return {
    toSeconds: (q) => {
      const s = find("at", q);
      return s.seconds + (q - s.at) * s.secPerQuarter;
    },
    toQuarters: (sec) => {
      const s = find("seconds", sec);
      return s.at + (sec - s.seconds) / s.secPerQuarter;
    },
  };
}

// ---------------------------------------------------------------------------
// Synthèse (navigateur)
// ---------------------------------------------------------------------------

const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// Réverbération légère : réponse impulsionnelle de bruit décroissant.
function makeReverb(ctx, seconds = 1.6) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  const conv = ctx.createConvolver();
  conv.buffer = buffer;
  return conv;
}

// Une note de trompette : deux dents de scie légèrement désaccordées, filtre
// passe-bas dont l'ouverture suit l'attaque (le « cuivré »), petite montée de
// hauteur à l'attaque et vibrato qui arrive après un instant.
function playTrumpetNote(ctx, out, midi, when, duration) {
  const f = midiToHz(midi);
  const end = when + duration;
  const release = 0.07;

  const oscs = [0, 5].map((cents) => {
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.detune.value = cents;
    o.frequency.setValueAtTime(f * 0.97, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.05);
    return o;
  });

  const vibrato = ctx.createOscillator();
  vibrato.frequency.value = 5.3;
  const vibratoDepth = ctx.createGain();
  vibratoDepth.gain.setValueAtTime(0, when);
  vibratoDepth.gain.setValueAtTime(0, when + Math.min(0.3, duration * 0.5));
  vibratoDepth.gain.linearRampToValueAtTime(f * 0.005, when + Math.min(0.6, duration));
  vibrato.connect(vibratoDepth);
  for (const o of oscs) vibratoDepth.connect(o.frequency);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 2;
  const bright = Math.min(f * 9, 11000);
  filter.frequency.setValueAtTime(f * 1.5, when);
  filter.frequency.exponentialRampToValueAtTime(bright, when + 0.045);
  filter.frequency.exponentialRampToValueAtTime(Math.min(f * 5.5, 8000), when + 0.25);
  filter.frequency.setValueAtTime(Math.min(f * 5.5, 8000), end);
  filter.frequency.exponentialRampToValueAtTime(f * 2, end + release);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(0.5, when + 0.03);
  amp.gain.exponentialRampToValueAtTime(0.36, when + 0.18);
  amp.gain.setValueAtTime(0.36, end);
  amp.gain.exponentialRampToValueAtTime(0.0001, end + release);

  for (const o of oscs) o.connect(filter);
  filter.connect(amp).connect(out);
  for (const o of [...oscs, vibrato]) {
    o.start(when);
    o.stop(end + release + 0.02);
  }
}

export class TrumpetPlayer {
  constructor() {
    this.ctx = null;
    this.events = null;
    this.bpm = DEFAULT_BPM;
    this.playing = false;
    this.position = 0; // en noires, pour reprendre après une pause
    this.onEnd = null;
    this.bus = null;
    this.timer = null;
  }

  /** Charge une partition (Document MusicXML). Arrête la lecture, garde la position. */
  load(doc, { concertPitch = false } = {}) {
    this._silence();
    this.events = scoreEvents(doc, { concertPitch });
    this.position = Math.min(this.position, this.length);
  }

  /** Instant de lecture (en noires) d'une position dans une mesure (première lecture). */
  quarterAt(measure, offset) {
    const start = this.events?.measureStarts.get(measure);
    return start == null ? null : start + offset;
  }

  /** Place la lecture à un instant (en noires) ; continue si elle était en cours. */
  async seek(quarter) {
    const wasPlaying = this.playing;
    if (wasPlaying) this._silence();
    this.position = Math.max(0, Math.min(quarter, this.length));
    if (wasPlaying) await this.play();
  }

  /** Tempo indiqué sur la partition (première indication, sinon 100). */
  get scoreBpm() {
    return this.events?.tempos[0].bpm ?? DEFAULT_BPM;
  }

  get length() {
    return this.events?.length ?? 0;
  }

  /** Change le tempo (en cours de lecture : reprend au même endroit). */
  async setBpm(bpm) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.bpm = bpm;
    if (wasPlaying) await this.play();
  }

  _output() {
    if (this.ctx) return this.out;
    const ctx = (this.ctx = new AudioContext());
    // Formant des cuivres vers 1,2 kHz, puis compresseur et réverbération.
    const formant = ctx.createBiquadFilter();
    formant.type = "peaking";
    formant.frequency.value = 1200;
    formant.Q.value = 1;
    formant.gain.value = 5;
    const comp = ctx.createDynamicsCompressor();
    const master = ctx.createGain();
    master.gain.value = 0.35;
    const reverb = makeReverb(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    formant.connect(comp).connect(master).connect(ctx.destination);
    master.connect(reverb).connect(wet).connect(ctx.destination);
    this.out = formant;
    return formant;
  }

  /** Position courante en noires (pour le curseur). */
  currentQuarter() {
    if (!this.playing) return this.position;
    return Math.max(0, this.time.toQuarters(this.ctx.currentTime - this.startTime));
  }

  async play() {
    if (this.playing || !this.events) return;
    const out = this._output();
    await this.ctx.resume();
    if (this.playing) return;
    // Chaque lecture a son propre volume, coupé d'un coup à la pause.
    const bus = (this.bus = this.ctx.createGain());
    bus.connect(out);
    if (this.position >= this.length) this.position = 0;
    this.time = timeline(this.events.tempos, this.bpm / this.scoreBpm);
    // startTime = instant (horloge audio) correspondant au début de la partition.
    this.startTime = this.ctx.currentTime + 0.08 - this.time.toSeconds(this.position);
    this.playing = true;

    const notes = this.events.notes;
    let next = notes.findIndex((n) => n.start >= this.position - 1e-6);
    if (next < 0) next = notes.length;
    const endSec = this.time.toSeconds(this.length);

    // Programmation par petites tranches pour rester réactif (pause, tempo).
    const schedule = () => {
      const horizon = this.ctx.currentTime - this.startTime + 0.3;
      while (next < notes.length && this.time.toSeconds(notes[next].start) < horizon) {
        const n = notes[next++];
        const on = this.time.toSeconds(n.start);
        const off = this.time.toSeconds(n.start + n.duration);
        // Légère séparation entre les notes, comme un coup de langue.
        const gap = Math.min(0.05, (off - on) * 0.12);
        playTrumpetNote(this.ctx, bus, n.midi, this.startTime + on, off - on - gap);
      }
      if (this.ctx.currentTime - this.startTime >= endSec + 0.1) {
        this.stop();
        this.onEnd?.();
      }
    };
    schedule();
    this.timer = setInterval(schedule, 50);
  }

  pause() {
    if (!this.playing) return;
    this.position = Math.min(this.currentQuarter(), this.length);
    this._silence();
  }

  stop() {
    this._silence();
    this.position = 0;
  }

  _silence() {
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    const bus = this.bus;
    this.bus = null;
    if (bus) {
      bus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
      setTimeout(() => bus.disconnect(), 300);
    }
  }
}

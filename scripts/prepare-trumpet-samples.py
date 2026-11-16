#!/usr/bin/env python3
"""Prépare les sons de trompette du lecteur (web/samples/trumpet/).

Source : VSCO 2 Community Edition (Versilian Studios, domaine public CC0),
https://github.com/sgossner/VSCO-2-CE — trompette tenue avec vibrato (susvib) et piquée (stac).
Chaque note est mise en mono, raccourcie (fondu de fin) et encodée en MP3.
La hauteur de chaque fichier est vérifiée par analyse (l'octave des noms VSCO est décalée).

Usage : python3 scripts/prepare-trumpet-samples.py   (dépendances : numpy, lameenc)
"""
import io
import json
import re
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import lameenc
import numpy as np

COMMIT = "440300901dfe9275fd84e0b7763af1f8443ae62e"  # VSCO-2-CE, version figée
BASE = f"https://raw.githubusercontent.com/sgossner/VSCO-2-CE/{COMMIT}/Brass/Trumpet"
NOTES = ["F2", "A2", "C3", "D#3", "F3", "G3", "A#3", "D4", "F4", "A4", "C5"]
SETS = {
    # nom : (dossier, fichier, durée gardée en secondes)
    "sus": ("susvib", "Sum_SHTrumpet_susvib_{note}_v2_rr1.wav", 7.0),
    "stac": ("stac", "Sum_SHTrumpet_stac_{note}_v2_rr1.wav", 1.5),
}
OUT = Path(__file__).resolve().parent.parent / "web" / "samples" / "trumpet"
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def label_midi(note):
    """Numéro MIDI d'après le nom VSCO (ex. « A#3 »), en notation scientifique."""
    m = re.fullmatch(r"([A-G]#?)(-?\d)", note)
    return NAMES.index(m[1]) + 12 * (int(m[2]) + 1)


def read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        assert w.getsampwidth() == 2, "WAV 16 bits attendu"
        rate, channels = w.getframerate(), w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64)
    return pcm.reshape(-1, channels).mean(axis=1) / 32768, rate


def measured_midi(x, rate, onset):
    """Hauteur mesurée (MIDI, fractionnaire) juste après l'attaque, par autocorrélation :
    premier pic proche du maximum, pour ne pas prendre une octave plus bas (sous-harmonique)."""
    seg = x[onset + int(0.04 * rate): onset + int(0.2 * rate)]
    seg = seg - seg.mean()
    corr = np.fft.irfft(np.abs(np.fft.rfft(seg, 2 * len(seg))) ** 2)[: len(seg)]
    lo, hi = int(rate / 1200), int(rate / 120)  # 120 Hz à 1200 Hz
    best = corr[lo:hi].max()
    lag = next(l for l in range(lo, hi) if corr[l] > 0.85 * best and corr[l] >= corr[l - 1] and corr[l] >= corr[l + 1])
    return 69 + 12 * np.log2(rate / lag / 440)


def encode(x, rate):
    enc = lameenc.Encoder()
    enc.set_bit_rate(96)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    return enc.encode(pcm) + enc.flush()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (folder, pattern, keep) in SETS.items():
        manifest[name] = []
        for note in NOTES:
            file = pattern.format(note=note)
            url = f"{BASE}/{folder}/{urllib.parse.quote(file)}"
            x, rate = read_wav(urllib.request.urlopen(url).read())
            midi = label_midi(note) + 12  # VSCO : do central = C3
            onset = int(np.argmax(np.abs(x) > 0.02 * np.abs(x).max()))
            found = measured_midi(x, rate, onset)
            if abs(found - midi) > 0.6:
                raise SystemExit(f"{file} : hauteur mesurée {found:.2f}, attendue {midi}")
            x = x[max(0, onset - int(0.005 * rate)):][: int(keep * rate)]
            fade = int(0.25 * rate)
            x[-fade:] *= np.linspace(1, 0, fade)
            x *= 0.9 / np.abs(x).max()
            (OUT / f"{name}-{midi}.mp3").write_bytes(encode(x, rate))
            manifest[name].append(midi)
            print(f"{name} {note} → MIDI {midi} (mesuré {found:.2f}), {len(x) / rate:.1f} s")
    (OUT / "notes.json").write_text(json.dumps(manifest) + "\n")


if __name__ == "__main__":
    main()

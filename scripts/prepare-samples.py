#!/usr/bin/env python3
"""Prépare les sons enregistrés du lecteur (web/samples/<instrument>/).

Sources, toutes dans le domaine public (CC0) :
- VSCO 2 Community Edition (Versilian Studios) : https://github.com/sgossner/VSCO-2-CE
  trompette, flûte traversière, clarinette ;
- Versilian Community Sample Library (VCSL) : https://github.com/sgossner/VCSL
  piano à queue (Kawai), saxophone ténor.

Pour chaque instrument : une note tous les 2 à 4 demi-tons, tenue (« sus ») et, pour les vents,
piquée (« stac »). Chaque fichier est mis en mono, raccourci (fondu de fin), mis au même volume
et encodé en MP3. La hauteur de chaque fichier est mesurée (les noms de fichiers de ces banques
placent le do central en C3) : un fichier faux de plus de 0,6 demi-ton est écarté, un petit écart
est noté dans notes.json ([note MIDI, écart en centièmes]) et compensé par le lecteur.

Usage : python3 scripts/prepare-samples.py [instrument…]   (dépendances : numpy, lameenc)
"""
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import lameenc
import numpy as np

VSCO = "https://raw.githubusercontent.com/sgossner/VSCO-2-CE/440300901dfe9275fd84e0b7763af1f8443ae62e"
VCSL = "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
TREES = {
    VSCO: "https://api.github.com/repos/sgossner/VSCO-2-CE/git/trees/440300901dfe9275fd84e0b7763af1f8443ae62e?recursive=1",
    VCSL: "https://api.github.com/repos/sgossner/VCSL/git/trees/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e?recursive=1",
}

# Jeu de notes : dossier, préférences de suffixe (après le nom de note, par ordre), durée gardée (s).
INSTRUMENTS = {
    "trumpet": {
        "sus": (VSCO, "Brass/Trumpet/susvib/", ["v2_rr1"], 7.0),
        "stac": (VSCO, "Brass/Trumpet/stac/", ["v2_rr1"], 1.5),
    },
    "flute": {
        "sus": (VSCO, "Woodwinds/Flute/susvib/", ["v1_1"], 7.0),
        "stac": (VSCO, "Woodwinds/Flute/stac/", ["v2_rr1"], 1.5),
    },
    "clarinet": {
        "sus": (VSCO, "Woodwinds/Clarinet/susLong/", ["v2_rr1_sum"], 7.0),
        "stac": (VSCO, "Woodwinds/Clarinet/stac/", ["v2_rr1_sum", "v3_rr1_sum"], 1.5),
    },
    "sax": {
        "sus": (VCSL, "Aerophones/Reed Aerophones/Tenor Saxophone/Vibrato/", ["var2", "var3", "var1", "var4"], 7.0),
        "stac": (VCSL, "Aerophones/Reed Aerophones/Tenor Saxophone/Staccato/", ["vl2_", "vl1_"], 1.5),
    },
    "piano": {
        # Du do1 au do7 (piano complet inutile pour une mélodie), son qui s'éteint naturellement.
        "sus": (VCSL, "Chordophones/Zithers/Grand Piano, Kawai/Sustains/", ["v3_rr1"], 6.0, (36, 96)),
    },
}
OUT = Path(__file__).resolve().parent.parent / "web" / "samples"
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE = re.compile(r"_([A-G]#?)(-?\d)_(.*)\.wav$")
_trees = {}


def download(url):
    """Contenu d'une URL, avec quelques nouvelles tentatives (erreurs passagères de GitHub)."""
    for attempt in range(5):
        try:
            return urllib.request.urlopen(url, timeout=60).read()
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt == 4 or getattr(err, "code", 500) < 500:
                raise
            time.sleep(2 ** attempt)


def files(repo, folder):
    """Fichiers WAV d'un dossier de la banque : {midi: [(suffixe, chemin)]}."""
    if repo not in _trees:
        _trees[repo] = [t["path"] for t in json.loads(download(TREES[repo]))["tree"] if t["type"] == "blob"]
    found = {}
    for path in _trees[repo]:
        if not path.startswith(folder) or "/" in path[len(folder):]:
            continue
        m = NOTE.search(path)
        if m:
            midi = NAMES.index(m[1]) + 12 * (int(m[2]) + 1) + 12  # do central = C3
            found.setdefault(midi, []).append((m[3], path))
    return found


def read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        width, rate, channels = w.getsampwidth(), w.getframerate(), w.getnchannels()
        raw = w.readframes(w.getnframes())
    if width == 2:
        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        pcm = ((b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)) << 8 >> 8) / 8388608
    else:
        raise SystemExit(f"WAV {8 * width} bits non pris en charge")
    return pcm.reshape(-1, channels).mean(axis=1), rate


def measured_midi(x, rate, onset, window):
    """Hauteur mesurée (MIDI, fractionnaire) par autocorrélation, entre window[0] et window[1]
    secondes après l'attaque : premier pic proche du maximum, pour ne pas prendre une octave
    plus bas (sous-harmonique)."""
    seg = x[onset + int(window[0] * rate): onset + int(window[1] * rate)]
    seg = seg - seg.mean()
    corr = np.fft.irfft(np.abs(np.fft.rfft(seg, 2 * len(seg))) ** 2)[: len(seg)]
    lo, hi = int(rate / 2200), int(rate / 60)  # 60 Hz à 2200 Hz
    best = corr[lo:hi].max()
    lag = next(l for l in range(lo, hi) if corr[l] > 0.85 * best and corr[l] >= corr[l - 1] and corr[l] >= corr[l + 1])
    # Position du pic entre deux échantillons (précision dans l'aigu).
    a, b, c = corr[lag - 1], corr[lag], corr[lag + 1]
    lag += 0.5 * (a - c) / (a - 2 * b + c)
    return 69 + 12 * np.log2(rate / lag / 440)


def encode(x, rate):
    enc = lameenc.Encoder()
    enc.set_bit_rate(96)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    return enc.encode((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()) + enc.flush()


def prepare(name, sets):
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.mp3"):
        old.unlink()
    manifest = {}
    for set_name, (repo, folder, prefer, keep, *limits) in sets.items():
        lo, hi = limits[0] if limits else (0, 127)
        manifest[set_name] = []
        for midi, candidates in sorted(files(repo, folder).items()):
            if not lo <= midi <= hi:
                continue
            path = next((p for want in prefer for suffix, p in candidates if suffix.startswith(want)), None)
            if not path:
                continue
            x, rate = read_wav(download(f"{repo}/{urllib.parse.quote(path)}"))
            onset = int(np.argmax(np.abs(x) > 0.02 * np.abs(x).max()))
            # Notes tenues : partie stable (après l'attaque) ; piquées et piano : juste après l'attaque.
            window = (0.3, 1.0) if set_name == "sus" and name != "piano" else (0.04, 0.25)
            found = measured_midi(x, rate, onset, window) if midi >= 43 else None  # trop grave pour la mesure
            if found is not None and abs(found - midi) > 0.6:
                print(f"ÉCARTÉ {path} : hauteur mesurée {found:.2f}, attendue {midi}", file=sys.stderr)
                continue
            x = x[max(0, onset - int(0.005 * rate)):][: int(keep * rate)]
            fade = int(0.25 * rate)
            x[-fade:] *= np.linspace(1, 0, fade)
            # Même volume perçu (énergie du début : 0,5 s, ou 0,15 s pour une note piquée), sans saturer.
            loud = np.sqrt(np.mean(x[: int((0.15 if set_name == "stac" else 0.5) * rate)] ** 2))
            x *= min(0.2 / loud, 0.95 / np.abs(x).max())
            (out / f"{set_name}-{midi}.mp3").write_bytes(encode(x, rate))
            # Écart de justesse mesuré (centièmes de demi-ton), compensé à la lecture.
            manifest[set_name].append([midi, round((found - midi) * 100) if found is not None else 0])
            print(f"{name} {set_name} MIDI {midi}" + (f" (mesuré {found:.2f})" if found is not None else "") + f", {len(x) / rate:.1f} s")
    (out / "notes.json").write_text(json.dumps(manifest) + "\n")


def main():
    for name in sys.argv[1:] or INSTRUMENTS:
        prepare(name, INSTRUMENTS[name])


if __name__ == "__main__":
    main()

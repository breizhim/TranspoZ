"""Reconnaissance optique de partitions (OMR).

Deux moteurs libres sont pris en charge, appelés en ligne de commande :

* **Audiveris** (https://github.com/Audiveris/audiveris) — très bon sur les
  partitions imprimées, lit directement les PDF et les images ;
* **oemer** (https://github.com/BreezeWhite/oemer) — réseau de neurones, plus
  tolérant avec les photos prises au téléphone ; les PDF sont d'abord convertis
  en images.

Le moteur est choisi par la variable d'environnement ``OMR_ENGINE``
(``auto`` par défaut : Audiveris s'il est installé, sinon oemer).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from .musicxml import MusicXMLError, merge_scores, read_musicxml

TIMEOUT = int(os.environ.get("OMR_TIMEOUT", "600"))
PDF_DPI = int(os.environ.get("OMR_PDF_DPI", "300"))


class OMRError(RuntimeError):
    pass


def _natural_key(path: Path):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", str(path))]


def _run(cmd: list[str], cwd: Path) -> None:
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise OMRError("La reconnaissance a pris trop de temps.") from exc
    except OSError as exc:
        raise OMRError(f"Impossible de lancer {cmd[0]} : {exc}") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        raise OMRError("Échec de la reconnaissance : " + " / ".join(tail))


def rasterize_pdf(pdf: Path, outdir: Path, dpi: int = PDF_DPI) -> list[Path]:
    import fitz  # PyMuPDF

    images = []
    with fitz.open(pdf) as doc:
        for i, page in enumerate(doc, start=1):
            out = outdir / f"{pdf.stem}-p{i:03d}.png"
            page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY).save(out)
            images.append(out)
    if not images:
        raise OMRError("Le PDF ne contient aucune page.")
    return images


class Engine:
    name = "engine"

    def available(self) -> bool:  # pragma: no cover - dépend de l'installation
        raise NotImplementedError

    def recognize(self, path: Path, workdir: Path, time: tuple[int, int] | None = None) -> list[str]:
        """Reconnaît un fichier (PDF ou image) et retourne un MusicXML par page/mouvement.

        ``time`` (temps, unité), facultatif : chiffrage imposé à la reconnaissance.
        """
        raise NotImplementedError


class AudiverisEngine(Engine):
    name = "audiveris"

    def __init__(self) -> None:
        self.cmd = (
            os.environ.get("AUDIVERIS_CMD")
            or shutil.which("audiveris")
            or shutil.which("Audiveris")
            or next((p for p in ("/opt/audiveris/bin/Audiveris", "/opt/audiveris/bin/audiveris") if os.access(p, os.X_OK)), None)
        )

    def available(self) -> bool:
        return bool(self.cmd)

    def recognize(self, path: Path, workdir: Path, time: tuple[int, int] | None = None) -> list[str]:
        outdir = workdir / f"{path.stem}-audiveris"
        outdir.mkdir()
        if time:
            # Arrêt après la lecture des débuts de portée, chiffrage remplacé dans le
            # projet Audiveris, puis fin de l'analyse (exportée à côté du projet).
            _run([self.cmd, "-batch", "-save", "-step", "HEADERS", "-output", str(outdir), "--", str(path)], cwd=workdir)
            books = sorted(outdir.rglob("*.omr"))
            if not books:
                raise OMRError("Aucune portée n'a été reconnue (Audiveris n'a produit aucun projet).")
            force_time_in_book(books[0], *time)
            _run([self.cmd, "-batch", "-export", "-output", str(outdir), "--", str(books[0])], cwd=workdir)
        else:
            _run([self.cmd, "-batch", "-export", "-output", str(outdir), "--", str(path)], cwd=workdir)
        outputs = sorted(
            [p for p in outdir.rglob("*") if p.suffix.lower() in (".mxl", ".xml", ".musicxml")],
            key=_natural_key,
        )
        if not outputs:
            raise OMRError("Aucune portée n'a été reconnue (Audiveris n'a produit aucun fichier).")
        return [read_musicxml(p.read_bytes()) for p in outputs]


# ---------------------------------------------------------------------------
# Chiffrage imposé (même transformation que web/omr-time.js)
# ---------------------------------------------------------------------------

NUMBER_SHAPES = {
    0: "TIME_ZERO", 1: "TIME_ONE", 2: "TIME_TWO", 3: "TIME_THREE", 4: "TIME_FOUR", 5: "TIME_FIVE",
    6: "TIME_SIX", 7: "TIME_SEVEN", 8: "TIME_EIGHT", 9: "TIME_NINE", 12: "TIME_TWELVE", 16: "TIME_SIXTEEN",
}
WHOLE_SHAPES = {
    "2/2": "TIME_TWO_TWO", "2/4": "TIME_TWO_FOUR", "3/4": "TIME_THREE_FOUR", "4/4": "TIME_FOUR_FOUR",
    "5/4": "TIME_FIVE_FOUR", "6/4": "TIME_SIX_FOUR", "3/8": "TIME_THREE_EIGHT", "6/8": "TIME_SIX_EIGHT",
    "12/8": "TIME_TWELVE_EIGHT",
}
TIME_SYMBOLS = {"COMMON_TIME": "4/4", "CUT_TIME": "2/2"}


def parse_time(text: str | None) -> tuple[int, int] | None:
    """« 2/2 » → (2, 2) ; None si vide ou invalide."""
    m = re.fullmatch(r"\s*(\d{1,2})\s*/\s*(\d{1,2})\s*", text or "")
    if not m:
        return None
    beats, beat_type = int(m.group(1)), int(m.group(2))
    return (beats, beat_type) if beats > 0 and beat_type in (1, 2, 4, 8, 16, 32) else None


def _set_attr(tag: str, name: str, value) -> str:
    if re.search(rf'\s{name}="[^"]*"', tag):
        return re.sub(rf'(\s{name}=)"[^"]*"', lambda m: f'{m.group(1)}"{value}"', tag, count=1)
    return re.sub(r"^<([\w-]+)", lambda m: f'<{m.group(1)} {name}="{value}"', tag, count=1)


def force_time_in_sheet(xml: str, beats: int, beat_type: int) -> tuple[str, int]:
    """Remplace les chiffrages d'une page Audiveris (sheet#N.xml) ; retourne (xml, nombre modifié)."""
    rational = f"{beats}/{beat_type}"
    count = 0

    def whole(m: re.Match) -> str:
        nonlocal count
        count += 1
        tag = m.group(0)
        shape = (re.search(r'\sshape="([A-Z_]+)"', tag) or [None, None])[1]
        keep = TIME_SYMBOLS.get(shape) == rational
        tag = _set_attr(tag, "time-rational", rational)
        return _set_attr(tag, "shape", shape if keep else WHOLE_SHAPES.get(rational, "TIME_CUSTOM"))

    def pair(m: re.Match) -> str:
        nonlocal count
        tag = m.group(0)
        if not re.search(r'\stime-rational="', tag):
            return tag  # paire écartée par Audiveris
        count += 1
        return _set_attr(tag, "time-rational", rational)

    def number(m: re.Match) -> str:
        tag = m.group(0)
        value = beats if ' side="TOP"' in tag else beat_type if ' side="BOTTOM"' in tag else None
        if value is None:
            return tag
        return _set_attr(_set_attr(tag, "value", value), "shape", NUMBER_SHAPES.get(value, "TIME_CUSTOM"))

    xml = re.sub(r"<time-whole\b[^>]*>", whole, xml)
    xml = re.sub(r"<time-pair\b[^>]*>", pair, xml)
    xml = re.sub(r"<time-number\b[^>]*>", number, xml)
    return xml, count


def force_time_in_book(book: Path, beats: int, beat_type: int) -> int:
    """Applique le chiffrage à toutes les pages d'un projet Audiveris (.omr, archive zip)."""
    with zipfile.ZipFile(book) as zf:
        entries = [(info, zf.read(info.filename)) for info in zf.infolist()]
    count = 0
    with zipfile.ZipFile(book, "w", zipfile.ZIP_DEFLATED) as zf:
        for info, data in entries:
            if re.fullmatch(r"sheet#\d+/sheet#\d+\.xml", info.filename):
                text, n = force_time_in_sheet(data.decode("utf-8"), beats, beat_type)
                data, count = text.encode("utf-8"), count + n
            zf.writestr(info, data)
    return count


class OemerEngine(Engine):
    name = "oemer"

    def __init__(self) -> None:
        self.cmd = os.environ.get("OEMER_CMD") or shutil.which("oemer")

    def available(self) -> bool:
        return bool(self.cmd)

    def recognize(self, path: Path, workdir: Path, time: tuple[int, int] | None = None) -> list[str]:
        # oemer ne permet pas d'imposer le chiffrage : il est ajouté après coup par l'interface.
        images = rasterize_pdf(path, workdir) if path.suffix.lower() == ".pdf" else [path]
        results = []
        for image in images:
            outdir = workdir / f"{image.stem}-oemer"
            outdir.mkdir()
            _run([self.cmd, str(image), "-o", str(outdir)], cwd=workdir)
            outputs = sorted(outdir.glob("*.musicxml"), key=_natural_key)
            if not outputs:
                raise OMRError(f"Aucune portée reconnue sur {image.name}.")
            results.extend(read_musicxml(p.read_bytes()) for p in outputs)
        return results


ENGINES = {"audiveris": AudiverisEngine, "oemer": OemerEngine}


def get_engine(name: str | None = None) -> Engine | None:
    name = (name or os.environ.get("OMR_ENGINE", "auto")).lower()
    if name in ENGINES:
        engine = ENGINES[name]()
        return engine if engine.available() else None
    for cls in ENGINES.values():
        engine = cls()
        if engine.available():
            return engine
    return None


def available_engines() -> list[str]:
    return [name for name, cls in ENGINES.items() if cls().available()]


# ---------------------------------------------------------------------------
# Détection du type de fichier
# ---------------------------------------------------------------------------

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"}
MUSICXML_EXTENSIONS = {".musicxml", ".xml", ".mxl"}


def detect_kind(filename: str, data: bytes) -> str:
    """Retourne « pdf », « image » ou « musicxml »."""
    ext = Path(filename).suffix.lower()
    if data.startswith(b"%PDF"):
        return "pdf"
    if data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG") or data[:4] in (b"II*\x00", b"MM\x00*") or data[:2] == b"BM":
        return "image"
    if ext in MUSICXML_EXTENSIONS or data[:2] == b"PK" or b"<score-partwise" in data[:4096]:
        return "musicxml"
    if ext == ".pdf":
        return "pdf"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    raise OMRError(f"Format de fichier non reconnu : {filename}")


def recognize_files(
    files: list[tuple[str, bytes]], engine: Engine | None = None, time: tuple[int, int] | None = None
) -> tuple[str, dict]:
    """Transforme une liste de fichiers (dans l'ordre des pages) en un seul MusicXML.

    ``time`` : chiffrage (temps, unité) imposé à la reconnaissance, facultatif.
    """
    if not files:
        raise OMRError("Aucun fichier reçu.")
    scores: list[str] = []
    used_engine = None
    with tempfile.TemporaryDirectory(prefix="transpoz-") as tmp:
        workdir = Path(tmp)
        for index, (filename, data) in enumerate(files):
            kind = detect_kind(filename, data)
            if kind == "musicxml":
                try:
                    scores.append(read_musicxml(data))
                except MusicXMLError as exc:
                    raise OMRError(str(exc)) from exc
                continue
            if engine is None:
                engine = get_engine()
            if engine is None:
                raise OMRError(
                    "Aucun moteur de reconnaissance n'est installé sur le serveur "
                    "(Audiveris ou oemer). Vous pouvez importer directement un fichier MusicXML."
                )
            used_engine = engine.name
            suffix = Path(filename).suffix.lower() or (".pdf" if kind == "pdf" else ".png")
            safe = workdir / f"page{index:03d}{suffix}"
            safe.write_bytes(data)
            scores.extend(engine.recognize(safe, workdir, time=time) if time else engine.recognize(safe, workdir))
    try:
        merged = merge_scores(scores)
    except MusicXMLError as exc:
        raise OMRError(str(exc)) from exc
    return merged, {"engine": used_engine, "pages": len(scores)}

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

    def recognize(self, path: Path, workdir: Path) -> list[str]:
        """Reconnaît un fichier (PDF ou image) et retourne un MusicXML par page/mouvement."""
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

    def recognize(self, path: Path, workdir: Path) -> list[str]:
        outdir = workdir / f"{path.stem}-audiveris"
        outdir.mkdir()
        _run([self.cmd, "-batch", "-export", "-output", str(outdir), "--", str(path)], cwd=workdir)
        outputs = sorted(
            [p for p in outdir.rglob("*") if p.suffix.lower() in (".mxl", ".xml", ".musicxml")],
            key=_natural_key,
        )
        if not outputs:
            raise OMRError("Aucune portée n'a été reconnue (Audiveris n'a produit aucun fichier).")
        return [read_musicxml(p.read_bytes()) for p in outputs]


class OemerEngine(Engine):
    name = "oemer"

    def __init__(self) -> None:
        self.cmd = os.environ.get("OEMER_CMD") or shutil.which("oemer")

    def available(self) -> bool:
        return bool(self.cmd)

    def recognize(self, path: Path, workdir: Path) -> list[str]:
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


def recognize_files(files: list[tuple[str, bytes]], engine: Engine | None = None) -> tuple[str, dict]:
    """Transforme une liste de fichiers (dans l'ordre des pages) en un seul MusicXML."""
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
            scores.extend(engine.recognize(safe, workdir))
    try:
        merged = merge_scores(scores)
    except MusicXMLError as exc:
        raise OMRError(str(exc)) from exc
    return merged, {"engine": used_engine, "pages": len(scores)}

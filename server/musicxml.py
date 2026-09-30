"""Lecture (.musicxml / .xml / .mxl) et fusion de fichiers MusicXML."""

from __future__ import annotations

import copy
import io
import re
import zipfile
import xml.etree.ElementTree as ET


class MusicXMLError(ValueError):
    pass


def read_musicxml(data: bytes) -> str:
    """Retourne le texte MusicXML d'un fichier brut ou compressé (.mxl)."""
    if data[:2] == b"PK":
        return _read_mxl(data)
    text = data.decode("utf-8-sig", errors="replace")
    if "<score-partwise" not in text:
        if "<score-timewise" in text:
            raise MusicXMLError("Le format MusicXML « timewise » n'est pas pris en charge.")
        raise MusicXMLError("Ce fichier n'est pas une partition MusicXML.")
    return text


def _read_mxl(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            rootfile = None
            if "META-INF/container.xml" in names:
                container = ET.fromstring(zf.read("META-INF/container.xml"))
                for el in container.iter():
                    if el.tag.endswith("rootfile") and el.get("full-path"):
                        rootfile = el.get("full-path")
                        break
            if rootfile is None:
                candidates = [n for n in names if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF/")]
                if not candidates:
                    raise MusicXMLError("Archive .mxl sans partition.")
                rootfile = candidates[0]
            return read_musicxml(zf.read(rootfile))
    except zipfile.BadZipFile as exc:
        raise MusicXMLError("Archive .mxl invalide.") from exc


def _parse(text: str) -> ET.Element:
    # ElementTree ne gère pas le DOCTYPE externe : on l'ignore.
    text = re.sub(r"<!DOCTYPE[^>]*>", "", text, count=1)
    try:
        return ET.fromstring(text.encode("utf-8"))
    except ET.ParseError as exc:
        raise MusicXMLError(f"MusicXML invalide : {exc}") from exc


def _signature(el: ET.Element | None) -> str | None:
    return None if el is None else ET.tostring(el)


def merge_scores(scores: list[str]) -> str:
    """Concatène plusieurs partitions (pages reconnues séparément) en une seule.

    Les mesures de chaque partie sont ajoutées à la partie de même rang de la
    première partition, puis renumérotées. Les armures, métriques et clés
    répétées en début de page sont supprimées pour éviter des rappels inutiles.
    """
    if not scores:
        raise MusicXMLError("Aucune partition à fusionner.")
    if len(scores) == 1:
        return scores[0]

    base = _parse(scores[0])
    base_parts = base.findall("part")
    last_attrs: dict[int, dict[str, str | None]] = {}

    def remember(index: int, measure: ET.Element) -> None:
        state = last_attrs.setdefault(index, {})
        for attrs in measure.findall("attributes"):
            for name in ("key", "time", "clef"):
                el = attrs.find(name)
                if el is not None:
                    state[name] = _signature(el)

    for i, part in enumerate(base_parts):
        for measure in part.findall("measure"):
            remember(i, measure)

    for text in scores[1:]:
        other = _parse(text)
        for i, part in enumerate(other.findall("part")):
            if i >= len(base_parts):
                break
            target = base_parts[i]
            for j, measure in enumerate(part.findall("measure")):
                measure = copy.deepcopy(measure)
                if j == 0:
                    state = last_attrs.get(i, {})
                    for attrs in measure.findall("attributes"):
                        for name in ("key", "time", "clef"):
                            for el in attrs.findall(name):
                                if _signature(el) == state.get(name):
                                    attrs.remove(el)
                        if len(attrs) == 0:
                            measure.remove(attrs)
                remember(i, measure)
                target.append(measure)

    for part in base_parts:
        for n, measure in enumerate(part.findall("measure"), start=1):
            measure.set("number", str(n))

    body = ET.tostring(base, encoding="unicode")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + body


def score_title(text: str) -> str | None:
    root = _parse(text)
    for path in ("movement-title", "work/work-title"):
        el = root.find(path)
        if el is not None and (el.text or "").strip():
            return el.text.strip()
    for credit in root.findall("credit"):
        if (credit.findtext("credit-type") or "").strip() == "title":
            words = credit.findtext("credit-words")
            if words and words.strip():
                return words.strip()
    return None

"""Serveur web TranspoZ.

Lancement : ``uvicorn server.main:app --host 0.0.0.0 --port 8000``
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import omr
from .musicxml import score_title

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
OSMD_BUILD = ROOT / "node_modules" / "opensheetmusicdisplay" / "build"
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "25"))
MAX_FILES = 30
# Origines autorisées à appeler l'API (ex. le site GitHub Pages), séparées par des virgules.
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]

app = FastAPI(title="TranspoZ", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])


@app.get("/api/status")
def status() -> dict:
    engine = omr.get_engine()
    return {
        "engine": engine.name if engine else None,
        "engines": omr.available_engines(),
        "max_upload_mb": MAX_UPLOAD_MB,
    }


@app.post("/api/recognize")
def recognize(files: list[UploadFile] = File(...)) -> dict:
    """Reconnaît une partition (PDF, JPG, PNG — ou MusicXML déjà prêt).

    Plusieurs fichiers peuvent être envoyés : ils sont traités comme des pages
    successives du même morceau.
    """
    if len(files) > MAX_FILES:
        raise HTTPException(413, f"{MAX_FILES} fichiers au maximum.")
    payload: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        data = f.file.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
        total += len(data)
        if total > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"Fichiers trop volumineux (maximum {MAX_UPLOAD_MB} Mo).")
        if not data:
            raise HTTPException(400, f"Fichier vide : {f.filename}")
        payload.append((f.filename or "partition", data))
    try:
        musicxml, info = omr.recognize_files(payload)
    except omr.OMRError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        title = score_title(musicxml)
    except Exception:  # le titre est facultatif
        title = None
    return {"musicxml": musicxml, "title": title, **info}


if OSMD_BUILD.is_dir():
    app.mount("/vendor/osmd", StaticFiles(directory=OSMD_BUILD), name="osmd")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")

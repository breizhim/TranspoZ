import io
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import main, omr
from server.musicxml import merge_scores, read_musicxml, score_title

SAMPLE = (Path(__file__).parent.parent / "web" / "samples" / "au-clair-de-la-lune.musicxml").read_text()


def page(notes: str, key: int = 0) -> str:
    return (
        '<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1">'
        '<part-name>X</part-name></score-part></part-list><part id="P1"><measure number="1">'
        f"<attributes><divisions>1</divisions><key><fifths>{key}</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>"
        f"{notes}</measure></part></score-partwise>"
    )


NOTE = "<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>"


class FakeEngine(omr.Engine):
    name = "fake"

    def __init__(self):
        self.calls = []

    def available(self):
        return True

    def recognize(self, path, workdir):
        self.calls.append(path.suffix)
        return [page(NOTE)]


@pytest.fixture
def client():
    return TestClient(main.app)


def test_index_and_static(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "TranspoZ" in r.text
    assert client.get("/transpose.js").status_code == 200
    assert client.get("/samples/au-clair-de-la-lune.musicxml").status_code == 200


def test_status(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    assert "engines" in r.json()


def test_upload_musicxml(client):
    r = client.post("/api/recognize", files={"files": ("clair.musicxml", SAMPLE.encode(), "application/xml")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Au clair de la lune"
    assert body["engine"] is None
    assert "<score-partwise" in body["musicxml"]


def test_upload_mxl(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>',
        )
        zf.writestr("score.xml", SAMPLE)
    r = client.post("/api/recognize", files={"files": ("clair.mxl", buf.getvalue(), "application/octet-stream")})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "Au clair de la lune"


def test_pdf_and_images_go_through_engine(client, monkeypatch):
    engine = FakeEngine()
    monkeypatch.setattr(omr, "get_engine", lambda name=None: engine)
    files = [
        ("files", ("p1.pdf", b"%PDF-1.4 fake", "application/pdf")),
        ("files", ("p2.jpg", b"\xff\xd8\xff\xe0 fake", "image/jpeg")),
    ]
    r = client.post("/api/recognize", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["engine"] == "fake"
    assert body["pages"] == 2
    assert engine.calls == [".pdf", ".jpg"]
    assert body["musicxml"].count("<measure ") == 2


def test_no_engine_gives_clear_error(client, monkeypatch):
    monkeypatch.setattr(omr, "get_engine", lambda name=None: None)
    r = client.post("/api/recognize", files={"files": ("p.png", b"\x89PNG fake", "image/png")})
    assert r.status_code == 422
    assert "moteur" in r.json()["detail"]


def test_invalid_file(client):
    r = client.post("/api/recognize", files={"files": ("notes.txt", b"hello", "text/plain")})
    assert r.status_code == 422


def test_merge_scores_renumbers_and_dedupes_attributes():
    merged = merge_scores([page(NOTE), page(NOTE), page(NOTE, key=2)])
    assert merged.count("<measure ") == 3
    assert 'number="3"' in merged
    # La 2e page répète la même armure/métrique/clé : supprimées ; la 3e change d'armure.
    assert merged.count("<time>") == 1
    assert merged.count("<key>") == 2
    assert merged.count("<divisions>") == 3


def test_read_musicxml_rejects_other_xml():
    with pytest.raises(ValueError):
        read_musicxml(b"<html></html>")


def test_score_title_from_credit():
    xml = page(NOTE).replace(
        "<part-list>",
        "<credit page=\"1\"><credit-type>title</credit-type><credit-words>Valse</credit-words></credit><part-list>",
    )
    assert score_title(xml) == "Valse"


def test_rasterize_pdf(tmp_path):
    fitz = pytest.importorskip("fitz")
    pdf = tmp_path / "doc.pdf"
    doc = fitz.open()
    doc.new_page()
    doc.new_page()
    doc.save(pdf)
    images = omr.rasterize_pdf(pdf, tmp_path, dpi=50)
    assert [p.name for p in images] == ["doc-p001.png", "doc-p002.png"]


def test_cors_allows_external_site(client):
    r = client.get("/api/status", headers={"Origin": "https://breizhim.github.io"})
    assert r.headers.get("access-control-allow-origin") in ("*", "https://breizhim.github.io")

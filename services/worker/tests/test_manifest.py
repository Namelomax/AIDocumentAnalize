from datetime import date
from pathlib import Path
import json
from app.domain.manifest import parse_manifest

FIXTURES = Path(__file__).parent / "fixtures"


def test_parses_csv_manifest():
    raw = (FIXTURES / "manifest_sample.csv").read_bytes()
    result = parse_manifest(raw, "manifest_sample.csv")

    assert result.errors == []
    assert len(result.entries) == 2
    first = result.entries[0]
    assert first.file_name == "ar-01.pdf"
    assert first.doc_stage == "PD"
    assert first.approval_status == "APPROVED"
    assert first.approval_date == date(2026, 1, 15)


def test_parses_json_manifest():
    payload = json.dumps([{
        "object_id": "OBJ-001", "file_name": "kr.pdf", "doc_stage": "PD",
        "discipline": "КР", "document_code": "X-КР", "revision": "1",
        "approval_status": "APPROVED", "approval_date": "2026-02-01",
    }]).encode()
    result = parse_manifest(payload, "manifest.json")

    assert result.errors == []
    assert result.entries[0].discipline == "КР"


def test_accepts_russian_column_headers():
    raw = "Объект;Имя файла;Стадия\nOBJ-1;a.pdf;PD\n".encode("utf-8")
    result = parse_manifest(raw, "reestr.csv")

    assert result.errors == []
    assert result.entries[0].file_name == "a.pdf"
    assert result.entries[0].doc_stage == "PD"


def test_reports_unknown_stage_as_error():
    raw = "object_id,file_name,doc_stage\nOBJ-1,a.pdf,ПРОЕКТ\n".encode()
    result = parse_manifest(raw, "m.csv")

    assert result.entries == []
    assert any("doc_stage" in e for e in result.errors)


def test_reports_missing_required_column():
    raw = "object_id,revision\nOBJ-1,1\n".encode()
    result = parse_manifest(raw, "m.csv")

    assert any("file_name" in e for e in result.errors)

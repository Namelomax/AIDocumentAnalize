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


def test_json_row_without_a_required_key_does_not_kill_the_parse():
    # ключи в JSON-записях не обязаны совпадать: вторая запись без file_name
    # должна дать ошибку строки, а не уронить разбор целиком
    payload = json.dumps([
        {"object_id": "OBJ-1", "file_name": "a.pdf", "doc_stage": "PD"},
        {"object_id": "OBJ-2", "doc_stage": "PD"},
    ]).encode()
    result = parse_manifest(payload, "m.json")

    assert len(result.entries) == 1
    assert result.entries[0].file_name == "a.pdf"
    assert any("row 3" in e and "file_name" in e for e in result.errors)


def test_unrecognised_approval_date_is_reported_not_swallowed():
    # дата утверждения решает, какая из двух редакций актуальна.
    # Молча потерять её нельзя.
    raw = ("object_id,file_name,doc_stage,approval_date\n"
           "OBJ-1,a.pdf,PD,15 January 2026\n").encode()
    result = parse_manifest(raw, "m.csv")

    assert any("approval_date" in e for e in result.errors)


def test_non_breaking_space_in_header_is_normalised():
    raw = "object_id,file name,doc_stage\nOBJ-1,a.pdf,PD\n".encode("utf-8")
    result = parse_manifest(raw, "m.csv")

    assert result.errors == []
    assert result.entries[0].file_name == "a.pdf"


def test_two_columns_meaning_the_same_field_are_rejected():
    # 'revision' и 'изм' — синонимы одного поля. Молча взять одно из двух
    # значений значит потерять второе без следа.
    raw = ("object_id,file_name,doc_stage,revision,изм\n"
           "OBJ-1,a.pdf,PD,7,9\n").encode("utf-8")
    result = parse_manifest(raw, "m.csv")

    assert result.entries == []
    assert any("revision" in e for e in result.errors)

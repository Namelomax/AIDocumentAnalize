"""Tests for the process.start pipeline.

Driven entirely by fakes standing in for app.db.Database and
app.storage.ManifestStorage: no real PostgreSQL or MinIO is touched here.
"""

import json
import logging
from datetime import date, datetime
from pathlib import Path

import pytest

from app.db import FileRow, ProcessRow
from app.pipeline import process_start

FIXTURES = Path(__file__).parent / "fixtures"


def mk_process(**overrides):
    defaults = dict(
        id="p1",
        object_id="o1",
        status="PARSING",
        scenario=None,
        pd_completeness=None,
        rd_completeness=None,
        id_completeness=None,
        manifest_uploaded=False,
        input_manifest_hash=None,
        updated_at=datetime(2026, 1, 1),
    )
    defaults.update(overrides)
    return ProcessRow(**defaults)


def mk_file(**overrides):
    defaults = dict(
        id="f1",
        object_id="o1",
        process_id="p1",
        file_name="a.pdf",
        file_hash="hash-a",
        storage_key="key-a",
        size_bytes=100,
        mime_type="application/pdf",
        doc_stage=None,
        discipline=None,
        document_code=None,
        revision=None,
        approval_status="DRAFT",
        approval_date=None,
        sheet_page_range=None,
        predecessor_id=None,
        signature_status=None,
        page_count=None,
        from_manifest=False,
        uploaded_at=datetime(2026, 1, 1),
    )
    defaults.update(overrides)
    return FileRow(**defaults)


class FakeDb:
    def __init__(self, process, files):
        self._process = process
        self._files = files
        self.updates: dict[str, dict] = {}
        self.saved: dict | None = None

    async def get_process(self, process_id):
        return self._process

    async def get_files(self, process_id):
        return list(self._files)

    async def update_file_metadata(self, file_id, **fields):
        self.updates[file_id] = fields

    async def save_processing_result(self, process_id, **fields):
        self.saved = fields


class FakeStorage:
    def __init__(self, objects: dict[str, bytes]):
        self._objects = objects

    async def get_object(self, storage_key: str) -> bytes:
        return self._objects[storage_key]


@pytest.mark.asyncio
async def test_manifest_package_writes_metadata_completeness_and_scenario():
    process = mk_process(manifest_uploaded=True, input_manifest_hash="manifest-hash")
    manifest_row = mk_file(id="f-manifest", file_name="manifest_sample.csv",
                            file_hash="manifest-hash", storage_key="key-manifest",
                            mime_type="text/csv")
    ar = mk_file(id="f-ar", file_name="ar-01.pdf", storage_key="key-ar", file_hash="hash-ar")
    ov = mk_file(id="f-ov", file_name="ov1.pdf", storage_key="key-ov", file_hash="hash-ov")
    db = FakeDb(process, [manifest_row, ar, ov])
    storage = FakeStorage({"key-manifest": (FIXTURES / "manifest_sample.csv").read_bytes()})

    await process_start("p1", db, storage)

    assert db.updates["f-ar"]["doc_stage"] == "PD"
    assert db.updates["f-ar"]["approval_status"] == "APPROVED"
    assert db.updates["f-ar"]["approval_date"] == date(2026, 1, 15)
    assert db.updates["f-ov"]["doc_stage"] == "RD"
    assert db.updates["f-ov"]["approval_status"] == "FOR_CONSTRUCTION"

    assert db.saved["pd_completeness"] == "UPLOADED"
    assert db.saved["rd_completeness"] == "UPLOADED"
    assert db.saved["id_completeness"] == "NOT_APPLICABLE"
    assert db.saved["scenario"] == "PD_RD_ONLY"
    assert db.saved["status"] == "READY"
    # The registry row itself must never be treated as a document.
    assert "f-manifest" not in db.updates


@pytest.mark.asyncio
async def test_package_without_manifest_completes_with_missing_completeness_and_no_scenario():
    process = mk_process(manifest_uploaded=False, input_manifest_hash=None)
    files = [mk_file(id="f1", file_name="a.pdf"), mk_file(id="f2", file_name="b.pdf")]
    db = FakeDb(process, files)
    storage = FakeStorage({})

    await process_start("p1", db, storage)

    # doc_stage is unknown for every file, so every stage is MISSING, not
    # NOT_APPLICABLE: there is no registry declaring the stage out of scope.
    assert db.saved["pd_completeness"] == "MISSING"
    assert db.saved["rd_completeness"] == "MISSING"
    assert db.saved["id_completeness"] == "MISSING"
    assert db.saved["scenario"] is None
    assert db.saved["status"] == "READY"
    assert db.updates == {}


@pytest.mark.asyncio
async def test_unparseable_manifest_logs_warning_and_still_completes(caplog):
    process = mk_process(manifest_uploaded=True, input_manifest_hash="bad-hash")
    manifest_row = mk_file(id="f-manifest", file_name="broken.csv",
                            file_hash="bad-hash", storage_key="key-broken")
    doc = mk_file(id="f-doc", file_name="a.pdf")
    db = FakeDb(process, [manifest_row, doc])
    storage = FakeStorage({"key-broken": b""})

    with caplog.at_level(logging.WARNING, logger="app.pipeline"):
        await process_start("p1", db, storage)

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert any(r.msg == "manifest parse issue" for r in warnings)
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_unreadable_manifest_reports_stages_missing_not_inapplicable():
    """An unreadable registry must not downgrade an absent stage to NOT_APPLICABLE.

    NOT_APPLICABLE says the stage does not apply to this object, which only a
    registry that was actually read can establish. Saying it because the
    registry failed to parse would state more than the data supports.
    """
    process = mk_process(manifest_uploaded=True, input_manifest_hash="bad-hash")
    manifest_row = mk_file(id="f-manifest", file_name="broken.csv",
                           file_hash="bad-hash", storage_key="key-broken")
    doc = mk_file(id="f-doc", file_name="a.pdf")
    db = FakeDb(process, [manifest_row, doc])
    storage = FakeStorage({"key-broken": b""})

    await process_start("p1", db, storage)

    assert db.saved["pd_completeness"] == "MISSING"
    assert db.saved["rd_completeness"] == "MISSING"
    assert db.saved["id_completeness"] == "MISSING"
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_predecessor_referencing_unknown_file_is_not_invented(caplog):
    process = mk_process(manifest_uploaded=True, input_manifest_hash="manifest-hash")
    manifest_row = mk_file(id="f-manifest", file_name="reestr.json",
                            file_hash="manifest-hash", storage_key="key-manifest")
    doc = mk_file(id="f-doc", file_name="ar-02.pdf", storage_key="key-doc")
    db = FakeDb(process, [manifest_row, doc])

    manifest_json = json.dumps([{
        "object_id": "o1", "file_name": "ar-02.pdf", "doc_stage": "PD",
        "approval_status": "APPROVED", "predecessor_id": "ar-01.pdf",
    }]).encode()
    storage = FakeStorage({"key-manifest": manifest_json})

    with caplog.at_level(logging.WARNING, logger="app.pipeline"):
        await process_start("p1", db, storage)

    assert db.updates["f-doc"]["predecessor_id"] is None
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert any(r.msg == "manifest predecessor not found" for r in warnings)
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_source_selection_picks_the_current_revision_not_the_superseded_one(caplog):
    process = mk_process(manifest_uploaded=True, input_manifest_hash="manifest-hash")
    manifest_row = mk_file(id="f-manifest", file_name="reestr.json",
                            file_hash="manifest-hash", storage_key="key-manifest")
    old = mk_file(id="f-old", file_name="ar-01-rev1.pdf")
    new = mk_file(id="f-new", file_name="ar-01-rev2.pdf")
    db = FakeDb(process, [manifest_row, old, new])

    manifest_json = json.dumps([
        {"object_id": "o1", "file_name": "ar-01-rev1.pdf", "doc_stage": "PD",
         "approval_status": "APPROVED", "revision": "1"},
        {"object_id": "o1", "file_name": "ar-01-rev2.pdf", "doc_stage": "PD",
         "approval_status": "APPROVED", "revision": "2",
         "predecessor_id": "ar-01-rev1.pdf"},
    ]).encode()
    storage = FakeStorage({"key-manifest": manifest_json})

    with caplog.at_level(logging.INFO, logger="app.pipeline"):
        await process_start("p1", db, storage)

    selections = [r for r in caplog.records
                  if r.msg == "source selection" and r.stage == "PD"]
    assert len(selections) == 1
    assert selections[0].selection_status == "COMPLETE"
    assert selections[0].file_id == "f-new"
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_process_not_found_does_not_raise():
    db = FakeDb(None, [])
    storage = FakeStorage({})

    await process_start("missing", db, storage)

    assert db.saved is None

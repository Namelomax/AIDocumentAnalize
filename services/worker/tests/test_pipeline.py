"""Tests for the process.start pipeline.

Driven entirely by fakes standing in for app.db.Database and
app.storage.ManifestStorage: no real PostgreSQL or MinIO is touched here.
"""

import http.server
import json
import logging
import threading
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import pymupdf
import pytest

from app.config import Config
from app.db import FileRow, ProcessRow
from app.pipeline import input_manifest_hash, process_start

FIXTURES = Path(__file__).parent / "fixtures"

# Stands in for the config passed alongside db and storage; only the two
# version fields the pipeline reads are exercised here, the rest are unused
# placeholders required by the dataclass.
CONFIG = Config(
    database_url="", rabbitmq_url="", log_level="INFO", minio_endpoint="",
    minio_root_user="", minio_root_password="", minio_bucket="",
    model_version="rules-2026.09", dataset_version="none",
    llm_base_url="", llm_model="", llm_timeout_s=60.0,
)


def _one_page_pdf(text: str, rotation: int = 0) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    if text:
        page.insert_text((20, 40), text, fontsize=24)
    page.set_rotation(rotation)
    raw = document.tobytes()
    document.close()
    return raw


def _room_sheet_pdf(number: str, area: str) -> bytes:
    """A one-room, one-page sheet: a CAD-style plan label, number then area
    on their own lines - the shape app.explication.parse's Detector 1 reads."""
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    page.insert_htmlbox(pymupdf.Rect(20, 20, 200, 80), f"<p>{number}<br>{area}</p>")
    raw = document.tobytes()
    document.close()
    return raw


def _floor_sheet_pdf(number: str, area: str, total: str) -> bytes:
    """A one-room sheet that also carries a floor total line.

    The label and the value of the total are two separate insert_htmlbox
    calls at the same height: app.explication.parse.find_floor_totals pairs
    a label with a value line by row position, not by block, the same way a
    real explication table's own cells routinely land in separate PyMuPDF
    blocks that merely share a horizontal. insert_htmlbox is used rather than
    insert_text because the base-14 "helv" font has no Cyrillic glyphs on
    this platform and would silently corrupt "Общий итог по этажу".
    """
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    page.insert_htmlbox(pymupdf.Rect(20, 20, 200, 80), f"<p>{number}<br>{area}</p>")
    page.insert_htmlbox(pymupdf.Rect(20, 200, 220, 220), "Общий итог по этажу",
                         css="* {font-size:14px;}")
    page.insert_htmlbox(pymupdf.Rect(250, 200, 350, 220), total, css="* {font-size:14px;}")
    raw = document.tobytes()
    document.close()
    return raw


def _named_room_sheet_pdf(number: str, area: str, name: str) -> bytes:
    """Like _room_sheet_pdf, but with a third line Detector 1 reads as the
    room's name (app.explication.parse: "any number of leftover lines are
    joined as the name") - room-function comparison needs a name on both
    sheets, which the bare number+area fixture never has.
    """
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    page.insert_htmlbox(pymupdf.Rect(20, 20, 200, 100), f"<p>{number}<br>{area}<br>{name}</p>")
    raw = document.tobytes()
    document.close()
    return raw


class _FakeLlmServer:
    """A one-test /chat/completions endpoint, in the shape of
    test_llm_provider.py's own fake server. The pipeline is driven through a
    real ChatProvider pointed at this local server, not a hand-rolled stand-in
    for it, so these tests exercise the same request/parse path a live LM
    Studio run does - only the network address differs.
    """

    def __init__(self, handler_fn):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):  # keep pytest output quiet
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                status, response_body = handler_fn(body)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(response_body)

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def _llm_config(base_url: str) -> Config:
    return Config(
        database_url="", rabbitmq_url="", log_level="INFO", minio_endpoint="",
        minio_root_user="", minio_root_password="", minio_bucket="",
        model_version="rules-2026.09", dataset_version="none",
        llm_base_url=base_url, llm_model="fake-model", llm_timeout_s=5.0,
    )


def _openai_response(content: str) -> bytes:
    return json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")


def _requested_name_pairs(body: bytes) -> list[dict]:
    """Pull the [{"key": ..., "pd_name": ..., "rd_name": ...}, ...] array
    app.explication.functions embeds in its user prompt back out of the
    request body, so a fake handler can answer with the keys actually asked
    for instead of guessing at app.pipeline's own numbering scheme.
    """
    request = json.loads(body)
    user_content = request["messages"][1]["content"]
    start = user_content.index("[")
    return json.loads(user_content[start:])


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


@dataclass
class _FakePageLine:
    page_no: int
    block_no: int
    line_no: int
    text: str
    x0: float
    y0: float
    x1: float
    y1: float


class FakeDb:
    def __init__(self, process, files):
        self._process = process
        self._files = files
        self.updates: dict[str, dict] = {}
        self.saved: dict | None = None
        self.saved_pages: dict[str, list[dict]] = {}
        self.saved_checks: list[dict] | None = None
        self.protocol_calls: list[dict] = []
        self._protocol_versions: dict[str, int] = {}

    async def get_process(self, process_id):
        return self._process

    async def get_files(self, process_id):
        return list(self._files)

    async def update_file_metadata(self, file_id, **fields):
        self.updates[file_id] = fields

    async def save_processing_result(self, process_id, **fields):
        self.saved = fields

    async def save_pages(self, file_id, pages):
        self.saved_pages[file_id] = pages

    async def get_page_lines(self, file_id):
        # Real storage keeps one row per PDF line; this rebuilds that same
        # flat shape out of whatever save_pages recorded for the file, so the
        # fake round-trips exactly like the database it stands in for.
        pages = self.saved_pages.get(file_id, [])
        return [
            _FakePageLine(
                page_no=page["page_no"], block_no=block["block_no"], line_no=block["line_no"],
                text=block["text"], x0=block["x0"], y0=block["y0"], x1=block["x1"], y1=block["y1"],
            )
            for page in pages
            for block in page["blocks"]
        ]

    async def save_checks(self, process_id, object_id, checks):
        self.saved_checks = checks

    async def create_protocol(self, process_id, object_id, matrix_version,
                               model_version, dataset_version, input_manifest_hash):
        # Fake mirrors the real per-object counter (app.db.Database.create_protocol)
        # closely enough for tests that assert on the version number.
        version = self._protocol_versions.get(object_id, 0) + 1
        self._protocol_versions[object_id] = version
        self.protocol_calls.append({
            "process_id": process_id, "object_id": object_id,
            "matrix_version": matrix_version, "model_version": model_version,
            "dataset_version": dataset_version,
            "input_manifest_hash": input_manifest_hash,
            "version": version,
        })
        return version


class FakeStorage:
    def __init__(self, objects: dict[str, bytes]):
        self._objects = objects

    async def get_object(self, storage_key: str) -> bytes:
        return self._objects[storage_key]

    async def put_object(self, storage_key: str, data: bytes, content_type: str) -> None:
        self._objects[storage_key] = data


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

    await process_start("p1", db, storage, CONFIG)

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

    await process_start("p1", db, storage, CONFIG)

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
        await process_start("p1", db, storage, CONFIG)

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

    await process_start("p1", db, storage, CONFIG)

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
        await process_start("p1", db, storage, CONFIG)

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
         "document_code": "AR-01", "approval_status": "APPROVED", "revision": "1"},
        {"object_id": "o1", "file_name": "ar-01-rev2.pdf", "doc_stage": "PD",
         "document_code": "AR-01", "approval_status": "APPROVED", "revision": "2",
         "predecessor_id": "ar-01-rev1.pdf"},
    ]).encode()
    storage = FakeStorage({"key-manifest": manifest_json})

    with caplog.at_level(logging.INFO, logger="app.pipeline"):
        await process_start("p1", db, storage, CONFIG)

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

    await process_start("missing", db, storage, CONFIG)

    assert db.saved is None


@pytest.mark.asyncio
async def test_pdf_documents_get_their_pages_extracted():
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="ar-01.pdf", storage_key="key-doc",
                  mime_type="application/pdf")
    db = FakeDb(process, [doc])
    storage = FakeStorage({"key-doc": _one_page_pdf("Площадь застройки")})

    await process_start("p1", db, storage, CONFIG)

    assert "f-doc" in db.saved_pages
    page = db.saved_pages["f-doc"][0]
    assert page["page_no"] == 1
    assert page["blocks"]
    assert "line_no" in page["blocks"][0]
    assert page["image_key"]


@pytest.mark.asyncio
async def test_a_file_that_is_not_a_pdf_is_left_alone():
    """Only PDFs have a text layer to read; the registry itself is not a document."""
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="note.xml", storage_key="key-doc",
                  mime_type="application/xml")
    db = FakeDb(process, [doc])
    storage = FakeStorage({"key-doc": b"<root/>"})

    await process_start("p1", db, storage, CONFIG)

    assert db.saved_pages == {}
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_one_unreadable_pdf_does_not_stop_the_package():
    """A broken file is a data quality statement, not a reason to strand the rest."""
    process = mk_process(manifest_uploaded=False)
    good = mk_file(id="f-good", file_name="a.pdf", storage_key="key-good",
                   mime_type="application/pdf")
    bad = mk_file(id="f-bad", file_name="b.pdf", storage_key="key-bad",
                  mime_type="application/pdf")
    db = FakeDb(process, [good, bad])
    storage = FakeStorage({"key-good": _one_page_pdf("текст"), "key-bad": b"not a pdf"})

    await process_start("p1", db, storage, CONFIG)

    assert "f-good" in db.saved_pages
    assert "f-bad" not in db.saved_pages
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_room_area_change_produces_one_candidate_and_the_rest_not_comparable():
    """The full loop: extraction, comparison, and one checks row per parameter."""
    process = mk_process(manifest_uploaded=False)
    pd = mk_file(id="f-pd", file_name="pd.pdf", storage_key="key-pd",
                 mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                 approval_status="APPROVED")
    rd = mk_file(id="f-rd", file_name="rd.pdf", storage_key="key-rd",
                 mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                 approval_status="FOR_CONSTRUCTION")
    db = FakeDb(process, [pd, rd])
    storage = FakeStorage({
        "key-pd": _room_sheet_pdf("1.1", "10,00"),
        "key-rd": _room_sheet_pdf("1.1", "12,50"),
    })

    await process_start("p1", db, storage, CONFIG)

    assert db.saved["status"] == "READY"
    checks = db.saved_checks
    assert checks is not None

    m003_candidates = [
        c for c in checks if c["param_code"] == "M-003" and c["finding_status"] == "CANDIDATE"
    ]
    assert len(m003_candidates) == 1
    candidate = m003_candidates[0]
    assert candidate["subject"] == "room 1.1"
    assert len(candidate["fragments"]) == 2
    assert {f["role"] for f in candidate["fragments"]} == {"expected", "actual"}

    other_not_comparable = [
        c for c in checks if c["param_code"] != "M-003" and c["completeness_status"] == "NOT_COMPARABLE"
    ]
    assert len(other_not_comparable) == 131


def _room_function_package():
    """One PD/RD pair, one room, same number and area, different name -
    the shape every SEM-ROOM-FN test below needs, built once so the three
    scenarios (a verdict, no provider, an unavailable model) only differ in
    what they hand process_start as its config.
    """
    process = mk_process(manifest_uploaded=False)
    pd = mk_file(id="f-pd", file_name="pd.pdf", storage_key="key-pd",
                 mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                 approval_status="APPROVED")
    rd = mk_file(id="f-rd", file_name="rd.pdf", storage_key="key-rd",
                 mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                 approval_status="FOR_CONSTRUCTION")
    db = FakeDb(process, [pd, rd])
    storage = FakeStorage({
        "key-pd": _named_room_sheet_pdf("1.1", "10,00", "Техническое помещение"),
        "key-rd": _named_room_sheet_pdf("1.1", "10,00", "Склад ГСМ"),
    })
    return db, storage


@pytest.mark.asyncio
async def test_changed_room_function_produces_one_suspicion_with_two_fragments():
    """Task 4, step 1: a room whose name changed function, and a fake model
    that agrees - one SUSPICION check, never a CANDIDATE (Global Constraint:
    a hypothesis is not a violation)."""
    db, storage = _room_function_package()

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [
            {"key": p["key"], "same_function": False, "confidence": 0.9,
             "reason": "было техническое помещение, стало складом ГСМ"}
            for p in pairs
        ]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        await process_start("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert db.saved["status"] == "READY"
    checks = db.saved_checks
    sem_checks = [c for c in checks if c["param_code"] == "SEM-ROOM-FN"]
    assert len(sem_checks) == 1
    suspicion = sem_checks[0]
    assert suspicion["finding_status"] == "SUSPICION"
    assert suspicion["completeness_status"] == "COMPLETE"
    assert suspicion["detection_method"] == "SEMANTIC"
    assert suspicion["confidence"] == 0.9
    assert suspicion["expected_value"] == "Техническое помещение"
    assert suspicion["actual_value"] == "Склад ГСМ"
    assert "Техническое помещение" in suspicion["rationale"]
    assert "Склад ГСМ" in suspicion["rationale"]
    assert len(suspicion["fragments"]) == 2
    assert {f["role"] for f in suspicion["fragments"]} == {"expected", "actual"}
    # A hypothesis is never a candidate: M-003 itself may still report on
    # this same room (its area did not change here, so it does not), but
    # nothing from SEM-ROOM-FN ever carries CANDIDATE.
    assert not any(c["finding_status"] == "CANDIDATE" for c in sem_checks)


@pytest.mark.asyncio
async def test_room_function_without_a_provider_is_not_comparable():
    """No LLM_BASE_URL configured: honest refusal, never a guess (Global
    Constraint: the system works without a model)."""
    db, storage = _room_function_package()

    await process_start("p1", db, storage, CONFIG)  # CONFIG's llm_base_url is ""

    assert db.saved["status"] == "READY"
    checks = db.saved_checks
    sem_checks = [c for c in checks if c["param_code"] == "SEM-ROOM-FN"]
    assert len(sem_checks) == 1
    assert sem_checks[0]["completeness_status"] == "NOT_COMPARABLE"
    assert sem_checks[0]["finding_status"] is None
    assert sem_checks[0]["rationale"] == (
        "Языковая модель не подключена: сравнение назначений помещений не выполнялось"
    )


@pytest.mark.asyncio
async def test_room_function_model_unavailable_still_reaches_ready():
    """The model answers something that is not JSON: LlmUnavailable, caught
    the same way an unconfigured provider is - never a lost package."""
    db, storage = _room_function_package()

    def handler(body: bytes):
        return 200, _openai_response("прошу прощения, не могу ответить")

    server = _FakeLlmServer(handler)
    try:
        await process_start("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert db.saved["status"] == "READY"
    checks = db.saved_checks
    sem_checks = [c for c in checks if c["param_code"] == "SEM-ROOM-FN"]
    assert len(sem_checks) == 1
    assert sem_checks[0]["completeness_status"] == "NOT_COMPARABLE"
    assert sem_checks[0]["finding_status"] is None
    assert sem_checks[0]["rationale"]  # carries LlmUnavailable's own reason


@pytest.mark.asyncio
async def test_evidence_group_ids_stay_unique_across_two_floor_pairs():
    """Two PD/RD floor pairs, each with its own changed floor total.

    "floor total" is the same literal subject on every floor; a group id
    built from the subject alone collides the moment a package has more than
    one comparable floor, and save_checks writes every check of a process in
    one transaction - one collision there would lose the whole protocol, not
    just the second floor.
    """
    process = mk_process(manifest_uploaded=False)
    files = [
        mk_file(id="f-pd1", file_name="pd1.pdf", storage_key="key-pd1",
                mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                approval_status="APPROVED"),
        mk_file(id="f-rd1", file_name="rd1.pdf", storage_key="key-rd1",
                mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                approval_status="FOR_CONSTRUCTION"),
        mk_file(id="f-pd2", file_name="pd2.pdf", storage_key="key-pd2",
                mime_type="application/pdf", doc_stage="PD", document_code="AR-02",
                approval_status="APPROVED"),
        mk_file(id="f-rd2", file_name="rd2.pdf", storage_key="key-rd2",
                mime_type="application/pdf", doc_stage="RD", document_code="AR-02",
                approval_status="FOR_CONSTRUCTION"),
    ]
    db = FakeDb(process, files)
    storage = FakeStorage({
        "key-pd1": _floor_sheet_pdf("1.1", "10,00", "100,00"),
        "key-rd1": _floor_sheet_pdf("1.1", "10,00", "120,00"),
        "key-pd2": _floor_sheet_pdf("2.1", "10,00", "200,00"),
        "key-rd2": _floor_sheet_pdf("2.1", "10,00", "220,00"),
    })

    await process_start("p1", db, storage, CONFIG)

    assert db.saved["status"] == "READY"
    checks = db.saved_checks
    assert checks is not None

    floor_total_candidates = [
        c for c in checks
        if c["param_code"] == "M-003" and c["subject"] == "floor total"
        and c["finding_status"] == "CANDIDATE"
    ]
    # Both floors must actually be answered for the uniqueness check below to
    # mean anything - two candidates that silently collapsed into one row
    # would trivially "have unique ids" too.
    assert len(floor_total_candidates) == 2

    group_ids = [c["evidence_group_id"] for c in checks]
    assert len(group_ids) == len(set(group_ids)), group_ids


@pytest.mark.asyncio
async def test_two_different_documents_are_each_compared_not_conflated(caplog):
    """Revisions only compete within one document; two documents never do."""
    process = mk_process(manifest_uploaded=False)
    ar1 = mk_file(id="f-ar1", file_name="ar1.pdf", storage_key="key-ar1",
                  mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                  approval_status="APPROVED")
    ar2 = mk_file(id="f-ar2", file_name="ar2.pdf", storage_key="key-ar2",
                  mime_type="application/pdf", doc_stage="PD", document_code="AR-02",
                  approval_status="APPROVED")
    db = FakeDb(process, [ar1, ar2])
    storage = FakeStorage({"key-ar1": _one_page_pdf("текст"), "key-ar2": _one_page_pdf("текст")})

    with caplog.at_level(logging.INFO, logger="app.pipeline"):
        await process_start("p1", db, storage, CONFIG)

    selections = [r for r in caplog.records if r.msg == "source selection" and r.stage == "PD"]
    assert {r.document_code for r in selections} == {"AR-01", "AR-02"}
    assert all(r.selection_status == "COMPLETE" for r in selections)
    assert not any(
        c["param_code"] == "M-003" and c["completeness_status"] == "CLARIFICATION_REQUIRED"
        for c in db.saved_checks
    )


@pytest.mark.asyncio
async def test_two_unlinked_revisions_of_one_document_need_clarification():
    """No predecessor link, no dates: nothing tells the two revisions apart."""
    process = mk_process(manifest_uploaded=False)
    rev_a = mk_file(id="f-a", file_name="a.pdf", storage_key="key-a",
                    mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                    approval_status="APPROVED")
    rev_b = mk_file(id="f-b", file_name="b.pdf", storage_key="key-b",
                    mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                    approval_status="APPROVED")
    db = FakeDb(process, [rev_a, rev_b])
    storage = FakeStorage({"key-a": _one_page_pdf("текст"), "key-b": _one_page_pdf("текст")})

    await process_start("p1", db, storage, CONFIG)

    m003_checks = [c for c in db.saved_checks if c["param_code"] == "M-003"]
    assert any(c["completeness_status"] == "CLARIFICATION_REQUIRED" for c in m003_checks)
    assert not any(c["finding_status"] == "CANDIDATE" for c in m003_checks)


@pytest.mark.asyncio
async def test_file_without_a_document_code_is_not_guessed_at():
    """Section 9.1 makes the document code mandatory for revision selection;
    a file missing it is not silently assigned to some other document."""
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="a.pdf", storage_key="key-doc",
                  mime_type="application/pdf", doc_stage="PD", document_code=None,
                  approval_status="APPROVED")
    db = FakeDb(process, [doc])
    storage = FakeStorage({"key-doc": _one_page_pdf("текст")})

    await process_start("p1", db, storage, CONFIG)

    m003_checks = [c for c in db.saved_checks if c["param_code"] == "M-003"]
    matching = [
        c for c in m003_checks
        if c["completeness_status"] == "CLARIFICATION_REQUIRED" and "шифр" in (c["rationale"] or "")
    ]
    assert matching
    assert not any(c["finding_status"] == "CANDIDATE" for c in m003_checks)


@pytest.mark.asyncio
async def test_process_start_issues_a_protocol_with_matrix_model_and_hash():
    """Section 9.2/14.2: a protocol is created once processing has run,
    carrying the matrix version, the configured model version, and a
    fingerprint of the registry that drove the run."""
    process = mk_process(manifest_uploaded=True, input_manifest_hash="manifest-hash")
    manifest_row = mk_file(id="f-manifest", file_name="manifest_sample.csv",
                            file_hash="manifest-hash", storage_key="key-manifest",
                            mime_type="text/csv")
    ar = mk_file(id="f-ar", file_name="ar-01.pdf", storage_key="key-ar", file_hash="hash-ar")
    ov = mk_file(id="f-ov", file_name="ov1.pdf", storage_key="key-ov", file_hash="hash-ov")
    db = FakeDb(process, [manifest_row, ar, ov])
    storage = FakeStorage({"key-manifest": (FIXTURES / "manifest_sample.csv").read_bytes()})

    await process_start("p1", db, storage, CONFIG)

    assert len(db.protocol_calls) == 1
    call = db.protocol_calls[0]
    assert call["process_id"] == "p1"
    assert call["object_id"] == "o1"
    assert call["matrix_version"] == "1.1"
    assert call["model_version"] == CONFIG.model_version
    assert call["dataset_version"] == CONFIG.dataset_version
    # A registry was uploaded: its own hash is the fingerprint, not a
    # recomputation over the package's files.
    assert call["input_manifest_hash"] == "manifest-hash"


@pytest.mark.asyncio
async def test_protocol_creation_failure_still_reaches_ready(caplog):
    """A failed protocol write is a data-quality statement about that write,
    never a reason to strand the process before READY."""
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="a.pdf", storage_key="key-doc")
    db = FakeDb(process, [doc])

    async def _broken_create_protocol(*args, **kwargs):
        raise RuntimeError("protocols table unreachable")

    db.create_protocol = _broken_create_protocol
    storage = FakeStorage({})

    with caplog.at_level(logging.ERROR, logger="app.pipeline"):
        await process_start("p1", db, storage, CONFIG)

    assert db.saved["status"] == "READY"
    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert any(r.msg == "protocol creation failed" for r in errors)


def test_input_manifest_hash_uses_the_registry_hash_when_present():
    process = mk_process(input_manifest_hash="manifest-hash")
    assert input_manifest_hash(process, []) == "manifest-hash"


def test_input_manifest_hash_is_order_independent_without_a_registry():
    """No registry: the fingerprint is derived from the package's own files,
    and must not depend on the order files happen to be listed in."""
    process = mk_process(input_manifest_hash=None)
    a = mk_file(id="f-a", file_hash="hash-a")
    b = mk_file(id="f-b", file_hash="hash-b")

    forward = input_manifest_hash(process, [a, b])
    backward = input_manifest_hash(process, [b, a])

    assert forward == backward
    assert len(forward) == 64

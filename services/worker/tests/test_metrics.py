"""Tests that the pipeline and the LLM client actually move the Prometheus
counters and histograms defined in app.metrics.

Reuses test_pipeline's own fakes and fixtures rather than re-building the
same FakeDb/FakeStorage/package-builders here - these are not testing the
pipeline's own behaviour again, only that it reports through app.metrics
while doing so. Counters are module-global and cumulative for the whole test
run, so every assertion here is a before/after delta, never an absolute
value.
"""

import json
from dataclasses import replace

import pytest
from prometheus_client import REGISTRY

from app import metrics
from app.pipeline import process_start
from tests.test_pipeline import (
    CONFIG, FakeDb, FakeStorage, _FakeLlmServer, _llm_config, _one_page_pdf,
    _openai_response, _requested_name_pairs, _room_function_package, mk_file, mk_process,
)


def _sample(name: str, labels: dict | None = None) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


@pytest.mark.asyncio
async def test_successful_file_and_process_increment_ok_counters():
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="a.pdf", storage_key="key-doc")
    db = FakeDb(process, [doc])
    storage = FakeStorage({"key-doc": _one_page_pdf("текст")})

    before_files = _sample("inspector_files_processed_total", {"result": "ok"})
    before_processes = _sample("inspector_processes_total", {"result": "ready"})
    before_duration_count = _sample("inspector_process_duration_seconds_count")

    await process_start("p1", db, storage, CONFIG)

    assert db.saved["status"] == "READY"
    assert _sample("inspector_files_processed_total", {"result": "ok"}) == before_files + 1
    assert _sample("inspector_processes_total", {"result": "ready"}) == before_processes + 1
    assert _sample("inspector_process_duration_seconds_count") == before_duration_count + 1


@pytest.mark.asyncio
async def test_exhausted_file_retries_count_failed_file_and_every_attempt(monkeypatch):
    from app import pipeline as pipeline_module

    process = mk_process(manifest_uploaded=False)
    slow = mk_file(id="f-slow", file_name="slow.pdf", storage_key="key-slow",
                    mime_type="application/pdf")
    db = FakeDb(process, [slow])
    storage = FakeStorage({"key-slow": b"SLOW-MARKER"})

    def always_slow(raw: bytes):
        import time
        time.sleep(0.3)
        return []

    monkeypatch.setattr(pipeline_module, "_extract_and_render_sync", always_slow)
    config = replace(CONFIG, file_processing_timeout_s=0.05, processing_retries=2)

    before_failed = _sample("inspector_files_processed_total", {"result": "failed"})
    before_attempts = _sample("inspector_file_attempts_total")

    await process_start("p1", db, storage, config)

    assert db.saved["status"] == "READY"  # the package still finishes
    assert _sample("inspector_files_processed_total", {"result": "failed"}) == before_failed + 1
    # 1 + processing_retries attempts for the one PDF in the package.
    assert _sample("inspector_file_attempts_total") == before_attempts + 3


@pytest.mark.asyncio
async def test_exhausted_process_retries_count_a_failed_process():
    process = mk_process(manifest_uploaded=False, object_id="o1")

    class AlwaysBrokenDb(FakeDb):
        async def get_files(self, process_id):
            raise RuntimeError("database unreachable")

    db = AlwaysBrokenDb(process, [])
    storage = FakeStorage({})
    config = replace(CONFIG, processing_retries=1)

    before_failed = _sample("inspector_processes_total", {"result": "failed"})

    await process_start("p1", db, storage, config)

    assert db.failed is not None
    assert _sample("inspector_processes_total", {"result": "failed"}) == before_failed + 1


@pytest.mark.asyncio
async def test_room_area_candidate_increments_findings_counter():
    from tests.test_pipeline import _room_sheet_pdf

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

    before = _sample("inspector_findings_total", {"status": "CANDIDATE"})

    await process_start("p1", db, storage, CONFIG)

    assert db.saved["status"] == "READY"
    assert _sample("inspector_findings_total", {"status": "CANDIDATE"}) == before + 1


@pytest.mark.asyncio
async def test_llm_call_that_answers_increments_ok_counter():
    db, storage = _room_function_package()

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [
            {"key": p["key"], "same_function": False, "confidence": 0.9, "reason": "поменялось"}
            for p in pairs
        ]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    before_ok = _sample("inspector_llm_requests_total", {"result": "ok"})
    before_duration_count = _sample("inspector_llm_request_duration_seconds_count")
    try:
        await process_start("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert db.saved["status"] == "READY"
    assert _sample("inspector_llm_requests_total", {"result": "ok"}) == before_ok + 1
    assert _sample("inspector_llm_request_duration_seconds_count") == before_duration_count + 1


@pytest.mark.asyncio
async def test_llm_call_that_fails_increments_error_counter():
    db, storage = _room_function_package()

    def handler(body: bytes):
        return 200, _openai_response("прошу прощения, не могу ответить")

    server = _FakeLlmServer(handler)
    before_error = _sample("inspector_llm_requests_total", {"result": "error"})
    try:
        await process_start("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert db.saved["status"] == "READY"
    assert _sample("inspector_llm_requests_total", {"result": "error"}) == before_error + 1

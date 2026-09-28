"""Tests for process.hypotheses - section 9.5's free-search hypotheses
(SEM-ROOM-FN), computed entirely off process.start/process.update's own
critical path (see app.pipeline's own module docstring for why).

Driven through the same FakeDb/FakeStorage as test_pipeline.py (imported
from there rather than duplicated). Every scenario here first runs
process_start (with no model configured, so it never blocks on one) to get
the package to a real protocol - process_hypotheses writes into "the current
protocol", so it needs one to exist first, exactly as it would in production.
"""

import json
import logging

import pytest

from app.pipeline import process_hypotheses, process_start
from tests.test_pipeline import (
    CONFIG, FakeDb, FakeStorage, _FakeLlmServer, _llm_config, _named_room_sheet_pdf,
    _openai_response, _requested_name_pairs, _room_function_package, mk_file, mk_process,
)


def _n_room_function_pairs(n: int):
    """n independent PD/RD document pairs (AR-00..AR-{n-1}), each with one
    room whose number is unique to its own pair (so app.explication.compare.
    pair_sheets - which matches globally by room-number overlap, not by
    document - never confuses one pair's RD sheet for another's PD sheet)
    and a name that disagrees after normalize_room_name, so every pair
    contributes exactly one name pair for SEM-ROOM-FN to ask about.
    """
    process = mk_process(manifest_uploaded=False)
    files = []
    objects = {}
    for i in range(n):
        code = f"AR-{i:02d}"
        room_number = f"{i + 1}.1"
        pd_id, rd_id = f"f-pd{i}", f"f-rd{i}"
        files.append(mk_file(
            id=pd_id, file_name=f"pd{i}.pdf", storage_key=f"key-pd{i}",
            mime_type="application/pdf", doc_stage="PD", document_code=code,
            approval_status="APPROVED",
        ))
        files.append(mk_file(
            id=rd_id, file_name=f"rd{i}.pdf", storage_key=f"key-rd{i}",
            mime_type="application/pdf", doc_stage="RD", document_code=code,
            approval_status="FOR_CONSTRUCTION",
        ))
        objects[f"key-pd{i}"] = _named_room_sheet_pdf(room_number, "10,00", "Техническое помещение")
        objects[f"key-rd{i}"] = _named_room_sheet_pdf(room_number, "10,00", f"Склад {i}")
    db = FakeDb(process, files)
    storage = FakeStorage(objects)
    return db, storage


def _sem_checks(db):
    return [row for row in db._checks.values() if row["param_code"] == "SEM-ROOM-FN"]


# ─────────── No model / an unavailable model (Global Constraint: works without one) ───────────

@pytest.mark.asyncio
async def test_without_a_provider_writes_not_comparable_and_no_notification():
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)  # CONFIG's llm_base_url is ""
    db.owner_notifications.clear()

    await process_hypotheses("p1", db, storage, CONFIG)

    sem_checks = _sem_checks(db)
    assert len(sem_checks) == 1
    assert sem_checks[0]["completeness_status"] == "NOT_COMPARABLE"
    assert sem_checks[0]["finding_status"] is None
    assert sem_checks[0]["rationale"] == (
        "Языковая модель не подключена: сравнение назначений помещений не выполнялось"
    )
    # added == 0 (a NOT_COMPARABLE row is not a hypothesis): nothing to tell
    # the owner about.
    assert db.owner_notifications == []


# ─────────── A hypothesis is written and the owner is notified ───────────

@pytest.mark.asyncio
async def test_a_verdict_writes_a_suspicion_and_notifies_the_owner():
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)
    db.owner_notifications.clear()

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
        await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    sem_checks = _sem_checks(db)
    assert len(sem_checks) == 1
    suspicion = sem_checks[0]
    assert suspicion["finding_status"] == "SUSPICION"
    assert suspicion["completeness_status"] == "COMPLETE"
    assert suspicion["detection_method"] == "SEMANTIC"
    assert suspicion["confidence"] == 0.9

    assert len(db.owner_notifications) == 1
    notification = db.owner_notifications[0]
    assert notification["kind"] == "HYPOTHESES_READY"
    assert "1" in notification["body"]


# ─────────── Batching (LLM_BATCH_SIZE) ───────────

@pytest.mark.asyncio
async def test_twelve_pairs_batch_five_yields_three_model_calls():
    db, storage = _n_room_function_pairs(12)
    await process_start("p1", db, storage, CONFIG)

    calls = {"n": 0}

    def handler(body: bytes):
        calls["n"] += 1
        pairs = _requested_name_pairs(body)
        answer = [
            {"key": p["key"], "same_function": False, "confidence": 0.7, "reason": "изменилось"}
            for p in pairs
        ]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        # CONFIG's own llm_batch_size defaults to 5 (app.config.Config).
        await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert calls["n"] == 3  # ceil(12 / 5)
    sem_checks = _sem_checks(db)
    assert len(sem_checks) == 12
    assert all(c["finding_status"] == "SUSPICION" for c in sem_checks)


@pytest.mark.asyncio
async def test_one_timed_out_batch_yields_not_comparable_for_that_batch_only():
    """The second of three batches answers with something that is not JSON
    (the same LlmUnavailable path a timeout or an unreachable server takes) -
    only that batch's own pairs become NOT_COMPARABLE, the other two batches
    still produce their own hypotheses.
    """
    db, storage = _n_room_function_pairs(12)
    await process_start("p1", db, storage, CONFIG)

    calls = {"n": 0}

    def handler(body: bytes):
        calls["n"] += 1
        if calls["n"] == 2:
            return 200, _openai_response("прошу прощения, не могу ответить")
        pairs = _requested_name_pairs(body)
        answer = [
            {"key": p["key"], "same_function": False, "confidence": 0.7, "reason": "изменилось"}
            for p in pairs
        ]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert calls["n"] == 3
    sem_checks = _sem_checks(db)
    suspicions = [c for c in sem_checks if c["finding_status"] == "SUSPICION"]
    not_comparable = [c for c in sem_checks if c["completeness_status"] == "NOT_COMPARABLE"]
    assert len(suspicions) == 7  # batches 1 and 3, 5 pairs + 2 pairs
    assert len(not_comparable) == 1  # one row covering batch 2's own 5 pairs
    assert not_comparable[0]["finding_status"] is None
    assert not_comparable[0]["rationale"]  # carries LlmUnavailable's own reason


# ─────────── Decided rows are never touched ───────────

@pytest.mark.asyncio
async def test_a_verified_row_is_never_overwritten():
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.5, "reason": "первая версия"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    suspicion_id = next(cid for cid, row in db._checks.items() if row["param_code"] == "SEM-ROOM-FN")
    db._checks[suspicion_id]["verified_by"] = "user-1"
    db._checks[suspicion_id]["finding_status"] = "CONFIRMED_VIOLATION"

    def handler_v2(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.99, "reason": "вторая версия"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server2 = _FakeLlmServer(handler_v2)
    try:
        await process_hypotheses("p1", db, storage, _llm_config(server2.base_url))
    finally:
        server2.close()

    kept = db._checks[suspicion_id]
    assert kept["verified_by"] == "user-1"
    assert kept["finding_status"] == "CONFIRMED_VIOLATION"
    assert kept["confidence"] == 0.5  # never touched by the "вторая версия" run
    assert len(_sem_checks(db)) == 1  # no second row was inserted alongside it


@pytest.mark.asyncio
async def test_a_promoted_row_is_never_overwritten():
    """POST /findings/:id/promote (services/api's routes/verdicts.ts) sets
    findingStatus=CANDIDATE and leaves engineStatus=SUSPICION without ever
    touching verified_by - upsert_hypothesis_checks must recognise that as
    decided too, not just an ordinary verdict."""
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.5, "reason": "первая версия"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    suspicion_id = next(cid for cid, row in db._checks.items() if row["param_code"] == "SEM-ROOM-FN")
    db._checks[suspicion_id]["finding_status"] = "CANDIDATE"  # promoted; engine_status stays SUSPICION

    def handler_v2(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.99, "reason": "вторая версия"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server2 = _FakeLlmServer(handler_v2)
    try:
        await process_hypotheses("p1", db, storage, _llm_config(server2.base_url))
    finally:
        server2.close()

    kept = db._checks[suspicion_id]
    assert kept["finding_status"] == "CANDIDATE"
    assert kept["confidence"] == 0.5
    assert len(_sem_checks(db)) == 1


# ─────────── A finalized or superseded protocol is skipped ───────────

@pytest.mark.asyncio
async def test_finalized_protocol_skips_writing_and_logs(caplog):
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)
    db.owner_notifications.clear()
    db.protocol_calls[-1]["status"] = "PROTOCOL_FINALIZED"

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.5, "reason": "изменилось"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        with caplog.at_level(logging.INFO, logger="app.pipeline"):
            await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert _sem_checks(db) == []
    assert any(r.msg == "hypotheses not written: protocol finalized or superseded" for r in caplog.records)
    assert db.owner_notifications == []


@pytest.mark.asyncio
async def test_superseded_protocol_skips_writing():
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)
    db.protocol_calls[-1]["status"] = "SUPERSEDED"

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.5, "reason": "изменилось"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        await process_hypotheses("p1", db, storage, _llm_config(server.base_url))
    finally:
        server.close()

    assert _sem_checks(db) == []


# ─────────── file_ids scopes a дозагрузка's own follow-up ───────────

@pytest.mark.asyncio
async def test_only_pairs_touching_the_given_file_ids_are_asked_about():
    db, storage = _n_room_function_pairs(2)  # AR-00 (f-pd0/f-rd0), AR-01 (f-pd1/f-rd1)
    await process_start("p1", db, storage, CONFIG)

    seen_names: set[str] = set()

    def handler(body: bytes):
        pairs = _requested_name_pairs(body)
        seen_names.update(p["rd_name"] for p in pairs)
        answer = [{"key": p["key"], "same_function": False, "confidence": 0.5, "reason": "изменилось"}
                  for p in pairs]
        return 200, _openai_response(json.dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        await process_hypotheses(
            "p1", db, storage, _llm_config(server.base_url), file_ids=["f-pd1", "f-rd1"],
        )
    finally:
        server.close()

    # Only AR-01's own room name ("Склад 1") was ever sent to the model -
    # AR-00's ("Склад 0") was never touched by this дозагрузка's own files.
    assert seen_names == {"Склад 1"}
    sem_checks = _sem_checks(db)
    assert len(sem_checks) == 1
    assert sem_checks[0]["actual_value"] == "Склад 1"


@pytest.mark.asyncio
async def test_a_дозагрузка_touching_nothing_relevant_writes_nothing():
    db, storage = _room_function_package()
    await process_start("p1", db, storage, CONFIG)

    def handler(body: bytes):
        pytest.fail("the model must not be called when no pair is in scope")

    server = _FakeLlmServer(handler)
    try:
        await process_hypotheses(
            "p1", db, storage, _llm_config(server.base_url), file_ids=["some-unrelated-file"],
        )
    finally:
        server.close()

    assert _sem_checks(db) == []

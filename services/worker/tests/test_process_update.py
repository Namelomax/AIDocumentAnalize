"""Tests for the process.update pipeline - a дозагрузка's incremental update
(customer's ТЗ "Инкрементальное обновление при дозагрузке").

Driven through the same FakeDb/FakeStorage as test_pipeline.py (imported
from there rather than duplicated) - process_update is exercised end to end,
app.incremental.build_merge_plan's own decision table is covered exhaustively
by tests/test_incremental.py instead of being repeated here.
"""

import logging

import pytest

from app.config import Config
from app.pipeline import process_start, process_update
from tests.test_pipeline import (
    CONFIG, FakeDb, FakeStorage, _FakeLlmServer, _llm_config, _named_room_sheet_pdf,
    _openai_response, _requested_name_pairs, _room_sheet_pdf, mk_file, mk_process,
)


def _one_pair_scenario(pd_area="10,00", rd_area="12,50"):
    process = mk_process(manifest_uploaded=False)
    pd = mk_file(id="f-pd", file_name="pd.pdf", storage_key="key-pd",
                 mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                 approval_status="APPROVED")
    rd = mk_file(id="f-rd", file_name="rd.pdf", storage_key="key-rd",
                 mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                 approval_status="FOR_CONSTRUCTION")
    db = FakeDb(process, [pd, rd])
    storage = FakeStorage({
        "key-pd": _room_sheet_pdf("1.1", pd_area),
        "key-rd": _room_sheet_pdf("1.1", rd_area),
    })
    return db, storage, pd, rd


def _candidate_row(db):
    return next(r for r in db._checks.values() if r.get("subject") == "room 1.1")


@pytest.mark.asyncio
async def test_an_untouched_decided_group_is_kept_with_its_verdict_intact():
    db, storage, pd, rd = _one_pair_scenario()
    await process_start("p1", db, storage, CONFIG)
    candidate = _candidate_row(db)
    candidate["verified_by"] = "user-1"
    candidate["finding_status"] = "CONFIRMED_VIOLATION"
    candidate_id = candidate["id"]

    # A дозагрузка of a file with no rooms at all - it cannot touch the AR-01
    # pair's own evidence_group_id, so the decided group must survive exactly
    # as it is.
    extra = mk_file(id="f-extra", file_name="extra.pdf", storage_key="key-extra",
                     mime_type="application/pdf", doc_stage="ID")
    db._files.append(extra)
    storage._objects["key-extra"] = _room_sheet_pdf("9.9", "1,00")  # a different room, no overlap

    await process_update("p1", db, storage, CONFIG, file_ids=["f-extra"])

    assert db.saved["status"] == "VERIFYING"  # a decision survived the merge
    kept = db._checks[candidate_id]
    assert kept["verified_by"] == "user-1"
    assert kept["finding_status"] == "CONFIRMED_VIOLATION"
    plan = db.merge_plans[-1]
    assert plan.kept >= 1
    assert plan.decision_survived is True


@pytest.mark.asyncio
async def test_a_new_pair_brought_by_the_дозагрузка_is_added():
    db, storage, pd, rd = _one_pair_scenario()
    await process_start("p1", db, storage, CONFIG)
    before_ids = set(db._checks)

    pd2 = mk_file(id="f-pd2", file_name="pd2.pdf", storage_key="key-pd2",
                  mime_type="application/pdf", doc_stage="PD", document_code="AR-02",
                  approval_status="APPROVED")
    rd2 = mk_file(id="f-rd2", file_name="rd2.pdf", storage_key="key-rd2",
                  mime_type="application/pdf", doc_stage="RD", document_code="AR-02",
                  approval_status="FOR_CONSTRUCTION")
    db._files.extend([pd2, rd2])
    storage._objects["key-pd2"] = _room_sheet_pdf("2.1", "20,00")
    storage._objects["key-rd2"] = _room_sheet_pdf("2.1", "25,00")

    await process_update("p1", db, storage, CONFIG, file_ids=["f-pd2", "f-rd2"])

    plan = db.merge_plans[-1]
    assert plan.added >= 1
    new_rows = [row for row_id, row in db._checks.items() if row_id not in before_ids]
    assert any(row.get("subject") == "room 2.1" for row in new_rows)
    # The untouched AR-01 candidate is still there, unharmed by the merge.
    assert any(row.get("subject") == "room 1.1" for row in db._checks.values())


@pytest.mark.asyncio
async def test_a_superseding_revision_removes_the_old_group_and_keeps_a_decision_with_a_note():
    db, storage, pd, rd_v1 = _one_pair_scenario(pd_area="10,00", rd_area="12,50")
    await process_start("p1", db, storage, CONFIG)
    candidate = _candidate_row(db)
    candidate["verified_by"] = "user-1"
    candidate["finding_status"] = "CONFIRMED_VIOLATION"
    old_id = candidate["id"]
    db.user_names["user-1"] = "Иванов И.И."

    # A новая редакция of the RD file supersedes the old one - the pairing
    # shifts to it entirely (app.domain.revisions.select_source_revision),
    # so the old evidence_group_id (keyed by the old RD file's id) simply
    # stops existing in the freshly computed set.
    rd_v2 = mk_file(id="f-rd2", file_name="rd-v2.pdf", storage_key="key-rd2",
                     mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                     approval_status="FOR_CONSTRUCTION", revision="2", predecessor_id="f-rd")
    db._files.append(rd_v2)
    storage._objects["key-rd2"] = _room_sheet_pdf("1.1", "15,00")

    await process_update("p1", db, storage, CONFIG, file_ids=["f-rd2"])

    plan = db.merge_plans[-1]
    assert plan.decision_survived is True
    # The old, decided row is kept (never deleted) with a note - a decision
    # is never silently dropped.
    assert old_id in db._checks
    kept = db._checks[old_id]
    assert kept["finding_status"] == "CONFIRMED_VIOLATION"
    assert "больше не формирует эту находку" in kept["rationale"]
    # A fresh candidate for the new pairing (room 1.1 against rd_v2) exists
    # alongside it - the group was replaced by the new revision, not lost.
    new_candidates = [
        row for row_id, row in db._checks.items()
        if row_id != old_id and row.get("subject") == "room 1.1"
    ]
    assert len(new_candidates) == 1
    assert db.saved["status"] == "VERIFYING"


@pytest.mark.asyncio
async def test_llm_is_not_called_again_for_a_pair_the_дозагрузка_did_not_touch():
    pd = mk_file(id="f-pd", file_name="pd.pdf", storage_key="key-pd",
                 mime_type="application/pdf", doc_stage="PD", document_code="AR-01",
                 approval_status="APPROVED")
    rd = mk_file(id="f-rd", file_name="rd.pdf", storage_key="key-rd",
                 mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                 approval_status="FOR_CONSTRUCTION")
    process = mk_process(manifest_uploaded=False)
    db = FakeDb(process, [pd, rd])
    storage = FakeStorage({
        "key-pd": _named_room_sheet_pdf("1.1", "10,00", "Техническое помещение"),
        "key-rd": _named_room_sheet_pdf("1.1", "10,00", "Склад ГСМ"),
    })

    calls = {"count": 0}

    def handler(body: bytes):
        calls["count"] += 1
        pairs = _requested_name_pairs(body)
        answer = [
            {"key": p["key"], "same_function": False, "confidence": 0.9, "reason": "изменилось назначение"}
            for p in pairs
        ]
        return 200, _openai_response(__import__("json").dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        config = _llm_config(server.base_url)
        await process_start("p1", db, storage, config)
        assert calls["count"] == 1
        sem_before = [r for r in db._checks.values() if r["param_code"] == "SEM-ROOM-FN"]
        assert len(sem_before) == 1

        # A дозагрузка that touches nothing about the AR-01 pair.
        extra = mk_file(id="f-extra", file_name="extra.pdf", storage_key="key-extra",
                         mime_type="application/pdf", doc_stage="ID")
        db._files.append(extra)
        storage._objects["key-extra"] = _room_sheet_pdf("9.9", "1,00")

        await process_update("p1", db, storage, config, file_ids=["f-extra"])

        assert calls["count"] == 1  # unchanged - the model was not asked again
        sem_after = [r for r in db._checks.values() if r["param_code"] == "SEM-ROOM-FN"]
        assert len(sem_after) == 1
        assert sem_after[0]["evidence_group_id"] == sem_before[0]["evidence_group_id"]
    finally:
        server.close()


@pytest.mark.asyncio
async def test_llm_is_called_again_for_a_pair_the_дозагрузка_does_touch():
    db, storage, pd, rd_v1 = _one_pair_scenario()
    # Give both sheets a room name too, so SEM-ROOM-FN has something to ask
    # about once a new revision of RD arrives with a different name.
    storage._objects["key-pd"] = _named_room_sheet_pdf("1.1", "10,00", "Техническое помещение")
    storage._objects["key-rd"] = _named_room_sheet_pdf("1.1", "10,00", "Техническое помещение")

    calls = {"count": 0}

    def handler(body: bytes):
        calls["count"] += 1
        pairs = _requested_name_pairs(body)
        answer = [{"key": p["key"], "same_function": True, "confidence": 0.5, "reason": "не изменилось"}
                  for p in pairs]
        return 200, _openai_response(__import__("json").dumps(answer, ensure_ascii=False))

    server = _FakeLlmServer(handler)
    try:
        config = _llm_config(server.base_url)
        await process_start("p1", db, storage, config)
        assert calls["count"] == 0  # same_function after normalize_room_name: no disagreement, no call

        rd_v2 = mk_file(id="f-rd2", file_name="rd-v2.pdf", storage_key="key-rd2",
                         mime_type="application/pdf", doc_stage="RD", document_code="AR-01",
                         approval_status="FOR_CONSTRUCTION", revision="2", predecessor_id="f-rd")
        db._files.append(rd_v2)
        storage._objects["key-rd2"] = _named_room_sheet_pdf("1.1", "10,00", "Склад ГСМ")

        await process_update("p1", db, storage, config, file_ids=["f-rd2"])

        assert calls["count"] == 1  # the new pair disagrees after normalization - one fresh call
    finally:
        server.close()


@pytest.mark.asyncio
async def test_protocol_is_superseded_and_a_new_version_is_issued():
    db, storage, pd, rd = _one_pair_scenario()
    await process_start("p1", db, storage, CONFIG)
    assert len(db.protocol_calls) == 1
    assert db.protocol_calls[0]["version"] == 1

    extra = mk_file(id="f-extra", file_name="extra.pdf", storage_key="key-extra",
                     mime_type="application/pdf", doc_stage="ID")
    db._files.append(extra)
    storage._objects["key-extra"] = _room_sheet_pdf("9.9", "1,00")

    await process_update("p1", db, storage, CONFIG, file_ids=["f-extra"])

    assert db.superseded_versions == [1]
    assert len(db.protocol_calls) == 2
    assert db.protocol_calls[1]["version"] == 2
    assert db.protocol_calls[1]["status"] in ("READY", "VERIFYING")


@pytest.mark.asyncio
async def test_new_files_are_marked_with_the_protocol_version_they_arrived_in():
    db, storage, pd, rd = _one_pair_scenario()
    await process_start("p1", db, storage, CONFIG)

    extra = mk_file(id="f-extra", file_name="extra.pdf", storage_key="key-extra",
                     mime_type="application/pdf", doc_stage="ID")
    db._files.append(extra)
    storage._objects["key-extra"] = _room_sheet_pdf("9.9", "1,00")

    await process_update("p1", db, storage, CONFIG, file_ids=["f-extra"])

    assert db.marked_files_version == {"f-extra": 2}


@pytest.mark.asyncio
async def test_owner_is_notified_with_the_merge_counts():
    db, storage, pd, rd = _one_pair_scenario()
    await process_start("p1", db, storage, CONFIG)
    db.owner_notifications.clear()

    extra = mk_file(id="f-extra", file_name="extra.pdf", storage_key="key-extra",
                     mime_type="application/pdf", doc_stage="ID")
    db._files.append(extra)
    storage._objects["key-extra"] = _room_sheet_pdf("9.9", "1,00")

    await process_update("p1", db, storage, CONFIG, file_ids=["f-extra"])

    assert len(db.owner_notifications) == 1
    notification = db.owner_notifications[0]
    assert notification["kind"] == "PROTOCOL_UPDATED"
    assert "добавлено" in notification["body"]
    assert "изменено" in notification["body"]
    assert "удалено" in notification["body"]
    assert "сохранено" in notification["body"]


@pytest.mark.asyncio
async def test_process_update_exhausts_retries_then_fails_and_notifies_admin(caplog):
    process = mk_process(manifest_uploaded=False, object_id="o1")

    class AlwaysBrokenDb(FakeDb):
        async def get_checks_for_merge(self, process_id):
            raise RuntimeError("database unreachable")

    db = AlwaysBrokenDb(process, [])
    storage = FakeStorage({})
    config = Config(
        database_url="", rabbitmq_url="", log_level="INFO", minio_endpoint="",
        minio_root_user="", minio_root_password="", minio_bucket="",
        model_version="rules-2026.09", dataset_version="none",
        llm_base_url="", llm_model="", llm_timeout_s=60.0, processing_retries=1,
    )

    with caplog.at_level(logging.ERROR, logger="app.pipeline"):
        await process_update("p1", db, storage, config, file_ids=["f1"])  # must not raise

    attempt_errors = [r for r in caplog.records if r.msg == "process.update attempt failed"]
    assert len(attempt_errors) == 2  # 1 + processing_retries

    assert db.failed is not None
    assert db.failed["process_id"] == "p1"

    assert len(db.admin_notifications) == 1
    assert db.admin_notifications[0]["kind"] == "PROCESS_FAILED"


@pytest.mark.asyncio
async def test_process_update_process_not_found_does_not_raise():
    db = FakeDb(None, [])
    storage = FakeStorage({})

    await process_update("missing", db, storage, CONFIG, file_ids=[])

    assert db.saved is None

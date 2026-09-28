"""The new app.db.Database methods a дозагрузка's incremental update needs,
against a live PostgreSQL - in the shape of test_db_checks.py. FakeDb-driven
tests (test_pipeline.py) never touch a real database, so this is what checks
the actual SQL: ANY($1::text[]) deletes, the snapshot's JSONB round-trip, and
the (object_id, version) protocol row the snapshot targets.
"""

import os
import uuid

import pytest
import pytest_asyncio

from app.db import Database

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://inspector:inspector@localhost:5432/inspector"
)


@pytest_asyncio.fixture
async def db():
    try:
        database = await Database.connect(DATABASE_URL)
    except OSError:
        pytest.skip("PostgreSQL is not reachable; start it with docker compose up -d")
    try:
        yield database
    finally:
        await database.close()


@pytest_asyncio.fixture
async def scenario(db):
    object_id, process_id, file_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())

    async with db._pool.acquire() as connection:
        await connection.execute(
            "INSERT INTO objects (id, name) VALUES ($1, $2)", object_id, "Test object",
        )
        await connection.execute(
            """
            INSERT INTO processes (id, object_id, status, updated_at)
            VALUES ($1, $2, 'VERIFYING', now())
            """,
            process_id, object_id,
        )
        await connection.execute(
            """
            INSERT INTO files (
                id, object_id, process_id, file_name, file_hash, storage_key,
                size_bytes, mime_type, doc_stage, document_code, revision, approval_status
            )
            VALUES ($1, $2, $3, 'a.pdf', $4, 'key-a', 100, 'application/pdf',
                    'PD', 'AR-01', '1', 'APPROVED')
            """,
            file_id, object_id, process_id, "a" * 64,
        )

    try:
        yield object_id, process_id, file_id
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM protocols WHERE object_id = $1", object_id)
            await connection.execute("DELETE FROM processes WHERE id = $1", process_id)
            await connection.execute("DELETE FROM files WHERE id = $1", file_id)
            await connection.execute("DELETE FROM objects WHERE id = $1", object_id)


def _check(**overrides):
    defaults = dict(
        param_code="M-003", evidence_group_id="g1", subject="room 1.1",
        expected_value="10.00", actual_value="12.50", delta="+2.50",
        completeness_status="COMPLETE", finding_status="CANDIDATE",
        review_priority="MEDIUM", rationale="Площадь изменена", matrix_version="1.1",
        fragments=[],
    )
    defaults.update(overrides)
    return defaults


@pytest.mark.asyncio
async def test_get_checks_for_merge_nests_fragments_under_their_check(db, scenario):
    object_id, process_id, file_id = scenario
    await db.save_checks(process_id, object_id, [_check(fragments=[
        {"file_id": file_id, "file_sha256": "a" * 64, "stage": "PD", "document_code": "AR-01",
         "revision": "1", "approval_status": "APPROVED", "sheet_page": 1,
         "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2, "extracted_value": "10.00", "role": "expected"},
    ])])

    rows = await db.get_checks_for_merge(process_id)

    assert len(rows) == 1
    assert rows[0]["evidence_group_id"] == "g1"
    assert rows[0]["parent_check_id"] is None
    assert len(rows[0]["fragments"]) == 1
    assert rows[0]["fragments"][0]["file_id"] == file_id


@pytest.mark.asyncio
async def test_apply_merge_plan_inserts_deletes_and_updates_rationale(db, scenario):
    from app.incremental import MergePlan

    object_id, process_id, file_id = scenario
    await db.save_checks(process_id, object_id, [
        _check(evidence_group_id="g-keep-note"),
        _check(evidence_group_id="g-delete"),
    ])
    rows = {row["evidence_group_id"]: row for row in await db.get_checks_for_merge(process_id)}

    plan = MergePlan(
        insert=[_check(evidence_group_id="g-new")],
        delete_ids=[rows["g-delete"]["id"]],
        rationale_updates=[(rows["g-keep-note"]["id"], "было решение, не перенесено")],
    )
    await db.apply_merge_plan(process_id, object_id, plan)

    remaining = await db.get_checks_for_merge(process_id)
    by_group = {row["evidence_group_id"]: row for row in remaining}
    assert set(by_group) == {"g-keep-note", "g-new"}
    assert by_group["g-keep-note"]["rationale"] == "было решение, не перенесено"


@pytest.mark.asyncio
async def test_apply_merge_plan_inserts_a_composite_with_its_atoms(db, scenario):
    from app.incremental import MergePlan

    object_id, process_id, file_id = scenario
    composite = _check(evidence_group_id="g-composite", subject="rooms 1..2", atoms=[
        _check(evidence_group_id="g-atom-1", subject="room 1"),
        _check(evidence_group_id="g-atom-2", subject="room 2"),
    ])
    await db.apply_merge_plan(process_id, object_id, MergePlan(insert=[composite]))

    rows = await db.get_checks_for_merge(process_id)
    assert len(rows) == 3
    parent = next(r for r in rows if r["evidence_group_id"] == "g-composite")
    atoms = [r for r in rows if r["evidence_group_id"] != "g-composite"]
    assert all(a["parent_check_id"] == parent["id"] for a in atoms)


@pytest.mark.asyncio
async def test_mark_files_added_in_protocol_sets_the_version(db, scenario):
    object_id, process_id, file_id = scenario
    await db.mark_files_added_in_protocol([file_id], 2)

    async with db._pool.acquire() as connection:
        row = await connection.fetchrow("SELECT added_in_protocol_version FROM files WHERE id = $1", file_id)
    assert row["added_in_protocol_version"] == 2


@pytest.mark.asyncio
async def test_get_user_names_looks_up_full_names(db, scenario):
    user_id = str(uuid.uuid4())
    async with db._pool.acquire() as connection:
        await connection.execute(
            "INSERT INTO users (id, login, password_hash, full_name, role) "
            "VALUES ($1, $2, 'x', $3, 'INSPECTOR')",
            user_id, f"test-user-{user_id[:8]}", "Иванов И.И.",
        )
    try:
        names = await db.get_user_names([user_id, "unknown-id"])
        assert names == {user_id: "Иванов И.И."}
        assert await db.get_user_names([]) == {}
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM users WHERE id = $1", user_id)


@pytest.mark.asyncio
async def test_snapshot_and_supersede_protocol_freezes_current_checks(db, scenario):
    object_id, process_id, file_id = scenario
    await db.save_checks(process_id, object_id, [_check(fragments=[
        {"file_id": file_id, "file_sha256": "a" * 64, "stage": "PD", "document_code": "AR-01",
         "revision": "1", "approval_status": "APPROVED", "sheet_page": 1,
         "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2, "extracted_value": "10.00", "role": "expected"},
    ])])
    version = await db.create_protocol(process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64)
    assert version == 1

    superseded_version = await db.snapshot_and_supersede_protocol(process_id)
    assert superseded_version == 1

    async with db._pool.acquire() as connection:
        row = await connection.fetchrow(
            "SELECT status, snapshot FROM protocols WHERE process_id = $1 AND version = 1", process_id,
        )
    assert row["status"] == "SUPERSEDED"
    import json
    snapshot = json.loads(row["snapshot"])
    assert len(snapshot["checks"]) == 1
    check = snapshot["checks"][0]
    assert check["evidenceGroupId"] == "g1"
    assert check["findingStatus"] == "CANDIDATE"
    assert len(check["fragments"]) == 1
    assert check["fragments"][0]["fileId"] == file_id

    # Deleting the live checks (as a merge would) must not touch the frozen
    # copy - the snapshot is what makes the history real.
    await db.save_checks(process_id, object_id, [])
    async with db._pool.acquire() as connection:
        row_after = await connection.fetchrow(
            "SELECT snapshot FROM protocols WHERE process_id = $1 AND version = 1", process_id,
        )
    assert json.loads(row_after["snapshot"])["checks"] == snapshot["checks"]


@pytest.mark.asyncio
async def test_snapshot_and_supersede_protocol_returns_none_without_a_protocol(db, scenario):
    object_id, process_id, file_id = scenario
    assert await db.snapshot_and_supersede_protocol(process_id) is None


@pytest.mark.asyncio
async def test_create_protocol_accepts_an_explicit_status(db, scenario):
    object_id, process_id, file_id = scenario
    version = await db.create_protocol(
        process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64, status="VERIFYING",
    )
    async with db._pool.acquire() as connection:
        row = await connection.fetchrow(
            "SELECT status FROM protocols WHERE object_id = $1 AND version = $2", object_id, version,
        )
    assert row["status"] == "VERIFYING"

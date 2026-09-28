"""save_checks against a live PostgreSQL, in the shape of test_seed_params.py.

FakeDb-driven tests (test_pipeline.py) never touch a real database, so the one
thing they cannot catch is exactly what this test is for: the enum casts
evidence_fragments needs for DocStage and ApprovalStatus, the foreign keys to
processes/files, and the (process_id, evidence_group_id) uniqueness - none of
which a Python dict enforces.
"""

import os
import uuid

import pytest
import pytest_asyncio

from app.db import Database

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://inspector:inspector@localhost:5432/inspector"
)


# Strict mode of pytest-asyncio only runs async fixtures declared this way.
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
    """One object, one process, one file - created and torn down here so the
    test never leaves rows behind in a database other tests and a running
    stand also use."""
    object_id, process_id, file_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())

    async with db._pool.acquire() as connection:
        await connection.execute(
            "INSERT INTO objects (id, name) VALUES ($1, $2)", object_id, "Test object",
        )
        await connection.execute(
            """
            INSERT INTO processes (id, object_id, status, updated_at)
            VALUES ($1, $2, 'READY', now())
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
            # Checks and evidence_fragments cascade from the process; files
            # and the object are not cascaded and are removed explicitly.
            await connection.execute("DELETE FROM processes WHERE id = $1", process_id)
            await connection.execute("DELETE FROM files WHERE id = $1", file_id)
            await connection.execute("DELETE FROM objects WHERE id = $1", object_id)


@pytest.mark.asyncio
async def test_save_checks_writes_a_check_and_its_evidence_fragments(db, scenario):
    object_id, process_id, file_id = scenario

    await db.save_checks(process_id, object_id, [{
        "param_code": "M-003",
        "evidence_group_id": f"{object_id}:M-003:room 1.1",
        "subject": "room 1.1",
        "expected_value": "10.00",
        "actual_value": "12.50",
        "delta": "+2.50",
        "completeness_status": "COMPLETE",
        "finding_status": "CANDIDATE",
        "review_priority": "MEDIUM",
        "rationale": "Площадь помещения 1.1 изменена.",
        "matrix_version": "1.1",
        "fragments": [
            {
                "file_id": file_id, "file_sha256": "a" * 64, "stage": "PD",
                "document_code": "AR-01", "revision": "1", "approval_status": "APPROVED",
                "sheet_page": 1, "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2,
                "extracted_value": "10.00", "role": "expected",
            },
            {
                "file_id": file_id, "file_sha256": "a" * 64, "stage": "RD",
                "document_code": "AR-01", "revision": "1", "approval_status": "FOR_CONSTRUCTION",
                "sheet_page": 1, "x0": 0.3, "y0": 0.3, "x1": 0.4, "y1": 0.4,
                "extracted_value": "12.50", "role": "actual",
            },
        ],
    }])

    async with db._pool.acquire() as connection:
        check_row = await connection.fetchrow(
            "SELECT * FROM checks WHERE process_id = $1", process_id,
        )
        fragment_rows = await connection.fetch(
            "SELECT * FROM evidence_fragments WHERE check_id = $1", check_row["id"],
        )

    assert check_row["param_code"] == "M-003"
    assert check_row["finding_status"] == "CANDIDATE"
    assert check_row["completeness_status"] == "COMPLETE"
    assert check_row["object_id"] == object_id

    assert len(fragment_rows) == 2
    roles = {row["role"] for row in fragment_rows}
    assert roles == {"expected", "actual"}
    stages = {row["stage"] for row in fragment_rows}
    assert stages == {"PD", "RD"}
    assert all(row["approval_status"] in ("APPROVED", "FOR_CONSTRUCTION") for row in fragment_rows)


@pytest.mark.asyncio
async def test_save_checks_writes_a_suspicion_with_a_null_param_id(db, scenario):
    """SEM-ROOM-FN (plan 8, Task 4): a free-search hypothesis, not a matrix
    parameter - the params table has no row for its code, so the param_id
    subquery in save_checks must resolve to NULL rather than fail the
    insert, and detection_method/confidence must round-trip untouched."""
    object_id, process_id, file_id = scenario

    await db.save_checks(process_id, object_id, [{
        "param_code": "SEM-ROOM-FN",
        "evidence_group_id": f"{object_id}:SEM-ROOM-FN:function 1.109",
        "subject": "function 1.109",
        "expected_value": "Техническое помещение",
        "actual_value": "Склад ГСМ",
        "delta": None,
        "completeness_status": "COMPLETE",
        "finding_status": "SUSPICION",
        "detection_method": "SEMANTIC",
        "confidence": 0.9,
        "review_priority": "MEDIUM",
        "rationale": "Назначение помещения 1.109 изменено.",
        "matrix_version": "1.1",
        "fragments": [],
    }])

    async with db._pool.acquire() as connection:
        check_row = await connection.fetchrow(
            "SELECT * FROM checks WHERE process_id = $1", process_id,
        )

    assert check_row["param_code"] == "SEM-ROOM-FN"
    assert check_row["param_id"] is None
    assert check_row["finding_status"] == "SUSPICION"
    assert check_row["detection_method"] == "SEMANTIC"
    assert check_row["confidence"] == 0.9


@pytest.mark.asyncio
async def test_save_checks_writes_a_composite_and_its_atoms(db, scenario):
    """A composite candidate (app.explication.compare) carries its own
    members under check["atoms"] - db.save_checks must insert the composite
    first and link each atom to it via parent_check_id, invisible to the
    inspector until split (services/api's visibility rule)."""
    object_id, process_id, file_id = scenario

    atom_1 = {
        "param_code": "M-003",
        "evidence_group_id": f"{object_id}:M-003:room 134",
        "subject": "room 134",
        "expected_value": "15.00", "actual_value": "14.00", "delta": "-1.00",
        "completeness_status": "COMPLETE", "finding_status": "CANDIDATE",
        "review_priority": "MEDIUM", "rationale": "Площадь помещения 134 изменена.",
        "matrix_version": "1.1", "fragments": [],
    }
    atom_2 = {
        "param_code": "M-003",
        "evidence_group_id": f"{object_id}:M-003:room 149",
        "subject": "room 149",
        "expected_value": "15.00", "actual_value": "14.00", "delta": "-1.00",
        "completeness_status": "COMPLETE", "finding_status": "CANDIDATE",
        "review_priority": "MEDIUM", "rationale": "Площадь помещения 149 изменена.",
        "matrix_version": "1.1", "fragments": [],
    }
    composite = {
        "param_code": "M-003",
        "evidence_group_id": f"{object_id}:M-003:rooms 134..149",
        "subject": "rooms 134..149",
        "expected_value": "30.00", "actual_value": "28.00", "delta": "-2.00",
        "completeness_status": "COMPLETE", "finding_status": "CANDIDATE",
        "review_priority": "MEDIUM",
        "rationale": "Изменены площади 2 помещений подряд (134-149).",
        "matrix_version": "1.1", "fragments": [],
        "atoms": [atom_1, atom_2],
    }

    await db.save_checks(process_id, object_id, [composite])

    async with db._pool.acquire() as connection:
        rows = await connection.fetch(
            "SELECT id, subject, parent_check_id, split_at FROM checks WHERE process_id = $1", process_id,
        )

    assert len(rows) == 3
    composite_row = next(r for r in rows if r["subject"] == "rooms 134..149")
    atom_rows = [r for r in rows if r["subject"] != "rooms 134..149"]
    assert composite_row["parent_check_id"] is None
    assert composite_row["split_at"] is None
    assert {r["subject"] for r in atom_rows} == {"room 134", "room 149"}
    assert all(r["parent_check_id"] == composite_row["id"] for r in atom_rows)


@pytest.mark.asyncio
async def test_save_checks_replacing_a_composite_run_is_idempotent(db, scenario):
    """A re-run must not accumulate a second composite/atoms set alongside
    the first - same replace-in-one-transaction guarantee as an ordinary
    check (test_save_checks_replaces_the_previous_set)."""
    object_id, process_id, file_id = scenario

    composite = {
        "param_code": "M-003",
        "evidence_group_id": f"{object_id}:M-003:rooms 1..2",
        "subject": "rooms 1..2",
        "expected_value": "20.00", "actual_value": "18.00", "delta": "-2.00",
        "completeness_status": "COMPLETE", "finding_status": "CANDIDATE",
        "review_priority": "MEDIUM", "rationale": "Изменены площади 2 помещений подряд (1-2).",
        "matrix_version": "1.1", "fragments": [],
        "atoms": [
            {
                "param_code": "M-003", "evidence_group_id": f"{object_id}:M-003:room 1",
                "subject": "room 1", "expected_value": "10.00", "actual_value": "9.00", "delta": "-1.00",
                "completeness_status": "COMPLETE", "finding_status": "CANDIDATE",
                "review_priority": "MEDIUM", "rationale": "Площадь помещения 1 изменена.",
                "matrix_version": "1.1", "fragments": [],
            },
            {
                "param_code": "M-003", "evidence_group_id": f"{object_id}:M-003:room 2",
                "subject": "room 2", "expected_value": "10.00", "actual_value": "9.00", "delta": "-1.00",
                "completeness_status": "COMPLETE", "finding_status": "CANDIDATE",
                "review_priority": "MEDIUM", "rationale": "Площадь помещения 2 изменена.",
                "matrix_version": "1.1", "fragments": [],
            },
        ],
    }

    await db.save_checks(process_id, object_id, [composite])
    await db.save_checks(process_id, object_id, [composite])

    async with db._pool.acquire() as connection:
        rows = await connection.fetch("SELECT id FROM checks WHERE process_id = $1", process_id)

    assert len(rows) == 3


@pytest.mark.asyncio
async def test_save_checks_replaces_the_previous_set(db, scenario):
    object_id, process_id, file_id = scenario

    base_check = {
        "param_code": "M-041",
        "evidence_group_id": f"{object_id}:M-041",
        "subject": None, "expected_value": None, "actual_value": None, "delta": None,
        "completeness_status": "NOT_COMPARABLE",
        "finding_status": None,
        "review_priority": "LOW",
        "rationale": "no extractor is implemented for this parameter yet",
        "matrix_version": "1.1",
        "fragments": [],
    }

    await db.save_checks(process_id, object_id, [base_check])
    await db.save_checks(process_id, object_id, [base_check])

    async with db._pool.acquire() as connection:
        rows = await connection.fetch("SELECT id FROM checks WHERE process_id = $1", process_id)

    # A second run must replace the first set, not add to it.
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_create_protocol_versions_are_per_object(db, scenario):
    """Section 9.2: versions count per object, so a second run of the same
    object gets version 2, not a fresh version 1 or a unique-key collision."""
    object_id, process_id, file_id = scenario

    first = await db.create_protocol(
        process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64,
    )
    second = await db.create_protocol(
        process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64,
    )

    try:
        assert first == 1
        assert second == 2

        async with db._pool.acquire() as connection:
            rows = await connection.fetch(
                "SELECT version, status, matrix_version, model_version, dataset_version "
                "FROM protocols WHERE object_id = $1 ORDER BY version",
                object_id,
            )
        assert [row["version"] for row in rows] == [1, 2]
        assert all(row["status"] == "READY" for row in rows)
        assert all(row["matrix_version"] == "1.1" for row in rows)
        assert all(row["model_version"] == "rules-2026.09" for row in rows)
        assert all(row["dataset_version"] == "none" for row in rows)
    finally:
        # Protocols are not covered by the scenario fixture's own cleanup
        # (they cascade from processes, but the assertions above need the
        # rows to still exist at that point) - delete explicitly here.
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM protocols WHERE object_id = $1", object_id)


def _sem_room_fn_check(object_id: str, group_label: str, *, confidence: float = 0.9,
                        rationale: str = "Назначение помещения изменено.") -> dict:
    return {
        "param_code": "SEM-ROOM-FN",
        "evidence_group_id": f"{object_id}:SEM-ROOM-FN:{group_label}",
        "subject": f"function {group_label}",
        "expected_value": "Техническое помещение",
        "actual_value": "Склад ГСМ",
        "delta": None,
        "completeness_status": "COMPLETE",
        "finding_status": "SUSPICION",
        "detection_method": "SEMANTIC",
        "confidence": confidence,
        "review_priority": "MEDIUM",
        "rationale": rationale,
        "matrix_version": "1.1",
        "fragments": [],
    }


@pytest.mark.asyncio
async def test_upsert_hypothesis_checks_inserts_a_suspicion(db, scenario):
    """process.hypotheses's own write path (app.pipeline.process_hypotheses):
    a fresh SUSPICION row is inserted, and its own count is reported back."""
    object_id, process_id, file_id = scenario
    await db.create_protocol(process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64)

    try:
        added = await db.upsert_hypothesis_checks(process_id, object_id, [
            _sem_room_fn_check(object_id, "1.109"),
        ])
        assert added == 1

        async with db._pool.acquire() as connection:
            row = await connection.fetchrow("SELECT * FROM checks WHERE process_id = $1", process_id)
        assert row["param_code"] == "SEM-ROOM-FN"
        assert row["finding_status"] == "SUSPICION"
        assert row["param_id"] is None
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM protocols WHERE object_id = $1", object_id)


@pytest.mark.asyncio
async def test_upsert_hypothesis_checks_never_overwrites_a_decided_row(db, scenario):
    """A row an inspector already verified (verified_by set) is left exactly
    as it is - a later run with a different confidence/rationale for the
    same evidence_group_id must not replace it."""
    object_id, process_id, file_id = scenario
    await db.create_protocol(process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64)

    try:
        await db.upsert_hypothesis_checks(process_id, object_id, [
            _sem_room_fn_check(object_id, "1.109", confidence=0.5, rationale="первая версия"),
        ])
        async with db._pool.acquire() as connection:
            check_id = await connection.fetchval("SELECT id FROM checks WHERE process_id = $1", process_id)
            await connection.execute(
                "UPDATE checks SET verified_by = $2 WHERE id = $1", check_id, "user-1",
            )

        added = await db.upsert_hypothesis_checks(process_id, object_id, [
            _sem_room_fn_check(object_id, "1.109", confidence=0.99, rationale="вторая версия"),
        ])
        assert added == 0

        async with db._pool.acquire() as connection:
            rows = await connection.fetch("SELECT * FROM checks WHERE process_id = $1", process_id)
        assert len(rows) == 1
        assert rows[0]["id"] == check_id
        assert rows[0]["confidence"] == 0.5
        assert rows[0]["rationale"] == "первая версия"
        assert rows[0]["verified_by"] == "user-1"
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM protocols WHERE object_id = $1", object_id)


@pytest.mark.asyncio
async def test_upsert_hypothesis_checks_skips_a_finalized_protocol(db, scenario):
    object_id, process_id, file_id = scenario
    await db.create_protocol(process_id, object_id, "1.1", "rules-2026.09", "none", "a" * 64)

    try:
        async with db._pool.acquire() as connection:
            await connection.execute(
                "UPDATE protocols SET status = 'PROTOCOL_FINALIZED' WHERE process_id = $1", process_id,
            )

        added = await db.upsert_hypothesis_checks(process_id, object_id, [
            _sem_room_fn_check(object_id, "1.109"),
        ])
        assert added is None

        async with db._pool.acquire() as connection:
            rows = await connection.fetch("SELECT id FROM checks WHERE process_id = $1", process_id)
        assert rows == []
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM protocols WHERE object_id = $1", object_id)

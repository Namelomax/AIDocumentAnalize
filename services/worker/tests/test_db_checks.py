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

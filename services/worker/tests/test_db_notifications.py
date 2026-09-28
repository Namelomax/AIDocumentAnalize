"""app.db.Database's own notification/failure methods against a live
PostgreSQL, in the shape of test_db_checks.py.

FakeDb-driven tests (test_pipeline.py) exercise the retry/timeout logic
itself, but a fake can't catch what only the real fan-out queries can get
wrong: which role actually gets notified, and whether the enum casts and
foreign keys the schema requires (notifications.user_id -> users.id,
ProcessStatus's own FAILED value) round-trip correctly.
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


async def _make_user(db, role: str) -> str:
    user_id = str(uuid.uuid4())
    async with db._pool.acquire() as connection:
        await connection.execute(
            """
            INSERT INTO users (id, login, password_hash, full_name, role)
            VALUES ($1, $2, 'not-used-by-tests', $3, $4::"UserRole")
            """,
            user_id, f"test-{user_id}", f"Test {role}", role,
        )
    return user_id


@pytest_asyncio.fixture
async def scenario(db):
    """One object and one process - created and torn down here so the test
    never leaves rows behind in a database other tests and a running stand
    also use."""
    object_id, process_id = str(uuid.uuid4()), str(uuid.uuid4())
    async with db._pool.acquire() as connection:
        await connection.execute(
            "INSERT INTO objects (id, name) VALUES ($1, $2)", object_id, "Test object",
        )
        await connection.execute(
            "INSERT INTO processes (id, object_id, status, updated_at) VALUES ($1, $2, 'PARSING', now())",
            process_id, object_id,
        )
    try:
        yield object_id, process_id
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM notifications")
            await connection.execute("DELETE FROM processes WHERE id = $1", process_id)
            await connection.execute("DELETE FROM objects WHERE id = $1", object_id)
            await connection.execute("DELETE FROM users WHERE full_name LIKE 'Test %'")


@pytest.mark.asyncio
async def test_notify_admins_writes_one_row_per_admin(db, scenario):
    # The database is shared with the running stand's own seeded demo
    # accounts (services/api's seedDemoUsers already put an ADMIN and an
    # INSPECTOR in it), so this only asserts the two admins created here are
    # among those notified - not that they are the only ones - and that the
    # inspector created here in particular never is.
    object_id, process_id = scenario
    admin_1 = await _make_user(db, "ADMIN")
    admin_2 = await _make_user(db, "ADMIN")
    inspector = await _make_user(db, "INSPECTOR")

    await db.notify_admins(
        "FILE_PROCESSING_FAILED", "Не удалось обработать файл",
        "Не удалось обработать файл «a.pdf» после 3 попыток: timeout",
        process_id=process_id, object_id=object_id,
    )

    async with db._pool.acquire() as connection:
        rows = await connection.fetch("SELECT * FROM notifications WHERE process_id = $1", process_id)

    notified = {r["user_id"] for r in rows}
    assert {admin_1, admin_2} <= notified
    assert inspector not in notified
    assert all(r["kind"] == "FILE_PROCESSING_FAILED" for r in rows)
    assert all(r["read_at"] is None for r in rows)
    assert all(r["object_id"] == object_id for r in rows)


@pytest.mark.asyncio
async def test_notify_process_owner_targets_started_by_when_set(db, scenario):
    object_id, process_id = scenario
    owner = await _make_user(db, "INSPECTOR")
    await _make_user(db, "INSPECTOR")  # a second inspector must not be notified
    async with db._pool.acquire() as connection:
        await connection.execute("UPDATE processes SET started_by = $2 WHERE id = $1", process_id, owner)

    process = await db.get_process(process_id)
    assert process.started_by == owner

    await db.notify_process_owner(process, "PROCESS_READY", "Протокол готов к проверке", "Готов.")

    async with db._pool.acquire() as connection:
        rows = await connection.fetch("SELECT * FROM notifications WHERE process_id = $1", process_id)

    assert len(rows) == 1
    assert rows[0]["user_id"] == owner
    assert rows[0]["title"] == "Протокол готов к проверке"


@pytest.mark.asyncio
async def test_notify_process_owner_falls_back_to_every_inspector_when_unset(db, scenario):
    object_id, process_id = scenario
    inspector_1 = await _make_user(db, "INSPECTOR")
    inspector_2 = await _make_user(db, "INSPECTOR")
    admin = await _make_user(db, "ADMIN")  # must not be notified by a READY notice

    process = await db.get_process(process_id)
    assert process.started_by is None

    await db.notify_process_owner(process, "PROCESS_READY", "Протокол готов к проверке", "Готов.")

    async with db._pool.acquire() as connection:
        rows = await connection.fetch("SELECT * FROM notifications WHERE process_id = $1", process_id)

    notified = {r["user_id"] for r in rows}
    assert {inspector_1, inspector_2} <= notified
    assert admin not in notified


@pytest.mark.asyncio
async def test_mark_process_failed_sets_status_and_error_message(db, scenario):
    object_id, process_id = scenario

    await db.mark_process_failed(process_id, "Обработка пакета завершилась ошибкой: database unreachable")

    async with db._pool.acquire() as connection:
        row = await connection.fetchrow("SELECT status, error_message FROM processes WHERE id = $1", process_id)

    assert row["status"] == "FAILED"
    assert row["error_message"] == "Обработка пакета завершилась ошибкой: database unreachable"


@pytest.mark.asyncio
async def test_record_file_processing_error_sets_the_file_column(db, scenario):
    object_id, process_id = scenario
    file_id = str(uuid.uuid4())
    async with db._pool.acquire() as connection:
        await connection.execute(
            """
            INSERT INTO files (id, object_id, process_id, file_name, file_hash, storage_key,
                               size_bytes, mime_type, approval_status)
            VALUES ($1, $2, $3, 'a.pdf', $4, 'key-a', 100, 'application/pdf', 'DRAFT')
            """,
            file_id, object_id, process_id, "b" * 64,
        )

    try:
        await db.record_file_processing_error(file_id, "Не удалось обработать файл «a.pdf» после 3 попыток: boom")

        async with db._pool.acquire() as connection:
            row = await connection.fetchrow("SELECT processing_error FROM files WHERE id = $1", file_id)
        assert row["processing_error"] == "Не удалось обработать файл «a.pdf» после 3 попыток: boom"
    finally:
        async with db._pool.acquire() as connection:
            await connection.execute("DELETE FROM files WHERE id = $1", file_id)

import os

import pytest
import pytest_asyncio

from app.db import Database
from app.params.specs import load_specs

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
        # The test edits a threshold to prove seeding leaves it alone. Left in
        # place, that edit would be read by every later run on this database,
        # so the table is put back to exactly what a fresh start seeds.
        async with database._pool.acquire() as connection:
            await connection.execute("DELETE FROM params")
        await database.seed_params(load_specs())
        await database.close()


@pytest.mark.asyncio
async def test_seeding_fills_the_table_once_and_keeps_admin_edits(db):
    matrix = load_specs()
    async with db._pool.acquire() as connection:
        await connection.execute("DELETE FROM params")

    assert await db.seed_params(matrix) == 132

    async with db._pool.acquire() as connection:
        await connection.execute("UPDATE params SET min_value = 1.0 WHERE code = 'M-041'")

    # A second start must not undo what an administrator changed.
    assert await db.seed_params(matrix) == 0

    async with db._pool.acquire() as connection:
        row = await connection.fetchrow(
            "SELECT min_value, matrix_version, parameter_name FROM params WHERE code = 'M-041'"
        )
    assert row["min_value"] == 1.0
    assert row["matrix_version"] == "1.1"
    assert row["parameter_name"].startswith("Ширина эвакуационных")

import asyncio
import logging

from app.config import load_config
from app.consumer import consume
from app.db import Database
from app.logging_setup import setup_logging
from app.params.specs import load_specs
from app.storage import ManifestStorage

logger = logging.getLogger(__name__)


async def _run() -> None:
    config = load_config()
    setup_logging(config.log_level)
    db = await Database.connect(config.database_url)
    try:
        # Loaded before consuming so a broken spec stops the worker at start,
        # visibly, instead of failing the first package it is given.
        matrix = load_specs()
        inserted = await db.seed_params(matrix)
        logger.info("parameter matrix loaded", extra={
            "matrix_version": matrix.version,
            "params": len(matrix.params),
            "inserted": inserted,
        })
        storage = ManifestStorage(config)
        await consume(config.rabbitmq_url, db, storage)
    finally:
        await db.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

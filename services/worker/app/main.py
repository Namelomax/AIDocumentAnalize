import asyncio

from app.config import load_config
from app.consumer import consume
from app.db import Database
from app.logging_setup import setup_logging
from app.storage import ManifestStorage


async def _run() -> None:
    config = load_config()
    setup_logging(config.log_level)
    db = await Database.connect(config.database_url)
    try:
        storage = ManifestStorage(config)
        await consume(config.rabbitmq_url, db, storage)
    finally:
        await db.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

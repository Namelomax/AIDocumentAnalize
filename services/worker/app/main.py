import asyncio
import logging

from prometheus_client import start_http_server

from app.config import load_config
from app.consumer import consume
from app.db import Database
from app.logging_setup import setup_logging
from app.params.specs import load_specs
from app.pdf.cache import ParseCache
from app.storage import ManifestStorage

logger = logging.getLogger(__name__)


async def _run() -> None:
    config = load_config()
    setup_logging(config.log_level)
    # Customer's ТЗ p.31: the worker's own /metrics, scraped by Prometheus
    # directly (docker-compose.yml does not publish this port to the host -
    # only prometheus, on the internal network, needs it). Started before the
    # consumer so a scrape during startup still gets a response rather than a
    # connection refused.
    start_http_server(config.metrics_port)
    logger.info("metrics server listening", extra={"port": config.metrics_port})
    db = await Database.connect(config.database_url)
    # Customer's ТЗ p.16, п.5 "Кеширование": built once here, the same way db
    # and storage are, so app.pipeline can be driven by a fake in tests
    # without a real Redis. config.redis_url empty (no `redis` service on a
    # stand, or a deliberate opt-out) makes this a no-op cache - every method
    # on it degenerates to a miss/no-op, so nothing downstream has to branch
    # on whether caching is actually configured.
    cache = ParseCache.from_config(config)
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
        await consume(config.rabbitmq_url, db, storage, config, cache=cache)
    finally:
        await cache.close()
        await db.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

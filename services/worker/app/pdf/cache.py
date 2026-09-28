"""Redis-backed cache of PDF parse results, keyed by file hash.

Customer's ТЗ (Задание/10. Мосстройнадзор.pdf p.16, п.5 "Кеширование"):
"Результаты парсинга сохраняются в Redis по хешу файла для ускорения
повторных проверок" - the same PDF bytes uploaded a second time, to a second
object or after a retry, must not pay for PyMuPDF text extraction and page
rendering again.

Only the *extraction* result (app.pdf.extract's own shape, the same one
app.db.Database.save_pages writes) is cached here. Rendered page PNGs are not
put into Redis - a 500-page A0 package's images run into the tens of
megabytes, far past anything Redis should be asked to hold. Instead, a cache
entry remembers which file's own MinIO object keys ("pages/{file_id}/{n}.png")
the pages were rendered to; app.pipeline copies those objects to the new
file's own keys on a hit rather than re-rendering them (see
_pages_from_cache_entry there).

A cache is only ever an acceleration, never a dependency: a miss, a corrupt
entry, or Redis being unreachable are all handled the same way by get() -
log a warning, record it in inspector_parse_cache_total, and return None so
the caller falls back to parsing from scratch. Nothing here is allowed to
raise into app.pipeline.
"""

import json
import logging

from app.metrics import parse_cache_total

logger = logging.getLogger(__name__)


def cache_key(parser_version: int, file_hash: str) -> str:
    # Versioned so a parser change that alters the cached shape (see
    # app.pdf.extract.PARSER_VERSION's own comment) can never have an old
    # entry served to code that no longer expects it - it just reads as a
    # miss under the new version's key instead.
    return f"parse:v{parser_version}:{file_hash}"


class ParseCache:
    """Wraps an optional redis.asyncio client.

    `client` is None when REDIS_URL is unset (config.Config.redis_url) - get()
    and set() then degenerate to an unconditional miss / no-op, so
    app.pipeline never has to branch on whether caching is configured at all.
    """

    def __init__(self, client, ttl_s: float):
        self._client = client
        self._ttl_s = ttl_s

    @classmethod
    def from_config(cls, config) -> "ParseCache":
        client = None
        if config.redis_url:
            # Imported here, not at module load: importing redis.asyncio is
            # harmless either way, but keeping it next to its only use makes
            # it obvious this whole branch - and the dependency - exists only
            # for a configured cache.
            import redis.asyncio as redis

            client = redis.from_url(config.redis_url)
        return cls(client, config.parse_cache_ttl_s)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def get(self, parser_version: int, file_hash: str, *,
                   process_id: str, file_id: str) -> dict | None:
        if self._client is None:
            return None

        key = cache_key(parser_version, file_hash)
        try:
            raw = await self._client.get(key)
        except Exception as exc:  # noqa: BLE001 - see module docstring
            parse_cache_total.labels(result="error").inc()
            logger.warning("parse cache lookup failed", extra={
                "process_id": process_id, "file_id": file_id, "error": str(exc),
            })
            return None

        if raw is None:
            parse_cache_total.labels(result="miss").inc()
            return None

        try:
            entry = json.loads(raw)
        except (TypeError, ValueError) as exc:
            parse_cache_total.labels(result="error").inc()
            logger.warning("parse cache entry corrupt", extra={
                "process_id": process_id, "file_id": file_id, "error": str(exc),
            })
            return None

        if not isinstance(entry, dict):
            parse_cache_total.labels(result="error").inc()
            logger.warning("parse cache entry corrupt", extra={
                "process_id": process_id, "file_id": file_id,
                "error": f"expected a JSON object, got {type(entry).__name__}",
            })
            return None

        parse_cache_total.labels(result="hit").inc()
        return entry

    async def set(self, parser_version: int, file_hash: str, entry: dict, *,
                   process_id: str, file_id: str) -> None:
        if self._client is None:
            return

        key = cache_key(parser_version, file_hash)
        try:
            await self._client.set(key, json.dumps(entry), ex=round(self._ttl_s))
        except Exception as exc:  # noqa: BLE001 - see module docstring
            logger.warning("parse cache write failed", extra={
                "process_id": process_id, "file_id": file_id, "error": str(exc),
            })

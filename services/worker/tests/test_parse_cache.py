"""Unit tests for app.pdf.cache.ParseCache - the layer between app.pipeline
and Redis. Pipeline-level behaviour (skipping extraction on a hit, copying
page images, falling back to parsing on a corrupt entry or an unreachable
Redis) is covered in test_pipeline.py's own "Parse cache" section; these
tests are about ParseCache's own contract: what get()/set() return, and what
inspector_parse_cache_total ends up counting them as (see test_metrics.py
for the counter assertions themselves, in that file's own before/after
style).
"""

import pytest

from app.config import Config
from app.pdf.cache import ParseCache, cache_key


class FakeRedis:
    """Stands in for redis.asyncio.Redis's own get/set."""

    def __init__(self, data: dict[str, bytes] | None = None):
        self.data: dict[str, bytes] = dict(data or {})

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, ex=None):
        self.data[key] = value.encode() if isinstance(value, str) else value


class RaisingRedis:
    """A Redis that is simply unreachable - every call raises."""

    async def get(self, key):
        raise ConnectionError("redis unreachable")

    async def set(self, key, value, ex=None):
        raise ConnectionError("redis unreachable")


def test_cache_key_includes_the_parser_version():
    assert cache_key(1, "abc123") == "parse:v1:abc123"
    assert cache_key(1, "abc123") != cache_key(2, "abc123")


@pytest.mark.asyncio
async def test_get_is_a_miss_when_the_key_is_absent():
    cache = ParseCache(FakeRedis(), ttl_s=100.0)

    entry = await cache.get(1, "hash-a", process_id="p1", file_id="f1")

    assert entry is None


@pytest.mark.asyncio
async def test_set_then_get_round_trips_the_entry():
    cache = ParseCache(FakeRedis(), ttl_s=100.0)
    written = {"source_file_id": "f1", "pages": [{"page_no": 1}]}

    await cache.set(1, "hash-a", written, process_id="p1", file_id="f1")
    entry = await cache.get(1, "hash-a", process_id="p1", file_id="f1")

    assert entry == written


@pytest.mark.asyncio
async def test_get_falls_back_to_a_miss_on_malformed_json(caplog):
    redis = FakeRedis({cache_key(1, "hash-a"): b"{not json"})
    cache = ParseCache(redis, ttl_s=100.0)

    with caplog.at_level("WARNING", logger="app.pdf.cache"):
        entry = await cache.get(1, "hash-a", process_id="p1", file_id="f1")

    assert entry is None
    assert any(r.msg == "parse cache entry corrupt" for r in caplog.records)


@pytest.mark.asyncio
async def test_get_falls_back_to_a_miss_on_a_non_object_json_value(caplog):
    """A syntactically valid JSON array or scalar is not a parse-cache entry
    - app.pipeline only ever writes JSON objects here."""
    redis = FakeRedis({cache_key(1, "hash-a"): b"[1, 2, 3]"})
    cache = ParseCache(redis, ttl_s=100.0)

    with caplog.at_level("WARNING", logger="app.pdf.cache"):
        entry = await cache.get(1, "hash-a", process_id="p1", file_id="f1")

    assert entry is None
    assert any(r.msg == "parse cache entry corrupt" for r in caplog.records)


@pytest.mark.asyncio
async def test_get_falls_back_to_a_miss_when_redis_raises(caplog):
    cache = ParseCache(RaisingRedis(), ttl_s=100.0)

    with caplog.at_level("WARNING", logger="app.pdf.cache"):
        entry = await cache.get(1, "hash-a", process_id="p1", file_id="f1")

    assert entry is None
    assert any(r.msg == "parse cache lookup failed" for r in caplog.records)


@pytest.mark.asyncio
async def test_set_swallows_a_redis_error_instead_of_raising(caplog):
    cache = ParseCache(RaisingRedis(), ttl_s=100.0)

    with caplog.at_level("WARNING", logger="app.pdf.cache"):
        await cache.set(1, "hash-a", {"pages": []}, process_id="p1", file_id="f1")

    assert any(r.msg == "parse cache write failed" for r in caplog.records)


@pytest.mark.asyncio
async def test_a_disabled_cache_is_an_unconditional_miss_and_a_no_op():
    """client=None (config.redis_url unset) is how app.pdf.cache represents
    the cache being turned off outright - every call degenerates instead of
    needing app.pipeline to branch on whether caching is configured."""
    cache = ParseCache(None, ttl_s=100.0)

    entry = await cache.get(1, "hash-a", process_id="p1", file_id="f1")
    await cache.set(1, "hash-a", {"pages": []}, process_id="p1", file_id="f1")  # must not raise
    await cache.close()  # must not raise

    assert entry is None


def test_from_config_is_disabled_when_redis_url_is_empty():
    config = Config(
        database_url="", rabbitmq_url="", log_level="INFO", minio_endpoint="",
        minio_root_user="", minio_root_password="", minio_bucket="",
        model_version="v", dataset_version="v", llm_base_url="", llm_model="",
        llm_timeout_s=1.0, redis_url="",
    )

    cache = ParseCache.from_config(config)

    assert cache._client is None


def test_from_config_builds_a_client_when_redis_url_is_set():
    config = Config(
        database_url="", rabbitmq_url="", log_level="INFO", minio_endpoint="",
        minio_root_user="", minio_root_password="", minio_bucket="",
        model_version="v", dataset_version="v", llm_base_url="", llm_model="",
        llm_timeout_s=1.0, redis_url="redis://localhost:6379/0", parse_cache_ttl_s=123.0,
    )

    cache = ParseCache.from_config(config)

    assert cache._client is not None
    assert cache._ttl_s == 123.0

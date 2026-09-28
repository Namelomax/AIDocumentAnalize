import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    rabbitmq_url: str
    log_level: str
    minio_endpoint: str
    minio_root_user: str
    minio_root_password: str
    minio_bucket: str
    # Honest values, not placeholders: the comparison is a rule engine with no
    # trained model behind it yet, and no GOLD dataset has been released. The
    # specification requires both versions in every protocol; claiming a model
    # or a dataset that does not exist would misstate how a result was made.
    model_version: str
    dataset_version: str
    # Address of an OpenAI-compatible /chat/completions endpoint for the free
    # -search hypothesis checks (plan 8). Empty means no model is configured
    # -- the worker must keep working without one, so this is never required
    # like the values above. No default ever names a real host: that would
    # put an address in the code, which the architecture forbids.
    llm_base_url: str
    llm_model: str
    llm_timeout_s: float
    # Customer's ТЗ, "Обработка ошибок при загрузке" (p.17): a file whose
    # extraction times out or errors is retried up to this many further times
    # before the failure is recorded and an admin is notified; a whole
    # process.start task that keeps raising is retried the same number of
    # times before the process is moved to FAILED. Defaulted here too (not
    # just in load_config) so existing call sites that build a Config without
    # naming these two fields - every test fixture predating this task - keep
    # working unchanged.
    file_processing_timeout_s: float = 300.0
    processing_retries: int = 2
    # Customer's ТЗ p.31, "Интеграция с Prometheus": the worker has no HTTP
    # server of its own otherwise, so /metrics gets a dedicated port rather
    # than sharing one with anything else. Defaulted here too, same reason as
    # the two fields above.
    metrics_port: int = 9100
    # Customer's ТЗ p.16, п.5 "Кеширование": PDF parse results are cached in
    # Redis by file hash. Empty turns the cache off outright (app.pdf.cache
    # treats it the same as an unreachable Redis, minus the warning - there
    # is nothing to be unreachable) - a stand without the redis service, or a
    # test's Config that never names this field, must keep working exactly
    # as before this feature existed. Defaulted here too, same reason as the
    # fields above.
    redis_url: str = ""
    # 30 days: long enough that a re-check against the same package days
    # later still hits, short enough that a stand's Redis does not accumulate
    # entries for files nobody will ever re-upload. Defaulted here too, same
    # reason as the fields above.
    parse_cache_ttl_s: float = 30 * 24 * 3600.0


def load_config() -> Config:
    return Config(
        database_url=os.environ["DATABASE_URL"],
        rabbitmq_url=os.environ["RABBITMQ_URL"],
        log_level=os.environ.get("LOG_LEVEL", "info").upper(),
        minio_endpoint=os.environ["MINIO_ENDPOINT"],
        minio_root_user=os.environ["MINIO_ROOT_USER"],
        minio_root_password=os.environ["MINIO_ROOT_PASSWORD"],
        minio_bucket=os.environ["MINIO_BUCKET"],
        model_version=os.environ.get("MODEL_VERSION", "rules-2026.09"),
        dataset_version=os.environ.get("DATASET_VERSION", "none"),
        llm_base_url=os.environ.get("LLM_BASE_URL", ""),
        llm_model=os.environ.get("LLM_MODEL", ""),
        llm_timeout_s=float(os.environ.get("LLM_TIMEOUT_S", "60")),
        file_processing_timeout_s=float(os.environ.get("FILE_PROCESSING_TIMEOUT_S", "300")),
        processing_retries=int(os.environ.get("PROCESSING_RETRIES", "2")),
        metrics_port=int(os.environ.get("METRICS_PORT", "9100")),
        redis_url=os.environ.get("REDIS_URL", "redis://redis:6379/0"),
        parse_cache_ttl_s=float(os.environ.get("PARSE_CACHE_TTL_S", str(30 * 24 * 3600))),
    )

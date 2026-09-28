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
    # Section 9.5's hypotheses (SEM-ROOM-FN) are asked about in batches of
    # this many room-name pairs per model call rather than the whole package
    # in one request: the reference school package's 23 pairs in one call
    # outran LLM_TIMEOUT_S's default 60s entirely (app.pipeline's own module
    # docstring). Defaulted here too, same reason as the two fields above.
    llm_batch_size: int = 5
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
    # Customer's ТЗ p.16, п.1 "Распознавание текста (OCR)": a page with no
    # text layer (app.pdf.extract's needs_ocr) is handed to a local
    # OpenAI-compatible OCR model (app.ocr.client) - same shape of interface
    # as the free-search language model above, and the same rule: empty
    # means off, never a real host in a default. Defaults to llm_base_url
    # (load_config, not here - a dataclass default can't see a sibling
    # field) since dev and the stand both already point LLM_BASE_URL at the
    # one local model server; ocr_base_url only needs its own value when OCR
    # is actually served from somewhere else.
    ocr_base_url: str = ""
    # Empty turns OCR off outright, the same way redis_url="" turns the parse
    # cache off - a page that needs OCR simply stays needs_ocr with a
    # LOW_QUALITY status (app.pipeline), not an error.
    ocr_model: str = ""
    # LM Studio on the reference dev machine answered a single strip
    # (roughly 1500x2500px at 300 dpi) in 40-90s - an order of magnitude
    # slower than the JSON-answering chat model above, because OCR reads
    # the whole image rather than a short prompt. Defaulted generously so a
    # real page (several strips) does not spuriously fail on a slow local
    # box; the stand's own model (vLLM on the H100) is expected to clear
    # this with room to spare.
    ocr_timeout_s: float = 120.0
    # Customer's ТЗ p.16, п.1: "не менее 300 dpi" - the floor the acceptance
    # sample is measured at, not a ceiling; kept as the default rather than
    # going higher because it already matches the CER numbers
    # docs/quality/ocr-eval.json records.
    ocr_dpi: int = 300
    # app.ocr.tiling's own strategy: the model returns plain text with no
    # boxes (probed manually against glm-ocr, see that module's docstring),
    # so a page is cut into horizontal strips before OCR and each returned
    # line is given an even share of its strip's own box. 800px at 300 dpi
    # is roughly a paragraph's worth of lines for this sheet's typical body
    # text (measured against the reference package) - fine enough that a
    # strip rarely holds two unrelated table rows, coarse enough that a
    # sheet does not need dozens of slow model calls to finish.
    ocr_strip_height_px: int = 800


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
        llm_batch_size=int(os.environ.get("LLM_BATCH_SIZE", "5")),
        file_processing_timeout_s=float(os.environ.get("FILE_PROCESSING_TIMEOUT_S", "300")),
        processing_retries=int(os.environ.get("PROCESSING_RETRIES", "2")),
        metrics_port=int(os.environ.get("METRICS_PORT", "9100")),
        redis_url=os.environ.get("REDIS_URL", "redis://redis:6379/0"),
        parse_cache_ttl_s=float(os.environ.get("PARSE_CACHE_TTL_S", str(30 * 24 * 3600))),
        # OCR_BASE_URL falls back to LLM_BASE_URL here (not in the
        # dataclass default, which cannot see a sibling field) - see
        # Config.ocr_base_url's own comment.
        ocr_base_url=os.environ.get("OCR_BASE_URL") or os.environ.get("LLM_BASE_URL", ""),
        ocr_model=os.environ.get("OCR_MODEL", ""),
        ocr_timeout_s=float(os.environ.get("OCR_TIMEOUT_S", "120")),
        ocr_dpi=int(os.environ.get("OCR_DPI", "300")),
        ocr_strip_height_px=int(os.environ.get("OCR_STRIP_HEIGHT_PX", "800")),
    )

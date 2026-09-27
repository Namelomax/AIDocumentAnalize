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
    )

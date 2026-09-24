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


def load_config() -> Config:
    return Config(
        database_url=os.environ["DATABASE_URL"],
        rabbitmq_url=os.environ["RABBITMQ_URL"],
        log_level=os.environ.get("LOG_LEVEL", "info").upper(),
        minio_endpoint=os.environ["MINIO_ENDPOINT"],
        minio_root_user=os.environ["MINIO_ROOT_USER"],
        minio_root_password=os.environ["MINIO_ROOT_PASSWORD"],
        minio_bucket=os.environ["MINIO_BUCKET"],
    )

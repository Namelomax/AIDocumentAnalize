import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    rabbitmq_url: str
    log_level: str


def load_config() -> Config:
    return Config(
        database_url=os.environ["DATABASE_URL"],
        rabbitmq_url=os.environ["RABBITMQ_URL"],
        log_level=os.environ.get("LOG_LEVEL", "info").upper(),
    )

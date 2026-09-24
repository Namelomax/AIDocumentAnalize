import logging
from pythonjsonlogger import jsonlogger


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(jsonlogger.JsonFormatter(
        "%(asctime)s %(levelname)s %(message)s",
        rename_fields={"asctime": "timestamp", "levelname": "level"},
        static_fields={"service": "worker"},
    ))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

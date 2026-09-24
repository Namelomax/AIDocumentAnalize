import logging
from datetime import datetime, timezone

from pythonjsonlogger.json import JsonFormatter


class UtcJsonFormatter(JsonFormatter):
    """JSON formatter whose timestamp matches the API's Node output byte for byte.

    Central log collection keys events across services on this field, so it
    must be UTC (this host runs local time eight hours off UTC) and in the
    same "%Y-%m-%dT%H:%M:%S.%3fZ" shape the Node side emits, not the stdlib
    default of local time with a comma before milliseconds and no zone.
    """

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        dt = datetime.fromtimestamp(record.created, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _build_formatter() -> logging.Formatter:
    return UtcJsonFormatter(
        "%(asctime)s %(levelname)s %(message)s",
        rename_fields={"asctime": "timestamp", "levelname": "level"},
        static_fields={"service": "worker"},
        # request_id/user_id are part of the shared log schema and must be
        # present even when the caller has none to report; extra={} on a
        # given log call still overrides these.
        defaults={"request_id": None, "user_id": None},
    )


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(_build_formatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

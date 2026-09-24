import json
import logging
import re

from app.logging_setup import _build_formatter

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def _make_record(**extra) -> logging.LogRecord:
    record = logging.LogRecord(
        name="app.consumer",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="task routed",
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_timestamp_is_iso8601_utc_with_millis_and_z_suffix():
    line = _build_formatter().format(_make_record())
    data = json.loads(line)

    assert TIMESTAMP_RE.match(data["timestamp"]), data["timestamp"]


def test_log_line_has_all_six_required_fields():
    line = _build_formatter().format(_make_record())
    data = json.loads(line)

    for key in ("timestamp", "level", "service", "message", "request_id", "user_id"):
        assert key in data

    assert data["request_id"] is None
    assert data["user_id"] is None
    assert data["service"] == "worker"
    assert data["level"] == "INFO"
    assert data["message"] == "task routed"


def test_extra_request_id_overrides_the_default_null():
    line = _build_formatter().format(_make_record(request_id="REQ-123"))
    data = json.loads(line)

    assert data["request_id"] == "REQ-123"

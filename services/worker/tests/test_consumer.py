import asyncio
import json
import logging

import pytest
from app import consumer as consumer_module
from app.consumer import _consume_messages, handle_task, UnknownTaskType
from app.pipeline import process_start, process_update


class FakeDb:
    """A process-less database: process_start's "process not found" branch
    is the cheapest way to exercise routing without a real PostgreSQL."""

    async def get_process(self, process_id):
        return None


class FakeStorage:
    pass


class FakeConfig:
    """Stands in for app.config.Config: these tests never reach the branch
    that reads model_version/dataset_version (get_process returns None), so
    a minimal stand-in is enough. processing_retries is read by
    app.pipeline.process_start's own retry wrapper before it ever calls
    get_process, so it is still needed here."""
    model_version = "rules-2026.09"
    dataset_version = "none"
    processing_retries = 2


def test_routes_process_start_to_the_pipeline_handler():
    payload = {"type": "process.start", "process_id": "p1", "object_id": "o1"}
    assert handle_task(payload) is process_start


def test_routes_process_update_to_the_pipeline_handler():
    # Customer's ТЗ "Дозагрузка файлов": services/api's routes/
    # processDocuments.ts publishes this task type instead of process.start
    # once a process already has a protocol.
    payload = {"type": "process.update", "process_id": "p1", "object_id": "o1", "file_ids": ["f1"]}
    assert handle_task(payload) is process_update


@pytest.mark.asyncio
async def test_process_update_message_threads_file_ids_through(monkeypatch):
    """process_update is the only handler that takes file_ids - proves
    _process_message actually forwards the payload's own list to it, and
    that process_start (which accepts no such keyword) never receives it."""
    received = {}

    async def fake_process_update(process_id, db, storage, config, *, cache=None, file_ids=None):
        received["process_id"] = process_id
        received["file_ids"] = file_ids

    monkeypatch.setitem(consumer_module.HANDLERS, "process.update", fake_process_update)
    payload = {"type": "process.update", "process_id": "p1", "object_id": "o1", "file_ids": ["f1", "f2"]}
    message = FakeMessage(json.dumps(payload).encode())

    await _consume_messages(_fake_messages(message), FakeDb(), FakeStorage(), FakeConfig())

    assert received == {"process_id": "p1", "file_ids": ["f1", "f2"]}
    assert message.acked is True


def test_unknown_task_type_raises():
    with pytest.raises(UnknownTaskType):
        handle_task({"type": "nonsense", "process_id": "p1", "object_id": "o1"})


def test_missing_process_id_raises():
    with pytest.raises(ValueError):
        handle_task({"type": "process.start", "object_id": "o1"})


class FakeProcessContext:
    """Mimics aio_pika's ProcessContext: acks on success, rejects (no requeue)
    on exception, and does not suppress the exception -- matching the real
    __aexit__, which returns a falsy value and lets it propagate."""

    def __init__(self, message):
        self.message = message

    async def __aenter__(self):
        return self.message

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.message.acked = True
        else:
            self.message.rejected = True
        return False


class FakeMessage:
    def __init__(self, body: bytes):
        self.body = body
        self.acked = False
        self.rejected = False

    def process(self):
        return FakeProcessContext(self)


async def _fake_messages(*messages):
    for message in messages:
        yield message


@pytest.mark.asyncio
async def test_bad_message_does_not_stop_the_loop_and_is_rejected_without_requeue():
    bad = FakeMessage(b"not json")
    good_payload = {"type": "process.start", "process_id": "p1", "object_id": "o1"}
    good = FakeMessage(json.dumps(good_payload).encode())

    await _consume_messages(_fake_messages(bad, good), FakeDb(), FakeStorage(), FakeConfig())

    assert bad.rejected is True
    assert bad.acked is False
    assert good.acked is True


@pytest.mark.asyncio
async def test_bad_message_is_logged_at_error_with_process_id_when_available(caplog):
    payload = {"type": "nonsense", "process_id": "p1", "object_id": "o1"}
    message = FakeMessage(json.dumps(payload).encode())

    with caplog.at_level(logging.ERROR, logger="app.consumer"):
        await _consume_messages(_fake_messages(message), FakeDb(), FakeStorage(), FakeConfig())

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelname == "ERROR"
    assert record.process_id == "p1"


@pytest.mark.asyncio
async def test_cancelled_error_is_not_swallowed():
    class CancellingMessage(FakeMessage):
        def process(self):
            raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await _consume_messages(_fake_messages(CancellingMessage(b"{}")), FakeDb(), FakeStorage(), FakeConfig())

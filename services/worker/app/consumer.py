"""Task routing for messages published by the Node API.

The API publishes plain JSON rather than Celery's own envelope, so routing is
explicit here.
"""

import asyncio
import json
import logging
import os

from app.pipeline import process_hypotheses, process_start, process_update

logger = logging.getLogger(__name__)

# Must stay in step with the API's TASK_QUEUE: if the two ever name different
# queues, tasks are published into the void and nothing reports an error.
TASK_QUEUE = os.environ.get("TASK_QUEUE", "inspector.tasks")


class UnknownTaskType(Exception):
    pass


# Task types that carry file_ids (payload.get("file_ids"), threaded through
# in _process_message below): process.update's own дозагрузка file list, and
# process.hypotheses's own scope (null for "every pair", a list for "only
# pairs a new file touches" - see app.pipeline's own module docstring).
# process.start takes no such keyword at all.
_FILE_IDS_TASK_TYPES = {"process.update", "process.hypotheses"}

HANDLERS = {
    "process.start": process_start,
    # Customer's ТЗ "Дозагрузка файлов": services/api's routes/
    # processDocuments.ts publishes this instead of process.start once a
    # process already has a protocol - process_update's extra `file_ids`
    # keyword (which task_type below is what tells this loop to pass) is
    # threaded through in _process_message, not here.
    "process.update": process_update,
    # The follow-up task process.start/process.update publish once their own
    # matrix work is READY (app.pipeline's own module docstring) - never
    # published by the API, only by the worker itself, on the same
    # connection/channel it is already consuming from (see Publisher below).
    "process.hypotheses": process_hypotheses,
}


def handle_task(payload: dict):
    if "process_id" not in payload:
        raise ValueError("task payload has no process_id")

    task_type = payload.get("type")
    handler = HANDLERS.get(task_type)
    if handler is None:
        raise UnknownTaskType(f"no handler for task type {task_type!r}")

    logger.info("task routed", extra={"task_type": task_type,
                                      "process_id": payload["process_id"],
                                      "handler": handler.__name__})
    return handler


async def _process_message(message, db, storage, config, *, cache=None, publisher=None) -> None:
    """Parse and route one message, ack'ing or rejecting it via message.process()."""
    async with message.process():
        payload = json.loads(message.body.decode())
        handler = handle_task(payload)
        extra = {"file_ids": payload.get("file_ids")} if payload.get("type") in _FILE_IDS_TASK_TYPES else {}
        # publisher is only meaningful to process_start/process_update (the
        # ones that publish a process.hypotheses follow-up); process_hypotheses
        # itself never publishes anything further, but accepts the keyword
        # too so every handler can be called the same way here.
        await handler(payload["process_id"], db, storage, config, cache=cache, publisher=publisher, **extra)


def _extract_process_id(message) -> str | None:
    """Best-effort process_id recovery for error logging.

    Called only after message.process() has already rejected the message, so
    a second parse failure here is expected for malformed payloads and must
    not itself raise.
    """
    try:
        payload = json.loads(message.body.decode())
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload.get("process_id") if isinstance(payload, dict) else None


async def _consume_messages(messages, db, storage, config, *, cache=None, publisher=None) -> None:
    """Drive the message loop, isolating each message's failure from the rest.

    message.process() rejects (without requeue) the message that raised and
    then lets that same exception continue out of its __aexit__ instead of
    swallowing it. Left uncaught here, it would escape the async for and take
    the whole consumer process down over a single bad message. A message we
    cannot parse or route once will not parse or route on a retry either, so
    it is rejected outright rather than requeued into a retry loop.
    """
    async for message in messages:
        try:
            await _process_message(message, db, storage, config, cache=cache, publisher=publisher)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("failed to process message: %s", exc,
                         extra={"process_id": _extract_process_id(message)})


class Publisher:
    """Publishes a follow-up task onto TASK_QUEUE, over the same connection
    and channel this module is already consuming from (plan's own "publish
    from the worker with aio-pika on the same connection/channel") - never a
    second connection just to send one message back to the queue it came
    from.

    Only app.pipeline.process_start/process_update ever call this, to
    publish "process.hypotheses" once their own matrix work is READY (see
    app.pipeline's own module docstring for why that call is not made
    inline). Kept here, next to TASK_QUEUE and the channel that owns it,
    rather than in app.pipeline - the pipeline module has no business
    knowing aio-pika's own message shape.
    """

    def __init__(self, channel, queue_name: str):
        self._channel = channel
        self._queue_name = queue_name

    async def publish(self, task: dict) -> None:
        import aio_pika

        await self._channel.default_exchange.publish(
            aio_pika.Message(
                body=json.dumps(task).encode(),
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=self._queue_name,
        )


async def consume(connection_url: str, db, storage, config, *, cache=None) -> None:
    import aio_pika

    connection = await aio_pika.connect_robust(connection_url)
    channel = await connection.channel()
    queue = await channel.declare_queue(TASK_QUEUE, durable=True)
    publisher = Publisher(channel, TASK_QUEUE)

    async with queue.iterator() as messages:
        await _consume_messages(messages, db, storage, config, cache=cache, publisher=publisher)

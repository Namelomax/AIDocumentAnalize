"""Task routing for messages published by the Node API.

The API publishes plain JSON rather than Celery's own envelope, so routing is
explicit here.
"""

import asyncio
import json
import logging
import os

from app.pipeline import process_start

logger = logging.getLogger(__name__)

# Must stay in step with the API's TASK_QUEUE: if the two ever name different
# queues, tasks are published into the void and nothing reports an error.
TASK_QUEUE = os.environ.get("TASK_QUEUE", "inspector.tasks")


class UnknownTaskType(Exception):
    pass


HANDLERS = {
    "process.start": process_start,
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


async def _process_message(message, db, storage, config) -> None:
    """Parse and route one message, ack'ing or rejecting it via message.process()."""
    async with message.process():
        payload = json.loads(message.body.decode())
        handler = handle_task(payload)
        await handler(payload["process_id"], db, storage, config)


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


async def _consume_messages(messages, db, storage, config) -> None:
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
            await _process_message(message, db, storage, config)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("failed to process message: %s", exc,
                         extra={"process_id": _extract_process_id(message)})


async def consume(connection_url: str, db, storage, config) -> None:
    import aio_pika

    connection = await aio_pika.connect_robust(connection_url)
    channel = await connection.channel()
    queue = await channel.declare_queue(TASK_QUEUE, durable=True)

    async with queue.iterator() as messages:
        await _consume_messages(messages, db, storage, config)

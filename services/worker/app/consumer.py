"""Task routing for messages published by the Node API.

The API publishes plain JSON rather than Celery's own envelope, so routing is
explicit here.
"""

import json
import logging

logger = logging.getLogger(__name__)

TASK_QUEUE = "inspector.tasks"


class UnknownTaskType(Exception):
    pass


HANDLERS = {
    "process.start": "pipeline.start",
}


def handle_task(payload: dict) -> str:
    if "process_id" not in payload:
        raise ValueError("task payload has no process_id")

    task_type = payload.get("type")
    handler = HANDLERS.get(task_type)
    if handler is None:
        raise UnknownTaskType(f"no handler for task type {task_type!r}")

    logger.info("task routed", extra={"task_type": task_type,
                                      "process_id": payload["process_id"],
                                      "handler": handler})
    return handler


async def consume(connection_url: str) -> None:
    import aio_pika

    connection = await aio_pika.connect_robust(connection_url)
    channel = await connection.channel()
    queue = await channel.declare_queue(TASK_QUEUE, durable=True)

    async with queue.iterator() as messages:
        async for message in messages:
            async with message.process():
                payload = json.loads(message.body.decode())
                handle_task(payload)

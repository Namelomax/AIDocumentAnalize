import asyncio

from app.config import load_config
from app.consumer import consume
from app.logging_setup import setup_logging


def main() -> None:
    config = load_config()
    setup_logging(config.log_level)
    asyncio.run(consume(config.rabbitmq_url))


if __name__ == "__main__":
    main()

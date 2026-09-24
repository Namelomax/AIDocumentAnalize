"""Fetching raw object bytes from MinIO.

This is the only module that talks to object storage. The domain code and
the pipeline only ever see bytes, so the pipeline can be exercised in tests
against a fake without a real MinIO instance.
"""

import asyncio

from minio import Minio

from app.config import Config


class ManifestStorage:
    def __init__(self, config: Config):
        self._client = Minio(
            config.minio_endpoint,
            access_key=config.minio_root_user,
            secret_key=config.minio_root_password,
            secure=False,
        )
        self._bucket = config.minio_bucket

    async def get_object(self, storage_key: str) -> bytes:
        # minio-py performs blocking network I/O; running it on a worker
        # thread keeps the event loop free to keep servicing the queue.
        return await asyncio.to_thread(self._get_object_sync, storage_key)

    def _get_object_sync(self, storage_key: str) -> bytes:
        response = self._client.get_object(self._bucket, storage_key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

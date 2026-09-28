"""Fetching raw object bytes from MinIO.

This is the only module that talks to object storage. The domain code and
the pipeline only ever see bytes, so the pipeline can be exercised in tests
against a fake without a real MinIO instance.
"""

import asyncio
import io

from minio import Minio
from minio.commonconfig import CopySource

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

    async def put_object(self, storage_key: str, data: bytes, content_type: str) -> None:
        # The minio client is blocking; off-loading it keeps the consumer loop
        # free to handle other messages while a large sheet is being written.
        await asyncio.to_thread(
            self._client.put_object,
            self._bucket,
            storage_key,
            io.BytesIO(data),
            length=len(data),
            content_type=content_type,
        )

    async def copy_object(self, source_key: str, dest_key: str) -> None:
        # Used by the parse cache (app.pdf.cache): a page image rendered for
        # an earlier file with the same hash is reused by copying it inside
        # MinIO rather than round-tripping the bytes through the worker.
        # Raises (notably S3Error for a source key that no longer exists) -
        # the caller decides whether that means falling back to a re-render,
        # the same way this module leaves every other failure to its caller.
        await asyncio.to_thread(self._copy_object_sync, source_key, dest_key)

    def _copy_object_sync(self, source_key: str, dest_key: str) -> None:
        self._client.copy_object(self._bucket, dest_key, CopySource(self._bucket, source_key))

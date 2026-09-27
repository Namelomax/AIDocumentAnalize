#!/usr/bin/env bash
set -euo pipefail

# Run this on a machine that has internet access to prepare a delivery
# bundle for the offline test stand. It builds/pulls every image the
# stack needs and freezes them into a single tar so "docker load" is
# the only network-free step left on the stand.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Third-party images are pinned by digest, either directly in
# docker-compose.yml (postgres, redis, rabbitmq, minio) or as the base image
# of services/web/Dockerfile (nginx). We pin them here too rather than
# re-deriving them, to guarantee the bundle matches exactly what compose and
# the web build will run. Building the web image below already pulls the
# nginx base layer locally, so saving it here just makes it explicit.
THIRD_PARTY_IMAGES=(
  "pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
  "redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499"
  "rabbitmq@sha256:606d8c0d6b3c18d1da9afc53bc7cdb2a8d5486df91b5a9830e9e07626c9ae281"
  "quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
  "nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10"
)

# Images we build ourselves, tagged so "docker compose up" on the stand
# picks up the loaded image instead of trying to build it.
OWN_IMAGES=(
  "inspector-api:1.0.0"
  "inspector-worker:1.0.0"
  "inspector-web:1.0.0"
)

echo "Building api, worker and web images..."
docker compose build

echo "Pulling third-party images..."
docker compose pull

mkdir -p dist

BUNDLE_PATH="dist/inspector-images.tar"

echo "Saving all eight images to ${BUNDLE_PATH}..."
docker save -o "${BUNDLE_PATH}" "${THIRD_PARTY_IMAGES[@]}" "${OWN_IMAGES[@]}"

BUNDLE_SIZE=$(du -h "${BUNDLE_PATH}" | cut -f1)
echo "Bundle ready: ${BUNDLE_PATH} (${BUNDLE_SIZE})"
echo "On the offline stand, run: docker load -i ${BUNDLE_PATH}"

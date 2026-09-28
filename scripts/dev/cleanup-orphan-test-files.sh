#!/usr/bin/env bash
set -euo pipefail

# Before this repo's tests were fixed to clean up after themselves (see
# tests/e2e/test_upload_flow.sh step 28 and services/api/tests/*.test.ts),
# some of them inserted a `files` row whose storage_key never had a matching
# object put into MinIO, and never deleted it either. On a stand where any
# of those tests ever ran, integrity.ts's daily sweep (customer's ТЗ p.31)
# reports every one of those rows MISSING forever - not a real incident, just
# old test debt. Fresh test runs no longer create this debt; this is a
# one-off way to find and, only with --apply, remove what earlier ones left
# behind.
#
# Dry run by default: lists what it would delete without touching the
# database. Pass --apply to actually delete. Never deletes anything whose
# object it could not confirm missing.

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

APPLY=0
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
fi

echo "Checking every files row's storage_key against MinIO (this can take a while on a large table)..."

ROWS=$(docker compose exec -T postgres psql -U inspector -d inspector -tA -F $'\t' \
  -c "SELECT id, storage_key, file_name FROM files ORDER BY uploaded_at;")

# One docker compose exec for the whole sweep rather than one per row - a
# few hundred/thousand separate `docker compose exec` calls would each pay
# its own container-exec startup cost, which is what actually makes this
# slow, not mc stat itself.
RESULTS=$(docker compose exec -T minio sh -c '
  mc alias set cleanup http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  while IFS="$(printf "\t")" read -r id storage_key file_name; do
    [ -z "$id" ] && continue
    if mc stat "cleanup/documents/${storage_key}" >/dev/null 2>&1; then
      continue
    fi
    printf "%s\t%s\t%s\n" "$id" "$storage_key" "$file_name"
  done
' <<< "$ROWS")

TOTAL=$(echo "$ROWS" | grep -c . || true)
MISSING_COUNT=0
if [ -n "$RESULTS" ]; then
  MISSING_COUNT=$(echo "$RESULTS" | grep -c . || true)
fi

echo ""
echo "Checked $TOTAL files rows; $MISSING_COUNT have no matching object in MinIO."

if [ "$MISSING_COUNT" -eq 0 ]; then
  echo "Nothing to clean up."
  exit 0
fi

echo ""
echo "Missing objects:"
echo "$RESULTS" | awk -F'\t' '{ printf "  file_id=%s storage_key=%s file_name=%s\n", $1, $2, $3 }'

if [ "$APPLY" -ne 1 ]; then
  echo ""
  echo "Dry run only - nothing was deleted. Re-run with --apply to delete these"
  echo "$MISSING_COUNT files rows and their evidence_fragments (the only row"
  echo "type an FK actually requires deleting first - pages cascade from the"
  echo "file itself). Nothing else (checks, processes, objects) is touched."
  exit 0
fi

IDS_SQL=$(echo "$RESULTS" | cut -f1 | awk '{ printf "'"'"'%s'"'"',", $0 }' | sed 's/,$//')

echo ""
echo "Deleting $MISSING_COUNT files rows and their evidence_fragments..."
docker compose exec -T postgres psql -U inspector -d inspector -v ON_ERROR_STOP=1 <<SQL
DELETE FROM evidence_fragments WHERE file_id IN (${IDS_SQL});
DELETE FROM files WHERE id IN (${IDS_SQL});
SQL

echo "Done."

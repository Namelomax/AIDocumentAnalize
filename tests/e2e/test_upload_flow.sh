#!/usr/bin/env bash
set -euo pipefail

API=http://localhost:3000/api/v1

echo "1. health"
curl -fsS "$API/health" | grep -q '"status":"ok"'

echo "2. create object"
OBJECT_ID=$(curl -fsS -X POST "$API/objects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Торговое здание","address":"Алтуфьевское ш., 79Б"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "3. upload a pdf"
printf '%%PDF-1.7 e2e' > /tmp/e2e.pdf
RESPONSE=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  -F 'files=@/tmp/e2e.pdf;type=application/pdf')
echo "$RESPONSE" | grep -q '"process_id"'
echo "$RESPONSE" | grep -q '"accepted":\[{'

PROCESS_ID=$(echo "$RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

echo "4. duplicate is rejected"
curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  -F 'files=@/tmp/e2e.pdf;type=application/pdf' | grep -q 'DUPLICATE'

echo "5. process status is readable"
curl -fsS "$API/processes/$PROCESS_ID" | grep -q '"status":"PENDING"'

echo "6. starting the process publishes a task"
curl -fsS -X POST "$API/processes/$PROCESS_ID/start" | grep -q '"status":"PARSING"'

echo "7. the worker actually received it"
# The only check in the whole plan that proves the two halves of the system
# are actually wired together: everything else only checks its own side of
# the boundary.
for _ in $(seq 1 20); do
  if docker compose logs worker 2>/dev/null | grep -q "$PROCESS_ID"; then
    echo "PASS"
    exit 0
  fi
  sleep 1
done

echo "FAIL: worker never logged process $PROCESS_ID" >&2
docker compose logs --tail 50 worker >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

API=http://localhost:3000/api/v1

echo "1. health"
curl -fsS "$API/health" | grep -q '"status":"ok"'

echo "2. create object"
# Тело пишем файлом в явном UTF-8: curl в Git Bash на Windows считает
# Content-Length в кодировке консоли и на кириллице расходится с телом.
mkdir -p .e2e-tmp
printf '%s' '{"name":"Торговое здание","address":"Алтуфьевское ш., 79Б"}' > .e2e-tmp/object.json
OBJECT_ID=$(curl -fsS -X POST "$API/objects" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "3. upload a pdf"
# Путь относительный намеренно: curl в Git Bash коверкает абсолютный путь,
# когда рядом стоит ';type=' — точка с запятой трактуется как разделитель
# списка путей Windows.
printf '%%PDF-1.7 e2e' > .e2e-tmp/upload.pdf
RESPONSE=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf')
echo "$RESPONSE" | grep -q '"process_id"'
echo "$RESPONSE" | grep -q '"accepted":\[{'

PROCESS_ID=$(echo "$RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

echo "4. duplicate is rejected"
# Без -f намеренно: пакет, в котором отклонены все файлы, отвечает 422,
# и это ожидаемый ответ, а не сбой запроса.
curl -sS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf' | grep -q 'DUPLICATE'

echo "5. process status is readable"
curl -fsS "$API/processes/$PROCESS_ID" | grep -q '"status":"PENDING"'

echo "6. starting the process publishes a task"
curl -fsS -X POST "$API/processes/$PROCESS_ID/start" | grep -q '"status":"PARSING"'

echo "7. the worker actually received it"
# The only check in the whole plan that proves the two halves of the system
# are actually wired together: everything else only checks its own side of
# the boundary.
SEEN=0
for _ in $(seq 1 20); do
  if docker compose logs worker 2>/dev/null | grep -q "$PROCESS_ID"; then
    SEEN=1
    break
  fi
  sleep 1
done

if [ "$SEEN" -ne 1 ]; then
  echo "FAIL: worker never logged process $PROCESS_ID" >&2
  docker compose logs --tail 50 worker >&2
  exit 1
fi

echo "8. a package with a registry is parsed end to end"
OBJECT2=$(curl -fsS -X POST "$API/objects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Registry probe"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

printf '%%PDF-1.7 ar' > .e2e-tmp/ar-01.pdf
printf '%%PDF-1.7 ov' > .e2e-tmp/ov-01.pdf
printf 'object_id,file_name,doc_stage,discipline,revision,approval_status\n%s,ar-01.pdf,PD,AR,1,APPROVED\n%s,ov-01.pdf,RD,OV,1,FOR_CONSTRUCTION\n' \
  "$OBJECT2" "$OBJECT2" > .e2e-tmp/reestr.csv

PROCESS2=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT2" \
  -F 'files=@.e2e-tmp/ar-01.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/ov-01.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reestr.csv;type=text/csv' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

curl -fsS -X POST "$API/processes/$PROCESS2/start" > /dev/null

echo "9. the worker parses the registry and reports completeness"
# The pipeline is asynchronous, so the status is polled rather than assumed.
for _ in $(seq 1 30); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS2" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "READY" ] && break
  sleep 1
done
[ "$STATUS" = "READY" ] || { echo "process stayed in $STATUS"; exit 1; }

curl -fsS "$API/processes/$PROCESS2" | grep -q '"scenario":"PD_RD_ONLY"'

echo "PASS"

#!/usr/bin/env bash
set -euo pipefail

API=http://localhost:3000/api/v1

echo "1. health"
curl -fsS "$API/health" | grep -q '"status":"ok"'

echo "2. log in as the demo inspector"
TOKEN=$(curl -fsS -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"login":"inspector","password":"inspector123"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["token"])')
AUTH=(-H "Authorization: Bearer $TOKEN")

echo "3. create object"
# Тело пишем файлом в явном UTF-8: curl в Git Bash на Windows считает
# Content-Length в кодировке консоли и на кириллице расходится с телом.
mkdir -p .e2e-tmp
printf '%s' '{"name":"Торговое здание","address":"Алтуфьевское ш., 79Б"}' > .e2e-tmp/object.json
OBJECT_ID=$(curl -fsS -X POST "$API/objects" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "4. upload a pdf"
# Путь относительный намеренно: curl в Git Bash коверкает абсолютный путь,
# когда рядом стоит ';type=' — точка с запятой трактуется как разделитель
# списка путей Windows.
printf '%%PDF-1.7 e2e' > .e2e-tmp/upload.pdf
RESPONSE=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf')
echo "$RESPONSE" | grep -q '"process_id"'
echo "$RESPONSE" | grep -q '"accepted":\[{'

PROCESS_ID=$(echo "$RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

echo "5. duplicate is rejected"
# Без -f намеренно: пакет, в котором отклонены все файлы, отвечает 422,
# и это ожидаемый ответ, а не сбой запроса.
curl -sS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf' | grep -q 'DUPLICATE'

echo "6. process status is readable"
curl -fsS "$API/processes/$PROCESS_ID" "${AUTH[@]}" | grep -q '"status":"PENDING"'

echo "7. starting the process publishes a task"
curl -fsS -X POST "$API/processes/$PROCESS_ID/start" "${AUTH[@]}" | grep -q '"status":"PARSING"'

echo "8. the worker actually received it"
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

echo "9. a package with a registry is parsed end to end"
OBJECT2=$(curl -fsS -X POST "$API/objects" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Registry probe"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# A bare %PDF magic number satisfies upload validation but has no text layer
# for the worker to read, so step 10 below would find no pages. These carry
# a minimal but structurally real page and content stream instead.
_mkpdf() {
  cat > "$1" <<PDF
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 20 100 Td ($2) Tj ET
endstream
endobj
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF
PDF
}
_mkpdf .e2e-tmp/ar-01.pdf "ar-01 sheet"
_mkpdf .e2e-tmp/ov-01.pdf "ov-01 sheet"
printf 'object_id,file_name,doc_stage,discipline,revision,approval_status\n%s,ar-01.pdf,PD,AR,1,APPROVED\n%s,ov-01.pdf,RD,OV,1,FOR_CONSTRUCTION\n' \
  "$OBJECT2" "$OBJECT2" > .e2e-tmp/reestr.csv

PROCESS2=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT2" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/ar-01.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/ov-01.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reestr.csv;type=text/csv' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

curl -fsS -X POST "$API/processes/$PROCESS2/start" "${AUTH[@]}" > /dev/null

echo "10. the worker parses the registry and reports completeness"
# The pipeline is asynchronous, so the status is polled rather than assumed.
for _ in $(seq 1 30); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS2" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "READY" ] && break
  sleep 1
done
[ "$STATUS" = "READY" ] || { echo "process stayed in $STATUS"; exit 1; }

curl -fsS "$API/processes/$PROCESS2" "${AUTH[@]}" | grep -q '"scenario":"PD_RD_ONLY"'

echo "11. pages with text are recorded for the uploaded documents"
PAGES=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM pages p JOIN files f ON f.id = p.file_id WHERE f.process_id = '$PROCESS2';")
[ "$PAGES" -ge 1 ] || { echo "no pages extracted for process $PROCESS2"; exit 1; }

echo "PASS"

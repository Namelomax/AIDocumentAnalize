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

# Fails loudly with the query and the value that did not fit, instead of the
# bare psql exit code set -e would otherwise report: this stage exists to
# prove the pipeline works end to end, so a silent pass here would defeat it.
assert_at_least() {
  local description="$1" sql="$2" min="$3"
  local value
  value=$(docker compose exec -T postgres psql -U inspector -d inspector -tA -c "$sql") \
    || { echo "FAIL: query for '$description' could not be run" >&2; exit 1; }
  value=$(echo "$value" | tr -d '[:space:]')
  if [ -z "$value" ] || [ "$value" -lt "$min" ] 2>/dev/null; then
    echo "FAIL: $description (expected >= $min, got '$value')" >&2
    exit 1
  fi
}

assert_zero() {
  local description="$1" sql="$2"
  local value
  value=$(docker compose exec -T postgres psql -U inspector -d inspector -tA -c "$sql") \
    || { echo "FAIL: query for '$description' could not be run" >&2; exit 1; }
  value=$(echo "$value" | tr -d '[:space:]')
  if [ "$value" != "0" ]; then
    echo "FAIL: $description (expected 0, got '$value')" >&2
    exit 1
  fi
}

echo "12. build a package from real reference sheets (school and Polyarnaya) and upload it"
# Полярная, 17 (negative reference) and the school on Полярная, 25 (positive
# reference, room 1.109) are different real objects, but their room numbers
# never collide - the school uses two-level numbers ("1.109"), Polyarnaya
# uses three-level ones ("1.0.9") - so one package/object is safe here and
# sheets still pair up correctly within it.
printf '%s' '{"name":"Эталонный пакет: Полярная 17 и школа на Полярной 25"}' > .e2e-tmp/reference-object.json
OBJECT3=$(curl -fsS -X POST "$API/objects" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/reference-object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# Reference PDFs and the venv with PyMuPDF live outside the API/worker
# containers, so the package is cut on the host and uploaded like any other.
services/worker/.venv/Scripts/python.exe tests/e2e/make_reference_package.py \
  .e2e-tmp/reference "$OBJECT3"

RESPONSE3=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT3" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/reference/sosh-pd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reference/sosh-rd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reference/pol17-pd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reference/pol17-rd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reference/reestr.csv;type=text/csv')
echo "$RESPONSE3" | grep -q '"process_id"'
PROCESS3=$(echo "$RESPONSE3" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

curl -fsS -X POST "$API/processes/$PROCESS3/start" "${AUTH[@]}" > /dev/null

echo "13. the reference package reaches READY"
for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS3" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "READY" ] && break
  sleep 1
done
[ "$STATUS" = "READY" ] || { echo "FAIL: reference process stayed in $STATUS" >&2; exit 1; }

echo "14. the school pair yields the added room as a candidate"
assert_at_least "CANDIDATE for room 1.109 with actual area 18.20" \
  "SELECT count(*) FROM checks WHERE process_id = '$PROCESS3' AND finding_status = 'CANDIDATE' AND subject = 'room 1.109' AND actual_value = '18.20';" \
  1

echo "15. the school pair's floor total (+0.29%) is a verified negative, not a candidate"
# 6234.10 -> 6252.30 is a systematic recalculation well inside M-002's own 1%
# ceiling (specs/params/M-002.yaml compare_threshold): app.explication.compare
# now reports it NEGATIVE_VERIFIED rather than as a second candidate next to
# room 1.109.
assert_at_least "NEGATIVE_VERIFIED for floor total 6234.10 -> 6252.30" \
  "SELECT count(*) FROM checks WHERE process_id = '$PROCESS3' AND finding_status = 'NEGATIVE_VERIFIED' AND subject = 'floor total' AND expected_value = '6234.10' AND actual_value = '6252.30';" \
  1
assert_zero "CANDIDATE for floor total 6234.10 -> 6252.30" \
  "SELECT count(*) FROM checks WHERE process_id = '$PROCESS3' AND finding_status = 'CANDIDATE' AND subject = 'floor total' AND expected_value = '6234.10' AND actual_value = '6252.30';"

echo "16. the Polyarnaya negative pair yields no candidates"
assert_zero "checks with evidence on the Polyarnaya files that are CANDIDATE" \
  "SELECT count(*) FROM checks c WHERE c.process_id = '$PROCESS3' AND c.finding_status = 'CANDIDATE' AND EXISTS (SELECT 1 FROM evidence_fragments f JOIN files fl ON fl.id = f.file_id WHERE f.check_id = c.id AND fl.file_name IN ('pol17-pd.pdf', 'pol17-rd.pdf'));"

echo "17. every candidate has exactly one expected and one actual fragment"
assert_zero "CANDIDATE checks without exactly one expected and one actual fragment" \
  "SELECT count(*) FROM (SELECT c.id, count(*) FILTER (WHERE f.role = 'expected') AS e, count(*) FILTER (WHERE f.role = 'actual') AS a, count(*) AS t FROM checks c LEFT JOIN evidence_fragments f ON f.check_id = c.id WHERE c.process_id = '$PROCESS3' AND c.finding_status = 'CANDIDATE' GROUP BY c.id) x WHERE NOT (e = 1 AND a = 1 AND t = 2);"

echo "18. the process has at least 132 checks recorded"
assert_at_least "checks recorded for the reference process" \
  "SELECT count(*) FROM checks WHERE process_id = '$PROCESS3';" \
  132

echo "PASS"

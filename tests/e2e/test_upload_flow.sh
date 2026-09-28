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

echo "10a. the inspector who started it has a notification that the protocol is ready"
# Customer's ТЗ p.19: "Инспектор получает уведомление о готовности протокола".
# Decoded explicitly as UTF-8 from raw bytes (not through sys.stdin's text
# mode), the same care step 3's object.json takes - the title is Cyrillic,
# and the console's own codepage on Windows is not UTF-8.
NOTIFIED=$(curl -fsS "$API/notifications" "${AUTH[@]}" | python -c "
import sys, json
body = json.loads(sys.stdin.buffer.read().decode('utf-8'))
found = any(n.get('process_id') == '$PROCESS2' and n.get('kind') == 'PROCESS_READY' for n in body['items'])
print('yes' if found else 'no')
")
[ "$NOTIFIED" = "yes" ] || { echo "FAIL: inspector has no PROCESS_READY notification for process $PROCESS2" >&2; exit 1; }

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

START3=$(date +%s)
curl -fsS -X POST "$API/processes/$PROCESS3/start" "${AUTH[@]}" > /dev/null

echo "13. the reference package reaches READY"
# Customer's ТЗ has no explicit budget for a fresh process.start, but this is
# exactly the package (23 room-name pairs) that used to make READY wait on
# the model for ~61s before section 9.5's hypotheses moved off this path
# (services/worker/app/pipeline.py's own module docstring) - timed here to
# show it no longer does.
for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS3" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "READY" ] && break
  sleep 1
done
END3_READY=$(date +%s)
READY3_DURATION=$((END3_READY - START3))
[ "$STATUS" = "READY" ] || { echo "FAIL: reference process stayed in $STATUS" >&2; exit 1; }
echo "    reference package reached READY in ${READY3_DURATION}s"

echo "13a. process.hypotheses follow-up: SEM-ROOM-FN rows show up for the reference package"
# The matrix protocol above does not wait on this at all (this is the whole
# point of moving section 9.5's hypotheses off process.start's own critical
# path - services/worker/app/pipeline.py's own module docstring): polled
# separately, up to 3 minutes, since LLM_BATCH_SIZE batches of the school
# package's own room-name pairs each still cost a real local-model call.
HYP_COUNT=0
for _ in $(seq 1 180); do
  HYP_COUNT=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
    -c "SELECT count(*) FROM checks WHERE process_id = '$PROCESS3' AND param_code = 'SEM-ROOM-FN';" \
    | tr -d '[:space:]')
  [ "${HYP_COUNT:-0}" -ge 1 ] 2>/dev/null && break
  sleep 1
done
END3_HYP=$(date +%s)
HYP3_DURATION=$((END3_HYP - START3))
[ "${HYP_COUNT:-0}" -ge 1 ] 2>/dev/null \
  || { echo "FAIL: no SEM-ROOM-FN rows appeared for process $PROCESS3 within 180s" >&2; exit 1; }
echo "    hypotheses ready ${HYP3_DURATION}s after process.start (rows: $HYP_COUNT)"

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

echo "19. the protocol the worker created shows up in the protocols list for its object"
# db.create_protocol runs before the process is saved as READY (worker's
# pipeline.py), so by step 13 above the protocol already exists - this only
# proves GET /api/v1/protocols?object_id=... (the "Протоколы" screen's own
# endpoint) actually finds it.
curl -fsS "$API/protocols?object_id=$OBJECT3" "${AUTH[@]}" | python -c "
import sys, json
body = json.loads(sys.stdin.buffer.read().decode('utf-8'))
assert body['total'] >= 1, f\"expected total >= 1, got {body['total']}\"
items = [i for i in body['items'] if i['object_id'] == '$OBJECT3']
assert items, 'no protocol for object $OBJECT3 in the list'
assert items[0]['object_name'], 'object_name missing on the listed protocol'
print('ok')
"

echo "20. дозагрузка: upload only the PD half of a design/working pair"
# Customer's ТЗ "Дозагрузка файлов": a package missing its working
# documentation still reaches READY, with M-003 stating why it could not be
# compared - the whole point of дозагрузка is completing exactly this later
# without restarting the check.
printf '%s' '{"name":"Дозагрузка: только ПД школы"}' > .e2e-tmp/incremental-object.json
OBJECT4=$(curl -fsS -X POST "$API/objects" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/incremental-object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

printf 'object_id,file_name,doc_stage,discipline,document_code,revision,approval_status\n%s,sosh-pd.pdf,PD,АР,SOSH25-000214,1,APPROVED\n' \
  "$OBJECT4" > .e2e-tmp/incremental-reestr-pd-only.csv

RESPONSE4=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT4" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/reference/sosh-pd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/incremental-reestr-pd-only.csv;type=text/csv')
echo "$RESPONSE4" | grep -q '"process_id"'
PROCESS4=$(echo "$RESPONSE4" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

curl -fsS -X POST "$API/processes/$PROCESS4/start" "${AUTH[@]}" > /dev/null

echo "21. the PD-only package reaches READY with a MISSING_EVIDENCE explanation"
for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS4" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "READY" ] && break
  sleep 1
done
[ "$STATUS" = "READY" ] || { echo "FAIL: PD-only process stayed in $STATUS" >&2; exit 1; }

assert_at_least "MISSING_EVIDENCE naming the missing ПД/РД source" \
  "SELECT count(*) FROM checks WHERE process_id = '$PROCESS4' AND param_code = 'M-003' AND completeness_status = 'MISSING_EVIDENCE' AND rationale LIKE '%нет актуального файла ПД или РД%';" \
  1

PROTOCOL4_V1=$(curl -fsS "$API/processes/$PROCESS4/protocol" "${AUTH[@]}" | python -c 'import sys,json; b=json.load(sys.stdin); print(b["id"]); assert b["version"] == 1, b')

echo "22. дозагрузка of the missing RD half completes the comparison"
START_UPDATE=$(date +%s)
RESPONSE4B=$(curl -fsS -X POST "$API/processes/$PROCESS4/documents" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/reference/sosh-rd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reference/reestr.csv;type=text/csv')
echo "$RESPONSE4B" | grep -q '"accepted"'

for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS4" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" != "PARSING" ] && break
  sleep 1
done
END_UPDATE=$(date +%s)
INCREMENTAL_DURATION=$((END_UPDATE - START_UPDATE))
[ "$STATUS" = "READY" ] || [ "$STATUS" = "VERIFYING" ] || { echo "FAIL: дозагрузка left process in $STATUS" >&2; exit 1; }
echo "    incremental update took ${INCREMENTAL_DURATION}s"

echo "23. the protocol version incremented and room 1.109 is now a CANDIDATE"
PROTOCOL4_V2=$(curl -fsS "$API/processes/$PROCESS4/protocol" "${AUTH[@]}" | python -c 'import sys,json; b=json.load(sys.stdin); print(b["id"]); assert b["version"] == 2, b')
[ "$PROTOCOL4_V2" != "$PROTOCOL4_V1" ] || { echo "FAIL: protocol id did not change after дозагрузка" >&2; exit 1; }

assert_at_least "room 1.109 is a CANDIDATE after the дозагрузка" \
  "SELECT count(*) FROM checks WHERE process_id = '$PROCESS4' AND subject = 'room 1.109' AND finding_status = 'CANDIDATE';" \
  1

echo "24. the superseded version kept its own snapshot"
curl -fsS "$API/protocols/$PROTOCOL4_V1" "${AUTH[@]}" | python -c "
import sys, json
body = json.loads(sys.stdin.buffer.read().decode('utf-8'))
assert body['status'] == 'SUPERSEDED', body['status']
assert any('нет актуального файла ПД или РД' in (c.get('rationale') or '') for c in body['completeness']), 'snapshot lost the MISSING_EVIDENCE row'
print('ok')
"

echo "25. the inspector confirms the new candidate"
CHECK_ID=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT id FROM checks WHERE process_id = '$PROCESS4' AND subject = 'room 1.109' AND finding_status = 'CANDIDATE' LIMIT 1;" | tr -d '[:space:]')
[ -n "$CHECK_ID" ] || { echo "FAIL: no candidate check id found for room 1.109" >&2; exit 1; }

printf '%s' '{"decision":"CONFIRMED_VIOLATION"}' > .e2e-tmp/verdict.json
curl -fsS -X POST "$API/findings/$CHECK_ID/verdict" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/verdict.json | grep -q '"finding_status":"CONFIRMED_VIOLATION"'

echo "26. a second, unrelated дозагрузка leaves that decision untouched"
# Polyarnaya's room numbers never collide with the school's (step 12's own
# comment), so this new pair is added without touching room 1.109's group at
# all - exactly the "без сброса верификации" guarantee a дозагрузка exists for.
printf 'object_id,file_name,doc_stage,discipline,document_code,revision,approval_status\n%s,pol17-pd.pdf,PD,АР,POL17-000031,1,APPROVED\n%s,pol17-rd.pdf,RD,АР,POL17-000096,1,FOR_CONSTRUCTION\n' \
  "$OBJECT4" "$OBJECT4" > .e2e-tmp/incremental-reestr-pol17.csv

curl -fsS -X POST "$API/processes/$PROCESS4/documents" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/reference/pol17-pd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/reference/pol17-rd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/incremental-reestr-pol17.csv;type=text/csv' > /dev/null

for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS4" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" != "PARSING" ] && break
  sleep 1
done
[ "$STATUS" = "READY" ] || [ "$STATUS" = "VERIFYING" ] || { echo "FAIL: second дозагрузка left process in $STATUS" >&2; exit 1; }

PROTOCOL4_V3=$(curl -fsS "$API/processes/$PROCESS4/protocol" "${AUTH[@]}" | python -c 'import sys,json; b=json.load(sys.stdin); print(b["id"]); assert b["version"] == 3, b')
[ "$PROTOCOL4_V3" != "$PROTOCOL4_V2" ] || { echo "FAIL: protocol id did not change after the second дозагрузка" >&2; exit 1; }

curl -fsS "$API/findings/$CHECK_ID" "${AUTH[@]}" | python -c "
import sys, json
body = json.loads(sys.stdin.buffer.read().decode('utf-8'))
assert body['id'] == '$CHECK_ID', body
assert body['finding_status'] == 'CONFIRMED_VIOLATION', body['finding_status']
assert body['decision'] is not None, 'the earlier decision was lost'
print('ok')
"

echo "27. дозагрузка after finalization is refused"
# What this step checks is the дозагрузка endpoint's own refusal once a
# protocol IS finalized (services/api's routes/processDocuments.ts) - not
# finalize itself (which would still refuse here, since M-002 through M-131
# were never actually reviewed on this package), so the status is forced
# directly rather than routed through every remaining candidate first.
docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "UPDATE protocols SET status = 'PROTOCOL_FINALIZED' WHERE id = '$PROTOCOL4_V3';" > /dev/null
docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "UPDATE processes SET status = 'FINALIZED' WHERE id = '$PROCESS4';" > /dev/null

FINALIZED_RESPONSE=$(curl -sS -X POST "$API/processes/$PROCESS4/documents" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf')
echo "$FINALIZED_RESPONSE" | grep -q '"error":"PROTOCOL_FINALIZED"'

echo "---- timings ----"
echo "reference package (process.start, 23 room-name pairs) reached READY in ${READY3_DURATION}s"
echo "reference package's own hypotheses (process.hypotheses follow-up) were ready ${HYP3_DURATION}s after process.start"
echo "incremental upload (process.update, дозагрузка) reached a resolved status in ${INCREMENTAL_DURATION}s"


echo "28. section 9.6: seed a finalizable protocol with one confirmed violation"
# Driving a realistic package all the way to a fully-decided protocol (no
# CANDIDATE left) just to reach POST /finalize would make this stage as long
# and as flaky as steps 12-19 - the pipeline itself is not what this stage
# tests. Seeded directly instead (same spirit as step 27's own raw UPDATE),
# leaving the one thing POST /finalize itself must still do for real: enqueue
# a transfer (services/api's routes/verdicts.ts + integration/transfers.ts).
printf '%s' '{"name":"РиН: передача финализированного протокола"}' > .e2e-tmp/rin-object.json
OBJECT5=$(curl -fsS -X POST "$API/objects" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/rin-object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')
INSPECTOR_ID=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT id FROM users WHERE login='inspector';" | tr -d '[:space:]')

PROCESS5=$(python -c 'import uuid; print(uuid.uuid4())')
PROTOCOL5=$(python -c 'import uuid; print(uuid.uuid4())')
CHECK5=$(python -c 'import uuid; print(uuid.uuid4())')
FILE5=$(python -c 'import uuid; print(uuid.uuid4())')
FRAGMENT5=$(python -c 'import uuid; print(uuid.uuid4())')
HASH5=$(python -c "import hashlib; print(hashlib.sha256(b'rin-e2e-akt').hexdigest())")

docker compose exec -T postgres psql -U inspector -d inspector -v ON_ERROR_STOP=1 <<SQL
INSERT INTO processes (id, object_id, status, created_at, updated_at)
VALUES ('$PROCESS5', '$OBJECT5', 'COMPLETED', now(), now());
INSERT INTO files (id, object_id, process_id, file_name, file_hash, storage_key, size_bytes, mime_type, doc_stage, document_code, revision, approval_status, uploaded_at)
VALUES ('$FILE5', '$OBJECT5', '$PROCESS5', 'akt.pdf', '$HASH5', 'documents/e2e/$HASH5', 100, 'application/pdf', 'ID', 'AR-01', '1', 'APPROVED', now());
INSERT INTO protocols (id, object_id, process_id, version, matrix_version, dataset_version, model_version, input_manifest_hash, status, created_at)
VALUES ('$PROTOCOL5', '$OBJECT5', '$PROCESS5', 1, '1.1', 'none', 'rules-2026.09', '$HASH5', 'VERIFICATION_COMPLETED', now());
INSERT INTO checks (id, process_id, object_id, param_code, evidence_group_id, subject, completeness_status, finding_status, engine_status, review_priority, matrix_version, expected_value, actual_value, rationale, verified_by, verified_at, verdict_comment, created_at)
VALUES ('$CHECK5', '$PROCESS5', '$OBJECT5', 'PZ-01', '$PROCESS5:room1', 'room 1', 'COMPLETE', 'CONFIRMED_VIOLATION', 'CANDIDATE', 'HIGH', '1.1', '10', '12', 'расхождение площади', '$INSPECTOR_ID', now(), 'подтверждено', now());
INSERT INTO evidence_fragments (id, check_id, evidence_group_id, file_id, file_sha256, stage, document_code, revision, approval_status, sheet_page, x0, y0, x1, y1, extracted_value, role)
VALUES ('$FRAGMENT5', '$CHECK5', '$PROCESS5:room1', '$FILE5', '$HASH5', 'ID', 'AR-01', '1', 'APPROVED', 1, 0.1, 0.1, 0.5, 0.5, '12', 'actual');
SQL

echo "29. finalizing queues a transfer to ИАИС «РиН»"
curl -fsS -X POST "$API/protocols/$PROTOCOL5/finalize" "${AUTH[@]}" | grep -q '"sync_status":"PENDING_SYNC"'

echo "30. the api's own scheduler sends it and the protocol reaches SYNCED"
SYNC_STATUS=""
for _ in $(seq 1 30); do
  SYNC_STATUS=$(curl -fsS "$API/protocols/$PROTOCOL5/sync" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["sync_status"])')
  [ "$SYNC_STATUS" = "SYNCED" ] && break
  sleep 3
done
[ "$SYNC_STATUS" = "SYNCED" ] || { echo "FAIL: transfer stayed $SYNC_STATUS instead of reaching SYNCED" >&2; exit 1; }

echo "31. the mock received exactly the one confirmed finding, nothing else"
curl -fsS "http://localhost:8090/admin/received?process_id=$PROCESS5" | python -c "
import sys, json
body = json.loads(sys.stdin.buffer.read().decode('utf-8'))
assert body['items'], 'rin-mock stored nothing for process $PROCESS5'
payload = body['items'][0]
assert payload['protocol_id'] == '$PROTOCOL5', payload['protocol_id']
findings = payload['findings']
assert len(findings) == 1, f'expected exactly 1 finding, got {len(findings)}'
assert findings[0]['finding_id'] == '$CHECK5', findings[0]['finding_id']
assert findings[0]['expected_value'] == '10' and findings[0]['actual_value'] == '12', findings[0]
assert len(payload['input_files']) == 1 and payload['input_files'][0]['sha256'] == '$HASH5', payload['input_files']
print('ok')
"

echo "32. an automatic дозагрузка from ИАИС «РиН» on a finalized protocol only notifies, never stores"
FILES_BEFORE=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM files WHERE process_id = '$PROCESS5';" | tr -d '[:space:]')
INBOUND_BODY_FILE=.e2e-tmp/rin-inbound.json
python -c "
import json
print(json.dumps({
    'process_id': '$PROCESS5',
    'files': [{'file_name': 'new-doc.pdf', 'mime_type': 'application/pdf', 'content_base64': 'JVBERi0xLjcgcmluLWUyZQ=='}],
}))
" > "$INBOUND_BODY_FILE"
INBOUND_RESPONSE=$(curl -fsS -X POST "$API/integration/rin/documents" \
  -H 'X-RIN-Token: change-me-rin-token' \
  -H 'Content-Type: application/json' \
  --data-binary @"$INBOUND_BODY_FILE")
echo "$INBOUND_RESPONSE" | grep -q '"status":"NOTIFIED_ONLY"'

FILES_AFTER=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM files WHERE process_id = '$PROCESS5';" | tr -d '[:space:]')
[ "$FILES_AFTER" = "$FILES_BEFORE" ] || { echo "FAIL: inbound дозагрузка stored a file despite the protocol being finalized" >&2; exit 1; }

echo "33. the inspector who owns the process has a notification about it"
assert_at_least "RIN_NEW_DOCUMENTS notification for process $PROCESS5" \
  "SELECT count(*) FROM notifications WHERE process_id = '$PROCESS5' AND kind = 'RIN_NEW_DOCUMENTS';" \
  1


echo "PASS"

#!/usr/bin/env bash
set -euo pipefail

# Section 9.4/14 of the customer's ТЗ: finalize a protocol with one
# confirmed and one rejected candidate, confirm GOLD labels exist, release a
# dataset version, read back TP=1/FP=1 from the metrics endpoint, and
# generate + download the weekly quality report.

API=http://localhost:3000/api/v1
mkdir -p .e2e-tmp

echo "1. health"
curl -fsS "$API/health" | grep -q '"status":"ok"'

echo "2. log in as inspector, admin and ml engineer"
login() {
  curl -fsS -X POST "$API/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"login\":\"$1\",\"password\":\"$2\"}" \
    | python -c 'import sys,json; print(json.load(sys.stdin)["token"])'
}
INSPECTOR_TOKEN=$(login inspector inspector123)
ADMIN_TOKEN=$(login admin admin123)
ML_TOKEN=$(login ml ml123)
INSPECTOR_AUTH=(-H "Authorization: Bearer $INSPECTOR_TOKEN")
ADMIN_AUTH=(-H "Authorization: Bearer $ADMIN_TOKEN")
ML_AUTH=(-H "Authorization: Bearer $ML_TOKEN")

echo "3. seed a process/protocol with one CANDIDATE and one rejected-to-be CANDIDATE"
# Same shape as test_upload_flow.sh's own step 28 (a realistic run to a fully
# decided protocol would make this as slow and flaky as the matrix pipeline
# itself, which is not what this script tests) - seeded directly, leaving
# POST /verdict and POST /finalize themselves to do the one thing this
# script actually exercises: turn a decided check into a GOLD label.
printf '%s' '{"name":"Качество: GOLD-метки и еженедельный отчёт"}' > .e2e-tmp/quality-object.json
OBJECT_ID=$(curl -fsS -X POST "$API/objects" \
  "${INSPECTOR_AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/quality-object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

PROCESS_ID=$(python -c 'import uuid; print(uuid.uuid4())')
PROTOCOL_ID=$(python -c 'import uuid; print(uuid.uuid4())')
CHECK_CONFIRMED=$(python -c 'import uuid; print(uuid.uuid4())')
CHECK_REJECTED=$(python -c 'import uuid; print(uuid.uuid4())')
PARAM_CODE="E2E-Q$(python -c 'import uuid; print(str(uuid.uuid4())[:6])')"

docker compose exec -T postgres psql -U inspector -d inspector -v ON_ERROR_STOP=1 <<SQL
INSERT INTO processes (id, object_id, status, created_at, updated_at)
VALUES ('$PROCESS_ID', '$OBJECT_ID', 'READY', now(), now());
INSERT INTO protocols (id, object_id, process_id, version, matrix_version, dataset_version, model_version, input_manifest_hash, status, created_at)
VALUES ('$PROTOCOL_ID', '$OBJECT_ID', '$PROCESS_ID', 1, '1.1', 'none', 'rules-2026.09', repeat('0', 64), 'READY', now());
INSERT INTO checks (id, process_id, object_id, param_code, evidence_group_id, subject, completeness_status, finding_status, engine_status, review_priority, matrix_version, expected_value, actual_value, created_at)
VALUES ('$CHECK_CONFIRMED', '$PROCESS_ID', '$OBJECT_ID', '$PARAM_CODE', '$PROCESS_ID:confirmed', 'room A', 'COMPLETE', 'CANDIDATE', 'CANDIDATE', 'MEDIUM', '1.1', '10', '12', now());
INSERT INTO checks (id, process_id, object_id, param_code, evidence_group_id, subject, completeness_status, finding_status, engine_status, review_priority, matrix_version, expected_value, actual_value, created_at)
VALUES ('$CHECK_REJECTED', '$PROCESS_ID', '$OBJECT_ID', '$PARAM_CODE', '$PROCESS_ID:rejected', 'room B', 'COMPLETE', 'CANDIDATE', 'CANDIDATE', 'MEDIUM', '1.1', '10', '10', now());
SQL

echo "4. inspector confirms the first candidate and rejects the second"
printf '%s' '{"decision":"CONFIRMED_VIOLATION","comment":"подтверждено e2e"}' > .e2e-tmp/quality-confirm.json
curl -fsS -X POST "$API/findings/$CHECK_CONFIRMED/verdict" \
  "${INSPECTOR_AUTH[@]}" -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/quality-confirm.json | grep -q '"finding_status":"CONFIRMED_VIOLATION"'

printf '%s' '{"decision":"NEGATIVE_VERIFIED","reason_code":"OCR_ERROR","comment":"ошибка распознавания e2e"}' > .e2e-tmp/quality-reject.json
curl -fsS -X POST "$API/findings/$CHECK_REJECTED/verdict" \
  "${INSPECTOR_AUTH[@]}" -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/quality-reject.json | grep -q '"finding_status":"NEGATIVE_VERIFIED"'

echo "5. finalizing the protocol writes GOLD labels for both decisions"
curl -fsS -X POST "$API/protocols/$PROTOCOL_ID/finalize" "${INSPECTOR_AUTH[@]}" | grep -q '"status":"PROTOCOL_FINALIZED"'

LABEL_COUNT=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM gold_labels WHERE protocol_id = '$PROTOCOL_ID';" | tr -d '[:space:]')
[ "$LABEL_COUNT" = "2" ] || { echo "FAIL: expected 2 GOLD labels, got $LABEL_COUNT" >&2; exit 1; }

POSITIVE_LABEL=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT label FROM gold_labels WHERE check_id = '$CHECK_CONFIRMED';" | tr -d '[:space:]')
[ "$POSITIVE_LABEL" = "POSITIVE" ] || { echo "FAIL: confirmed check's label is $POSITIVE_LABEL, not POSITIVE" >&2; exit 1; }
NEGATIVE_LABEL=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT label FROM gold_labels WHERE check_id = '$CHECK_REJECTED';" | tr -d '[:space:]')
[ "$NEGATIVE_LABEL" = "NEGATIVE" ] || { echo "FAIL: rejected check's label is $NEGATIVE_LABEL, not NEGATIVE" >&2; exit 1; }

echo "6. the ML engineer releases a dataset version"
printf '%s' "{\"notes\":\"e2e release\"}" > .e2e-tmp/quality-release.json
RELEASE_RESPONSE=$(curl -fsS -X POST "$API/quality/datasets" \
  "${ML_AUTH[@]}" -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/quality-release.json)
echo "$RELEASE_RESPONSE" | grep -q '"label_count"'
DATASET_VERSION_ID=$(echo "$RELEASE_RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')
VERSION_TAG=$(echo "$RELEASE_RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["version_tag"])')

echo "7. the release is listed and exports as JSONL containing both labels"
curl -fsS "$API/quality/datasets" "${ADMIN_AUTH[@]}" | grep -q "\"$VERSION_TAG\""

EXPORT_LINES=$(curl -fsS "$API/quality/datasets/$DATASET_VERSION_ID/export" "${ML_AUTH[@]}" | grep -c "$PARAM_CODE" || true)
[ "$EXPORT_LINES" -ge 2 ] || { echo "FAIL: expected at least 2 exported rows for $PARAM_CODE, got $EXPORT_LINES" >&2; exit 1; }

echo "8. metrics for this param show TP=1 and FP=1"
curl -fsS "$API/quality/metrics?param=$PARAM_CODE" "${ADMIN_AUTH[@]}" | python -c "
import sys, json
body = json.loads(sys.stdin.buffer.read().decode('utf-8'))
counts = body['overall']['counts']
assert counts['tp'] == 1, counts
assert counts['fp'] == 1, counts
print('ok')
"

echo "9. the ML engineer generates the weekly report on demand"
REPORT_RESPONSE=$(curl -fsS -X POST "$API/quality/reports" "${ML_AUTH[@]}")
echo "$REPORT_RESPONSE" | grep -q '"recommendations"'
REPORT_ID=$(echo "$REPORT_RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "10. the report is listed and downloadable as json/pdf/docx"
curl -fsS "$API/quality/reports" "${ADMIN_AUTH[@]}" | grep -q "\"$REPORT_ID\""

curl -fsS "$API/quality/reports/$REPORT_ID/download?format=json" "${ADMIN_AUTH[@]}" | grep -q '"metrics"'

PDF_BYTES=$(curl -fsS "$API/quality/reports/$REPORT_ID/download?format=pdf" "${ADMIN_AUTH[@]}" -o .e2e-tmp/quality-report.pdf -w '%{size_download}')
[ "${PDF_BYTES:-0}" -gt 0 ] || { echo "FAIL: PDF report download was empty" >&2; exit 1; }

DOCX_BYTES=$(curl -fsS "$API/quality/reports/$REPORT_ID/download?format=docx" "${ADMIN_AUTH[@]}" -o .e2e-tmp/quality-report.docx -w '%{size_download}')
[ "${DOCX_BYTES:-0}" -gt 0 ] || { echo "FAIL: DOCX report download was empty" >&2; exit 1; }

echo "11. ADMIN and ML_ENGINEER were notified about the report, an inspector was not asked to generate one"
NOTIFIED=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'QUALITY_REPORT_READY' AND u.role IN ('ADMIN','ML_ENGINEER') AND n.created_at > now() - interval '2 minutes';" \
  | tr -d '[:space:]')
[ "${NOTIFIED:-0}" -ge 2 ] || { echo "FAIL: expected at least 2 QUALITY_REPORT_READY notifications (ADMIN+ML_ENGINEER), got $NOTIFIED" >&2; exit 1; }

FORBIDDEN=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/quality/reports" "${INSPECTOR_AUTH[@]}")
[ "$FORBIDDEN" = "403" ] || { echo "FAIL: an inspector generating a report should be 403, got $FORBIDDEN" >&2; exit 1; }

echo "PASS"

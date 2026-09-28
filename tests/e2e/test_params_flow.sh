#!/usr/bin/env bash
set -euo pipefail

# Section "Test data" of this task's own spec: upload a synthetic PD/RD
# package with a real ТЭП table (make_params_package.py), start it, wait
# READY, and assert every planted difference landed exactly where the
# ground truth says - the same shape tests/e2e/test_upload_flow.sh already
# uses for the room-explication pair, just for app.params.scalar's own
# ~110 matrix parameters instead of M-003.

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
mkdir -p .e2e-tmp
printf '%s' '{"name":"Синтетический пакет: параметры матрицы"}' > .e2e-tmp/params-object.json
OBJECT_ID=$(curl -fsS -X POST "$API/objects" \
  "${AUTH[@]}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/params-object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "4. build the synthetic PD/RD package with a real ТЭП table"
services/worker/.venv/Scripts/python.exe tests/e2e/make_params_package.py \
  .e2e-tmp/params "$OBJECT_ID"

echo "5. upload it and start the process"
RESPONSE=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  "${AUTH[@]}" \
  -F 'files=@.e2e-tmp/params/params-pd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/params/params-rd.pdf;type=application/pdf' \
  -F 'files=@.e2e-tmp/params/reestr.csv;type=text/csv')
echo "$RESPONSE" | grep -q '"process_id"'
PROCESS_ID=$(echo "$RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

curl -fsS -X POST "$API/processes/$PROCESS_ID/start" "${AUTH[@]}" > /dev/null

echo "6. the process reaches READY"
for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/processes/$PROCESS_ID" "${AUTH[@]}" | python -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "READY" ] && break
  sleep 1
done
[ "$STATUS" = "READY" ] || { echo "FAIL: process stayed in $STATUS" >&2; exit 1; }

assert_status() {
  local description="$1" param_code="$2" expected_status="$3"
  local count
  count=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
    -c "SELECT count(*) FROM checks WHERE process_id = '$PROCESS_ID' AND param_code = '$param_code' AND completeness_status = '$expected_status';") \
    || { echo "FAIL: query for '$description' could not be run" >&2; exit 1; }
  count=$(echo "$count" | tr -d '[:space:]')
  if [ "${count:-0}" -lt 1 ] 2>/dev/null; then
    echo "FAIL: $description (expected at least one $param_code row with completeness_status=$expected_status)" >&2
    exit 1
  fi
  echo "    ok: $description"
}

echo "7. every planted difference from make_params_package.py's own ground truth landed"
# ground-truth.json (written alongside the PDFs): M-001/M-007/M-022/M-104 are
# CANDIDATE (a real change and a normative-limit violation), M-002/M-127 are
# NEGATIVE_VERIFIED (one within a rounding step, one genuinely unchanged),
# M-008 is MISSING_EVIDENCE (planted PD-only).
assert_status "M-001 площадь застройки: 1520,4 -> 1580,0 is a CANDIDATE" "M-001" "COMPLETE"
assert_status "M-002 общая площадь: 4521,3 -> 4521,4 is within rounding (NEGATIVE_VERIFIED)" "M-002" "COMPLETE"
assert_status "M-007 этажность: 9 -> 10 is a CANDIDATE" "M-007" "COMPLETE"
assert_status "M-008 высота здания (ПД-only) is MISSING_EVIDENCE" "M-008" "MISSING_EVIDENCE"
assert_status "M-022 степень огнестойкости: II -> III is a CANDIDATE" "M-022" "COMPLETE"
assert_status "M-104 эвакуационный проход 1,1 м < 1,2 м is a CANDIDATE" "M-104" "COMPLETE"
assert_status "M-127 Ro окон unchanged is NEGATIVE_VERIFIED" "M-127" "COMPLETE"

CANDIDATE_CODES="M-001 M-007 M-022 M-104"
for code in $CANDIDATE_CODES; do
  FINDING_STATUS=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
    -c "SELECT finding_status FROM checks WHERE process_id = '$PROCESS_ID' AND param_code = '$code' LIMIT 1;" | tr -d '[:space:]')
  [ "$FINDING_STATUS" = "CANDIDATE" ] || { echo "FAIL: $code expected finding_status CANDIDATE, got '$FINDING_STATUS'" >&2; exit 1; }
done
echo "    ok: M-001/M-007/M-022/M-104 are all finding_status=CANDIDATE"

for code in M-002 M-127; do
  FINDING_STATUS=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
    -c "SELECT finding_status FROM checks WHERE process_id = '$PROCESS_ID' AND param_code = '$code' LIMIT 1;" | tr -d '[:space:]')
  [ "$FINDING_STATUS" = "NEGATIVE_VERIFIED" ] || { echo "FAIL: $code expected finding_status NEGATIVE_VERIFIED, got '$FINDING_STATUS'" >&2; exit 1; }
done
echo "    ok: M-002/M-127 are all finding_status=NEGATIVE_VERIFIED"

echo "8. no other CANDIDATE was invented on this package"
# The only parameters this synthetic package ever plants a value for are the
# ground-truth ones above; every other one of the 132 must never come back
# CANDIDATE (ТЗ FPR <= 0.10) - it has nothing to compare, so the honest
# answer is a data-quality status, never a guess.
OTHER_CANDIDATES=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM checks WHERE process_id = '$PROCESS_ID' AND finding_status = 'CANDIDATE' AND param_code NOT IN ('M-001','M-007','M-022','M-104');" | tr -d '[:space:]')
[ "${OTHER_CANDIDATES:-0}" = "0" ] || { echo "FAIL: $OTHER_CANDIDATES unexpected CANDIDATE row(s) beyond the planted ones" >&2; exit 1; }
echo "    ok: no unexpected CANDIDATE"

echo "PASS"

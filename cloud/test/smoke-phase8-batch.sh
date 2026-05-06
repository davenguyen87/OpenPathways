#!/usr/bin/env bash
# Phase 8 smoke test — multi-file batch upload + multiplexed status + CSV.
#
# 1. Boot cloud server.
# 2. POST 3 fixtures to /api/audits/batch in one multipart request.
# 3. Capture batchId; assert jobIds.length == 3.
# 4. Poll /api/batches/:batchId until every job is status=done.
# 5. Fetch /api/batches/:batchId/report.csv and assert header + 3 data rows.
# 6. Fetch /api/audits/<one of them>/report.csv and assert header + ≥0
#    violation rows for the clean fixture (and ≥1 for a violations fixture).
#
# Run from the repo root:  bash cloud/test/smoke-phase8-batch.sh

set -u
set -o pipefail

PORT="${PORT:-4293}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
F1="${F1:-$ROOT/test/fixtures/scorm12-clean.zip}"
F2="${F2:-$ROOT/test/fixtures/scorm12-violations.zip}"
F3="${F3:-$ROOT/test/fixtures/aicc-profile1.zip}"
DB_DIR="$(mktemp -d -t op-cloud-batch-XXXXXX)"
SQLITE_PATH="$DB_DIR/op.sqlite"
SVR_LOG="$DB_DIR/server.log"

cleanup() {
  if [[ -n "${SVR:-}" ]]; then kill -INT "$SVR" 2>/dev/null || true; wait "$SVR" 2>/dev/null || true; fi
  rm -rf "$DB_DIR"
}
trap cleanup EXIT INT TERM

for f in "$F1" "$F2" "$F3"; do
  [[ -f "$f" ]] || { echo "FAIL: fixture missing: $f" >&2; exit 1; }
done

start_server() {
  SQLITE_PATH="$SQLITE_PATH" \
  PRISM_RETENTION_DAYS=0 \
    node "$ROOT/cloud/server/index.js" --no-open --port "$PORT" >>"$SVR_LOG" 2>&1 &
  SVR=$!
  for i in $(seq 1 50); do
    if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" | grep -q 200; then
      return 0
    fi
    sleep 0.2
  done
  echo "FAIL: server did not come up" >&2
  tail -30 "$SVR_LOG" >&2
  return 1
}

echo "[boot] Starting server on :$PORT"
start_server || exit 1

echo "[run] POST /api/audits/batch with 3 fixtures"
RESP="$(curl -s -X POST \
  -F "package=@$F1" \
  -F "package=@$F2" \
  -F "package=@$F3" \
  "http://127.0.0.1:$PORT/api/audits/batch")"

# Parse via node so we never fight regex against JSON shape.
PARSED="$(printf '%s' "$RESP" | node -e '
let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  const j=JSON.parse(d);
  process.stdout.write(JSON.stringify({batchId:j.batchId, count:(j.jobIds||[]).length, ids:j.jobIds||[]}));
})')"
BATCH_ID="$(printf '%s' "$PARSED" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(j.batchId||"")})')"
COUNT="$(printf '%s' "$PARSED" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(String(j.count||0))})')"

if [[ -z "$BATCH_ID" || "$COUNT" -ne 3 ]]; then
  echo "FAIL: batch upload returned unexpected response: $RESP" >&2
  exit 1
fi
echo "[run] batchId=$BATCH_ID, jobIds.count=$COUNT"

# Poll until all 3 are terminal.
echo "[run] Polling /api/batches/$BATCH_ID..."
ALL_DONE=""
for i in $(seq 1 720); do
  BODY="$(curl -s "http://127.0.0.1:$PORT/api/batches/$BATCH_ID")"
  STATS="$(printf '%s' "$BODY" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      const j=JSON.parse(d);
      const jobs=(j.jobs||[]);
      const counts={done:0,error:0,cancelled:0,running:0,pending:0};
      for(const job of jobs) counts[job.status]=(counts[job.status]||0)+1;
      process.stdout.write(JSON.stringify({total:jobs.length,...counts}));
    })' 2>/dev/null || echo "")"
  if [[ -n "$STATS" ]]; then
    DONE="$(printf '%s' "$STATS" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(String(j.done||0))})')"
    TOTAL="$(printf '%s' "$STATS" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(String(j.total||0))})')"
    if [[ "$DONE" == "$TOTAL" && "$DONE" -eq 3 ]]; then
      ALL_DONE=1
      break
    fi
  fi
  sleep 0.5
done

if [[ -z "$ALL_DONE" ]]; then
  echo "FAIL: not all 3 jobs reached status=done in time" >&2
  curl -s "http://127.0.0.1:$PORT/api/batches/$BATCH_ID" | head -c 600 >&2
  echo "" >&2
  echo "--- server log ---" >&2; tail -30 "$SVR_LOG" >&2
  exit 1
fi
echo "[run] all 3 jobs done"

# Batch CSV
echo "[run] GET /api/batches/$BATCH_ID/report.csv"
CSV="$(curl -s "http://127.0.0.1:$PORT/api/batches/$BATCH_ID/report.csv")"
LINES_TOTAL="$(printf '%s\n' "$CSV" | tr -d '\r' | grep -c '^[^[:space:]]')"
DATA_LINES=$((LINES_TOTAL - 1))
if [[ "$DATA_LINES" -ne 3 ]]; then
  echo "FAIL: batch CSV expected 1 header + 3 data rows; got $LINES_TOTAL non-blank lines" >&2
  printf '%s\n' "$CSV" >&2
  exit 1
fi
HEADER="$(printf '%s' "$CSV" | head -1 | tr -d '\r')"
if ! printf '%s' "$HEADER" | grep -q 'jobId,originalName,status'; then
  echo "FAIL: batch CSV header does not look right: $HEADER" >&2
  exit 1
fi
echo "[run] ok — batch CSV has 1 header + 3 data rows"

# Single-job CSV (use the 2nd jobId — should be scorm12-violations.zip).
JID2="$(printf '%s' "$PARSED" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write((j.ids||[])[1]||"")})')"
echo "[run] GET /api/audits/$JID2/report.csv"
JCSV="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JID2/report.csv")"
JHEADER="$(printf '%s' "$JCSV" | head -1 | tr -d '\r')"
if ! printf '%s' "$JHEADER" | grep -q 'criterion,criterionName,level,severity'; then
  echo "FAIL: single-job CSV header does not look right: $JHEADER" >&2
  exit 1
fi
JCSV_LINES="$(printf '%s\n' "$JCSV" | tr -d '\r' | grep -c '^[^[:space:]]')"
if [[ "$JCSV_LINES" -lt 2 ]]; then
  echo "FAIL: single-job CSV expected at least 1 violation row; got $JCSV_LINES non-blank lines" >&2
  printf '%s\n' "$JCSV" >&2
  exit 1
fi
echo "[run] ok — single-job CSV has header + $((JCSV_LINES - 1)) violation row(s)"

echo
echo "PASS: Phase 8 batch smoke test"

#!/usr/bin/env bash
# Phase 7a smoke test — preview-fix and apply-fix-then-re-audit work.
#
# 1. Boot cloud server.
# 2. Upload scorm12-violations.zip; wait for done; capture violation count.
# 3. POST /api/audits/:id/fix?dry-run=true; assert applied[].length > 0.
# 4. POST /api/audits/:id/fix; capture follow-up jobId.
# 5. Poll the follow-up job to status=done.
# 6. Assert the follow-up job's report has STRICTLY FEWER violations.
#
# Run from the repo root:  bash cloud/test/smoke-phase7-fix.sh

set -u
set -o pipefail

PORT="${PORT:-4291}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-violations.zip}"
DB_DIR="$(mktemp -d -t op-cloud-fix-XXXXXX)"
SQLITE_PATH="$DB_DIR/op.sqlite"
SVR_LOG="$DB_DIR/server.log"

cleanup() {
  if [[ -n "${SVR:-}" ]]; then kill -INT "$SVR" 2>/dev/null || true; wait "$SVR" 2>/dev/null || true; fi
  rm -rf "$DB_DIR"
}
trap cleanup EXIT INT TERM

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL: fixture not found at $FIXTURE" >&2
  exit 1
fi

start_server() {
  SQLITE_PATH="$SQLITE_PATH" \
  OPEN_PATHWAYS_RETENTION_DAYS=0 \
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

poll_done() {
  local job="$1"
  for i in $(seq 1 360); do
    SNAP="$(curl -s "http://127.0.0.1:$PORT/api/audits/$job")"
    STATUS="$(printf '%s' "$SNAP" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
    if [[ "$STATUS" == "done" || "$STATUS" == "error" ]]; then
      echo "$STATUS"
      return 0
    fi
    sleep 0.5
  done
  echo "timeout"
  return 1
}

echo "[boot] Starting server on :$PORT"
start_server || exit 1

echo "[run] Uploading $(basename "$FIXTURE")"
RESP="$(curl -s -X POST -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
JOB_ID="$(printf '%s' "$RESP" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
[[ -z "$JOB_ID" ]] && { echo "FAIL: no jobId: $RESP" >&2; exit 1; }
echo "[run] original jobId=$JOB_ID"

ST="$(poll_done "$JOB_ID")"
if [[ "$ST" != "done" ]]; then
  echo "FAIL: original audit did not complete (status=$ST)" >&2
  tail -30 "$SVR_LOG" >&2
  exit 1
fi

# Get original violation count from the report. summary.totalViolations is
# the canonical field; we use node for a real JSON parse rather than sed.
ORIG_REPORT="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JOB_ID/report.json")"
ORIG_VIOLATIONS="$(printf '%s' "$ORIG_REPORT" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(String(j.summary.totalViolations))})')"
[[ -z "$ORIG_VIOLATIONS" || "$ORIG_VIOLATIONS" -lt 1 ]] && { echo "FAIL: original audit had no violations to fix (V=$ORIG_VIOLATIONS)" >&2; exit 1; }
echo "[run] original audit found $ORIG_VIOLATIONS violations"

# Dry-run fix
echo "[fix] POST /api/audits/$JOB_ID/fix?dry-run=true"
DRY_RESP="$(curl -s -X POST "http://127.0.0.1:$PORT/api/audits/$JOB_ID/fix?dry-run=true")"
DRY_APPLIED="$(printf '%s' "$DRY_RESP" | sed -n 's/.*"appliedCount":\([0-9]*\).*/\1/p')"
if [[ -z "$DRY_APPLIED" || "$DRY_APPLIED" -lt 1 ]]; then
  echo "FAIL: dry-run returned no applied fixes (response: $DRY_RESP)" >&2
  exit 1
fi
echo "[fix] dry-run reports $DRY_APPLIED fixable violation(s)"

# Apply fix and create a follow-up job
echo "[fix] POST /api/audits/$JOB_ID/fix (apply)"
APPLY_RESP="$(curl -s -X POST "http://127.0.0.1:$PORT/api/audits/$JOB_ID/fix")"
NEW_JOB_ID="$(printf '%s' "$APPLY_RESP" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
[[ -z "$NEW_JOB_ID" ]] && { echo "FAIL: apply returned no follow-up jobId: $APPLY_RESP" >&2; exit 1; }
echo "[fix] follow-up jobId=$NEW_JOB_ID"

# Wait for follow-up to complete
echo "[fix] Waiting for follow-up audit to finish..."
ST2="$(poll_done "$NEW_JOB_ID")"
if [[ "$ST2" != "done" ]]; then
  echo "FAIL: follow-up audit did not complete (status=$ST2)" >&2
  tail -30 "$SVR_LOG" >&2
  exit 1
fi

# Compare violation counts
NEW_REPORT="$(curl -s "http://127.0.0.1:$PORT/api/audits/$NEW_JOB_ID/report.json")"
NEW_VIOLATIONS="$(printf '%s' "$NEW_REPORT" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(String(j.summary.totalViolations))})')"
[[ -z "$NEW_VIOLATIONS" ]] && { echo "FAIL: could not read totalViolations from follow-up report" >&2; exit 1; }
echo "[fix] follow-up audit found $NEW_VIOLATIONS violations (was $ORIG_VIOLATIONS)"

if [[ "$NEW_VIOLATIONS" -ge "$ORIG_VIOLATIONS" ]]; then
  echo "FAIL: follow-up audit did not have fewer violations ($NEW_VIOLATIONS >= $ORIG_VIOLATIONS)" >&2
  exit 1
fi

echo
echo "PASS: Phase 7a fix smoke test (orig=$ORIG_VIOLATIONS → fixed=$NEW_VIOLATIONS)"

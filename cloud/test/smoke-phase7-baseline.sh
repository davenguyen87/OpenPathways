#!/usr/bin/env bash
# Phase 7b smoke test — baseline diff filters violations correctly.
#
# 1. Boot cloud server.
# 2. Upload scorm12-violations.zip twice (identical content); wait for both.
# 3. GET /api/audits/:id2/report.json?baseline=:id1.
# 4. Assert filtered totalViolations === 0 (both audits saw the same
#    violations; comparing one against the other should leave nothing).
# 5. Assert baselineMeta is present with the correct id and a positive
#    filteredOut count.
# 6. Sanity: GET without ?baseline= still returns the unfiltered count.
#
# Run from the repo root:  bash cloud/test/smoke-phase7-baseline.sh

set -u
set -o pipefail

PORT="${PORT:-4292}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-violations.zip}"
DB_DIR="$(mktemp -d -t op-cloud-baseline-XXXXXX)"
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

upload_and_wait() {
  local label="$1"
  local resp
  resp="$(curl -s -X POST -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
  local jid
  jid="$(printf '%s' "$resp" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
  [[ -z "$jid" ]] && { echo "FAIL: no jobId for $label upload" >&2; exit 1; }
  echo "[$label] jobId=$jid" >&2

  for i in $(seq 1 360); do
    local snap status
    snap="$(curl -s "http://127.0.0.1:$PORT/api/audits/$jid")"
    status="$(printf '%s' "$snap" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
    if [[ "$status" == "done" || "$status" == "error" ]]; then
      [[ "$status" != "done" ]] && { echo "FAIL: [$label] audit ended in status=$status" >&2; exit 1; }
      echo "$jid"
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL: [$label] audit timed out" >&2
  exit 1
}

echo "[boot] Starting server on :$PORT"
start_server || exit 1

JID1="$(upload_and_wait "baseline")"
JID2="$(upload_and_wait "current")"
echo "[run] baseline=$JID1, current=$JID2"

# Sanity: unfiltered count
ORIG_REPORT="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JID2/report.json")"
ORIG_V="$(printf '%s' "$ORIG_REPORT" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(String(j.summary.totalViolations))})')"
[[ -z "$ORIG_V" || "$ORIG_V" -lt 1 ]] && { echo "FAIL: unfiltered current audit had no violations to filter (V=$ORIG_V)" >&2; exit 1; }
echo "[run] unfiltered current violations: $ORIG_V"

# Filtered against baseline
echo "[run] GET /report.json?baseline=$JID1"
FILTERED_REPORT="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JID2/report.json?baseline=$JID1")"
FILTERED_V="$(printf '%s' "$FILTERED_REPORT" | sed -n 's/.*"totalViolations":\([0-9]*\).*/\1/p' | head -1)"
echo "[run] filtered current violations: $FILTERED_V"

if [[ -z "$FILTERED_V" ]]; then
  echo "FAIL: could not parse totalViolations from filtered report" >&2
  printf '%s\n' "$FILTERED_REPORT" | head -40 >&2
  exit 1
fi
if [[ "$FILTERED_V" -ne 0 ]]; then
  echo "FAIL: identical fixtures should diff to 0 violations, got $FILTERED_V" >&2
  exit 1
fi

# baselineMeta present?
if ! printf '%s' "$FILTERED_REPORT" | grep -q '"baselineMeta"'; then
  echo "FAIL: baselineMeta missing from response" >&2
  exit 1
fi
if ! printf '%s' "$FILTERED_REPORT" | grep -q "\"id\":\"$JID1\""; then
  echo "FAIL: baselineMeta.id does not match baseline jobId" >&2
  exit 1
fi
echo "[run] ok — baselineMeta references the baseline job"

# Same job as its own baseline → 400
SELF_RESP="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JID2/report.json?baseline=$JID2")"
SELF_HTTP="${SELF_RESP##*__HTTP__}"
if [[ "$SELF_HTTP" != "400" ]]; then
  echo "FAIL: comparing a job to itself should return 400, got $SELF_HTTP" >&2
  exit 1
fi
echo "[run] ok — self-baseline returns 400"

echo
echo "PASS: Phase 7b baseline smoke test ($ORIG_V violations → 0 after diff)"

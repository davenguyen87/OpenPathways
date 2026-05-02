#!/usr/bin/env bash
# Phase 5 smoke test — completed-job history survives a server restart.
#
# 1. Start the cloud server with a fresh SQLite file.
# 2. Upload a clean fixture, wait for status=done.
# 3. Kill the server.
# 4. Restart the server pointing at the same SQLite file.
# 5. GET /api/audits/:id, /report.json, /report.md — all must succeed.
# 6. GET /api/audits — recent panel must include the historical row.
#
# Run from the repo root:  bash cloud/test/smoke-phase5-history.sh

set -u
set -o pipefail

PORT="${PORT:-4288}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-clean.zip}"
DB_DIR="$(mktemp -d -t op-cloud-history-XXXXXX)"
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
  echo "FAIL: server did not come up on :$PORT (boot 1)" >&2
  echo "--- server log ---" >&2
  tail -50 "$SVR_LOG" >&2
  return 1
}

stop_server() {
  if [[ -n "${SVR:-}" ]]; then
    kill -INT "$SVR" 2>/dev/null || true
    wait "$SVR" 2>/dev/null || true
    SVR=""
  fi
}

# -------- boot 1: upload + wait for done --------
echo "[boot 1] Starting server on :$PORT, sqlite=$SQLITE_PATH"
start_server || exit 1

echo "[boot 1] Uploading fixture: $(basename "$FIXTURE")"
RESP="$(curl -s -X POST -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
JOB_ID="$(printf '%s' "$RESP" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
if [[ -z "$JOB_ID" ]]; then
  echo "FAIL: no jobId in upload response: $RESP" >&2
  exit 1
fi
echo "[boot 1] jobId=$JOB_ID"

echo "[boot 1] Polling for terminal status..."
STATUS=""
for i in $(seq 1 360); do
  SNAP="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JOB_ID")"
  STATUS="$(printf '%s' "$SNAP" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  if [[ "$STATUS" == "done" || "$STATUS" == "error" ]]; then break; fi
  sleep 0.5
done
echo "[boot 1] final status=$STATUS"
if [[ "$STATUS" != "done" ]]; then
  echo "FAIL: audit did not complete cleanly on first boot" >&2
  echo "--- snapshot ---" >&2; printf '%s\n' "$SNAP" >&2
  echo "--- server log ---" >&2; tail -50 "$SVR_LOG" >&2
  exit 1
fi

# -------- kill + restart --------
echo "[restart] Stopping server..."
stop_server

echo "[boot 2] Restarting server against the same SQLite file..."
start_server || exit 1

# -------- post-restart checks --------
echo "[boot 2] GET /api/audits/$JOB_ID"
SNAP2="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JOB_ID")"
SNAP2_HTTP="${SNAP2##*__HTTP__}"
SNAP2_BODY="${SNAP2%$'\n'__HTTP__*}"
if [[ "$SNAP2_HTTP" != "200" ]]; then
  echo "FAIL: snapshot returned HTTP $SNAP2_HTTP after restart" >&2
  printf '%s\n' "$SNAP2_BODY" >&2
  exit 1
fi
if ! printf '%s' "$SNAP2_BODY" | grep -q '"status":"done"'; then
  echo "FAIL: post-restart snapshot status is not 'done'" >&2
  printf '%s\n' "$SNAP2_BODY" >&2
  exit 1
fi
echo "  ok — snapshot status=done after restart"

echo "[boot 2] GET /api/audits/$JOB_ID/report.json"
JSON_BODY="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JOB_ID/report.json")"
JSON_HTTP="${JSON_BODY##*__HTTP__}"
JSON_DATA="${JSON_BODY%$'\n'__HTTP__*}"
if [[ "$JSON_HTTP" != "200" ]] || ! printf '%s' "$JSON_DATA" | grep -q '"score"'; then
  echo "FAIL: JSON report missing or malformed (HTTP $JSON_HTTP)" >&2
  printf '%s' "$JSON_DATA" | head -30 >&2
  exit 1
fi
echo "  ok — report.json HTTP 200, $(printf '%s' "$JSON_DATA" | wc -c | tr -d ' ') bytes"

echo "[boot 2] GET /api/audits/$JOB_ID/report.md"
MD_BODY="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JOB_ID/report.md")"
MD_HTTP="${MD_BODY##*__HTTP__}"
MD_DATA="${MD_BODY%$'\n'__HTTP__*}"
if [[ "$MD_HTTP" != "200" ]] || ! printf '%s' "$MD_DATA" | head -5 | grep -qi 'open pathways\|wcag\|scorecard'; then
  echo "FAIL: Markdown report missing or malformed (HTTP $MD_HTTP)" >&2
  printf '%s' "$MD_DATA" | head -10 >&2
  exit 1
fi
echo "  ok — report.md HTTP 200, $(printf '%s' "$MD_DATA" | wc -c | tr -d ' ') bytes"

echo "[boot 2] GET /api/audits — list must include the historical row"
LIST_BODY="$(curl -s "http://127.0.0.1:$PORT/api/audits")"
if ! printf '%s' "$LIST_BODY" | grep -q "\"$JOB_ID\""; then
  echo "FAIL: recent list does not include $JOB_ID" >&2
  printf '%s\n' "$LIST_BODY" >&2
  exit 1
fi
echo "  ok — recent list contains the historical job"

echo
echo "PASS: Phase 5 history smoke test"

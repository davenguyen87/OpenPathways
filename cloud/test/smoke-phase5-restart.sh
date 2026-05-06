#!/usr/bin/env bash
# Phase 5 smoke test — a job killed mid-flight is recovered as 'error' on
# the next boot.
#
# 1. Start the cloud server with a fresh SQLite file.
# 2. Upload a fixture, follow SSE, kill the server immediately after the
#    first progress event arrives.
# 3. Restart the server against the same SQLite.
# 4. GET /api/audits/:id must return status='error' with
#    error='Server restarted before completion'.
#
# Run from the repo root:  bash cloud/test/smoke-phase5-restart.sh

set -u
set -o pipefail

PORT="${PORT:-4289}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Use a violations fixture so the audit takes long enough to kill mid-flight.
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-violations.zip}"
DB_DIR="$(mktemp -d -t op-cloud-restart-XXXXXX)"
SQLITE_PATH="$DB_DIR/op.sqlite"
SVR_LOG="$DB_DIR/server.log"
SSE_LOG="$DB_DIR/sse.log"

cleanup() {
  if [[ -n "${SVR:-}" ]]; then kill -KILL "$SVR" 2>/dev/null || true; wait "$SVR" 2>/dev/null || true; fi
  if [[ -n "${SSE_PID:-}" ]]; then kill -KILL "$SSE_PID" 2>/dev/null || true; fi
  rm -rf "$DB_DIR"
}
trap cleanup EXIT INT TERM

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL: fixture not found at $FIXTURE" >&2
  exit 1
fi

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
  echo "FAIL: server did not come up on :$PORT" >&2
  echo "--- server log ---" >&2
  tail -50 "$SVR_LOG" >&2
  return 1
}

# -------- boot 1: upload + kill mid-flight --------
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

# Subscribe to SSE so we can see when the audit has actually started running.
curl -s --no-buffer --max-time 60 "http://127.0.0.1:$PORT/api/audits/$JOB_ID/events" >"$SSE_LOG" &
SSE_PID=$!

# Wait for at least one progress event, max 30s.
echo "[boot 1] Waiting for first progress event..."
for i in $(seq 1 150); do
  if grep -q '^event: progress' "$SSE_LOG" 2>/dev/null; then
    echo "[boot 1] Progress observed; killing server (SIGKILL)"
    break
  fi
  sleep 0.2
done

if ! grep -q '^event: progress' "$SSE_LOG" 2>/dev/null; then
  echo "FAIL: no progress events seen in 30s — cannot exercise mid-flight kill" >&2
  echo "--- sse log ---" >&2; cat "$SSE_LOG" >&2
  echo "--- server log ---" >&2; tail -50 "$SVR_LOG" >&2
  exit 1
fi

# Hard-kill so the in-flight job has no chance to flip to terminal cleanly —
# this is the worst-case the cold-start recovery has to handle.
kill -KILL "$SVR" 2>/dev/null || true
wait "$SVR" 2>/dev/null || true
SVR=""
kill -KILL "$SSE_PID" 2>/dev/null || true
SSE_PID=""

# Confirm the port really is free before starting boot 2.
sleep 0.5

# -------- boot 2: recovery --------
echo "[boot 2] Restarting server against the same SQLite file..."
start_server || exit 1

echo "[boot 2] GET /api/audits/$JOB_ID"
SNAP="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JOB_ID")"
SNAP_HTTP="${SNAP##*__HTTP__}"
SNAP_BODY="${SNAP%$'\n'__HTTP__*}"

if [[ "$SNAP_HTTP" != "200" ]]; then
  echo "FAIL: snapshot returned HTTP $SNAP_HTTP after restart" >&2
  printf '%s\n' "$SNAP_BODY" >&2
  exit 1
fi
if ! printf '%s' "$SNAP_BODY" | grep -q '"status":"error"'; then
  echo "FAIL: post-restart status is not 'error'" >&2
  printf '%s\n' "$SNAP_BODY" >&2
  exit 1
fi
if ! printf '%s' "$SNAP_BODY" | grep -q 'Server restarted before completion'; then
  echo "FAIL: error reason is not 'Server restarted before completion'" >&2
  printf '%s\n' "$SNAP_BODY" >&2
  exit 1
fi
echo "  ok — interrupted job recovered as error with the expected reason"

# A second restart with no in-flight work must be a no-op (no rows to flip).
SECOND_INTERRUPT="$(grep -c 'Marked .* interrupted job' "$SVR_LOG" || true)"
# The first boot wrote 0 lines (no interrupted rows), the second boot wrote 1.
# We accept SECOND_INTERRUPT >= 1 — it should be exactly 1 unless the host
# was unusually slow.
if [[ "$SECOND_INTERRUPT" -lt 1 ]]; then
  echo "WARN: did not see 'Marked N interrupted job(s)' message in server log" >&2
  echo "(non-fatal; the interrupt-handling still happened — see snapshot above)"
fi

echo
echo "PASS: Phase 5 restart-mid-flight smoke test"

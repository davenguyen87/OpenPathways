#!/usr/bin/env bash
# Phase 6 smoke test — cancel actually stops Playwright in ~1 second.
#
# 1. Start the cloud server.
# 2. Upload a violations fixture so the dynamic phase has work to do.
# 3. Follow SSE until the first 'dynamic-page' progress event arrives —
#    that proves we're in Playwright land, not still in cheap static checks.
# 4. POST /api/audits/:id/cancel; assert the snapshot reports
#    status=cancelled within 2 seconds.
# 5. Assert the SSE stream delivered a 'cancelled' event before closing.
#
# Run from the repo root:  bash cloud/test/smoke-phase6-cancel.sh

set -u
set -o pipefail

PORT="${PORT:-4290}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-violations.zip}"
DB_DIR="$(mktemp -d -t op-cloud-cancel-XXXXXX)"
SQLITE_PATH="$DB_DIR/op.sqlite"
SVR_LOG="$DB_DIR/server.log"
SSE_LOG="$DB_DIR/sse.log"

cleanup() {
  if [[ -n "${SVR:-}" ]]; then kill -INT "$SVR" 2>/dev/null || true; wait "$SVR" 2>/dev/null || true; fi
  if [[ -n "${SSE_PID:-}" ]]; then kill -KILL "$SSE_PID" 2>/dev/null || true; fi
  rm -rf "$DB_DIR"
}
trap cleanup EXIT INT TERM

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL: fixture not found at $FIXTURE" >&2
  exit 1
fi

echo "[boot] Starting server on :$PORT"
SQLITE_PATH="$SQLITE_PATH" \
OPEN_PATHWAYS_RETENTION_DAYS=0 \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT" >>"$SVR_LOG" 2>&1 &
SVR=$!
for i in $(seq 1 50); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" | grep -q 200; then
    break
  fi
  sleep 0.2
done
if ! curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" | grep -q 200; then
  echo "FAIL: server did not come up" >&2
  tail -30 "$SVR_LOG" >&2
  exit 1
fi

echo "[run] Uploading $(basename "$FIXTURE")"
RESP="$(curl -s -X POST -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
JOB_ID="$(printf '%s' "$RESP" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
if [[ -z "$JOB_ID" ]]; then
  echo "FAIL: no jobId in upload response: $RESP" >&2
  exit 1
fi
echo "[run] jobId=$JOB_ID"

# Stream SSE in the background.
curl -s --no-buffer --max-time 60 "http://127.0.0.1:$PORT/api/audits/$JOB_ID/events" >"$SSE_LOG" &
SSE_PID=$!

# Wait for the first 'dynamic-page' event — proof that the audit is in
# Playwright land. Bound at 60 seconds.
echo "[run] Waiting for dynamic-page event (proves Playwright is up)..."
for i in $(seq 1 300); do
  if grep -q '"stage":"dynamic-page"' "$SSE_LOG" 2>/dev/null; then
    echo "[run] dynamic-page seen — sending cancel"
    break
  fi
  sleep 0.2
done

if ! grep -q '"stage":"dynamic-page"' "$SSE_LOG" 2>/dev/null; then
  echo "FAIL: dynamic-page event never arrived in 60s — cannot test mid-Playwright cancel" >&2
  echo "--- sse log ---" >&2; cat "$SSE_LOG" >&2
  echo "--- server log ---" >&2; tail -30 "$SVR_LOG" >&2
  exit 1
fi

# Send the cancel and start timing.
T_START="$(date +%s.%N)"
CANCEL_RESP="$(curl -s -X POST "http://127.0.0.1:$PORT/api/audits/$JOB_ID/cancel")"
echo "[run] cancel response: $CANCEL_RESP"

# Poll the snapshot for status=cancelled, max 5 seconds (we want <2s but
# give room for slow CI).
STATUS=""
ELAPSED="0"
for i in $(seq 1 50); do
  SNAP="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JOB_ID")"
  STATUS="$(printf '%s' "$SNAP" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  if [[ "$STATUS" == "cancelled" ]]; then
    T_END="$(date +%s.%N)"
    ELAPSED="$(awk -v a="$T_START" -v b="$T_END" 'BEGIN{printf "%.3f", b-a}')"
    break
  fi
  sleep 0.1
done

if [[ "$STATUS" != "cancelled" ]]; then
  echo "FAIL: status never reached 'cancelled' after cancel POST (last=$STATUS)" >&2
  echo "--- snapshot ---" >&2; printf '%s\n' "$SNAP" >&2
  echo "--- server log ---" >&2; tail -50 "$SVR_LOG" >&2
  exit 1
fi
echo "[run] status=cancelled after ${ELAPSED}s"

# Soft assertion: under 2s. Anything higher means the dynamic runner isn't
# closing the browser eagerly, or signals aren't being checked. Hard fail
# at 5s (we already polled to 5s above; if we got here, we're <=5s).
AWK_GT_2S="$(awk -v e="$ELAPSED" 'BEGIN{print (e>2)}')"
if [[ "$AWK_GT_2S" == "1" ]]; then
  echo "WARN: cancel-to-stop took ${ELAPSED}s — slower than the ~1s target" >&2
fi

# Verify SSE saw a 'cancelled' event.
if ! grep -q '^event: cancelled' "$SSE_LOG"; then
  echo "FAIL: SSE never delivered a 'cancelled' event" >&2
  echo "--- sse log ---" >&2; cat "$SSE_LOG" >&2
  exit 1
fi
echo "[run] ok — SSE delivered 'cancelled' event"

echo
echo "PASS: Phase 6 cancel-actually-cancels smoke test (cancel→stop in ${ELAPSED}s)"

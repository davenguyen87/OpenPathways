#!/usr/bin/env bash
# Phase 2 end-to-end smoke test.
#
# Boots the server on a free port, uploads a fixture, follows the SSE stream
# until 'done', downloads JSON + Markdown reports, prints PASS/FAIL.
#
# Run from the project root or the web/ folder.

set -u
set -o pipefail

PORT="${PORT:-4287}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-clean.zip}"

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL: fixture not found at $FIXTURE" >&2
  exit 1
fi

echo "Booting server on :$PORT..."
node "$ROOT/web/server/index.js" --no-open --port "$PORT" >/tmp/op-web-smoke.log 2>&1 &
SVR=$!
trap 'kill -INT "$SVR" 2>/dev/null; wait "$SVR" 2>/dev/null; exit' EXIT INT TERM

# Wait until /api/version answers (max 5s).
for i in $(seq 1 25); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" | grep -q 200; then
    break
  fi
  sleep 0.2
done

echo "Uploading fixture: $(basename "$FIXTURE")"
RESP="$(curl -s -X POST -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
JOB_ID="$(printf '%s' "$RESP" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"

if [[ -z "$JOB_ID" ]]; then
  echo "FAIL: no jobId in upload response: $RESP" >&2
  exit 1
fi
echo "  jobId=$JOB_ID"

echo "Following SSE stream..."
SSE_LOG="/tmp/op-web-smoke-sse-$JOB_ID.log"
# --no-buffer so we get events as they arrive, --max-time as a safety net.
curl -s --no-buffer --max-time 180 "http://127.0.0.1:$PORT/api/audits/$JOB_ID/events" >"$SSE_LOG" &
SSE=$!

# Poll the snapshot endpoint until status is terminal (or 3 min).
STATUS=""
for i in $(seq 1 360); do
  SNAP="$(curl -s "http://127.0.0.1:$PORT/api/audits/$JOB_ID")"
  STATUS="$(printf '%s' "$SNAP" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  if [[ "$STATUS" == "done" || "$STATUS" == "error" ]]; then
    break
  fi
  sleep 0.5
done
kill "$SSE" 2>/dev/null
wait "$SSE" 2>/dev/null

echo "  final status=$STATUS"

if [[ "$STATUS" != "done" ]]; then
  echo "FAIL: audit did not complete cleanly" >&2
  echo "--- snapshot ---" >&2
  printf '%s\n' "$SNAP" >&2
  echo "--- sse log ---" >&2
  cat "$SSE_LOG" >&2
  echo "--- server log ---" >&2
  tail -40 /tmp/op-web-smoke.log >&2
  exit 1
fi

# Verify SSE saw at least one progress event and a terminal one.
PROGRESS_COUNT=$(grep -c '^event: progress' "$SSE_LOG" || true)
DONE_COUNT=$(grep -c '^event: done' "$SSE_LOG" || true)
echo "  SSE: $PROGRESS_COUNT progress events, $DONE_COUNT done events"

if [[ "$PROGRESS_COUNT" -lt 1 ]]; then
  echo "FAIL: SSE stream had no progress events" >&2
  exit 1
fi
if [[ "$DONE_COUNT" -lt 1 ]]; then
  echo "FAIL: SSE stream did not deliver a 'done' event" >&2
  cat "$SSE_LOG" >&2
  exit 1
fi

echo "Downloading reports..."
JSON_BODY="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JOB_ID/report.json")"
MD_BODY="$(curl -s -w '\n__HTTP__%{http_code}' "http://127.0.0.1:$PORT/api/audits/$JOB_ID/report.md")"

JSON_HTTP="${JSON_BODY##*__HTTP__}"
MD_HTTP="${MD_BODY##*__HTTP__}"
JSON_DATA="${JSON_BODY%$'\n'__HTTP__*}"
MD_DATA="${MD_BODY%$'\n'__HTTP__*}"

echo "  report.json: HTTP $JSON_HTTP, $(printf '%s' "$JSON_DATA" | wc -c | tr -d ' ') bytes"
echo "  report.md:   HTTP $MD_HTTP, $(printf '%s' "$MD_DATA" | wc -c | tr -d ' ') bytes"

if [[ "$JSON_HTTP" != "200" ]] || ! printf '%s' "$JSON_DATA" | grep -q '"score"'; then
  echo "FAIL: JSON report missing or malformed" >&2
  exit 1
fi
if [[ "$MD_HTTP" != "200" ]] || ! printf '%s' "$MD_DATA" | head -5 | grep -qi 'open pathways\|wcag\|scorecard'; then
  echo "FAIL: Markdown report missing or malformed" >&2
  echo "first lines:" >&2
  printf '%s' "$MD_DATA" | head -10 >&2
  exit 1
fi

echo "PASS: Phase 2 end-to-end smoke test"

#!/usr/bin/env bash
# Phase 9A smoke test — hosted-mode boot validation + helmet headers.
#
# 1. Boot in OPEN_PATHWAYS_MODE=hosted with no SESSION_SECRET — must
#    refuse to start (exit non-zero, error message printed).
# 2. Boot in OPEN_PATHWAYS_MODE=hosted with SESSION_SECRET set — must boot.
# 3. Curl /api/version with -i and assert these headers are present:
#      Strict-Transport-Security
#      X-Frame-Options: DENY
#      Content-Security-Policy
# 4. Tear down. Then boot in default local mode and assert:
#      Strict-Transport-Security is ABSENT (we're on plain HTTP).
#      X-Frame-Options: DENY is still present (defense in depth).
#
# Run from the repo root:  bash cloud/test/smoke-phase9a-hosted-headers.sh

set -u
set -o pipefail

PORT_REFUSE="${PORT_REFUSE:-4294}"
PORT_HOSTED="${PORT_HOSTED:-4295}"
PORT_LOCAL="${PORT_LOCAL:-4296}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB_DIR="$(mktemp -d -t op-cloud-9a-XXXXXX)"
SQLITE_PATH="$DB_DIR/op.sqlite"
SVR_LOG="$DB_DIR/server.log"

cleanup() {
  for pid in "${SVR:-}" "${SVR2:-}"; do
    [[ -n "$pid" ]] && kill -INT "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  rm -rf "$DB_DIR"
}
trap cleanup EXIT INT TERM

# -- 1. refuse-to-start without SESSION_SECRET --
echo "[refuse] booting hosted mode with no SESSION_SECRET (must exit non-zero)"
OPEN_PATHWAYS_MODE=hosted \
SQLITE_PATH="$SQLITE_PATH" \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT_REFUSE" >"$DB_DIR/refuse.log" 2>&1 &
RPID=$!
# Give it a moment to fail.
sleep 1
if kill -0 "$RPID" 2>/dev/null; then
  echo "FAIL: hosted mode booted without SESSION_SECRET (pid still alive)" >&2
  kill -9 "$RPID" 2>/dev/null || true
  cat "$DB_DIR/refuse.log" >&2
  exit 1
fi
wait "$RPID" 2>/dev/null
RC=$?
if [[ "$RC" == "0" ]]; then
  echo "FAIL: hosted-mode boot returned exit 0 without SESSION_SECRET" >&2
  cat "$DB_DIR/refuse.log" >&2
  exit 1
fi
if ! grep -q 'SESSION_SECRET' "$DB_DIR/refuse.log"; then
  echo "FAIL: refuse log does not mention SESSION_SECRET" >&2
  cat "$DB_DIR/refuse.log" >&2
  exit 1
fi
echo "[refuse] ok — exited $RC with SESSION_SECRET error"

# -- 2. boot hosted mode properly (Phase 9B requires allowlist + SMTP/capture) --
HOSTED_SQLITE="$DB_DIR/hosted.sqlite"
MAIL_DIR="$DB_DIR/mail"
echo "[hosted] booting hosted mode with SESSION_SECRET + allowlist + MAIL_CAPTURE_DIR"
OPEN_PATHWAYS_MODE=hosted \
SESSION_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef" \
ALLOWLIST_EMAIL_DOMAINS="example.com" \
MAIL_CAPTURE_DIR="$MAIL_DIR" \
SQLITE_PATH="$HOSTED_SQLITE" \
OPEN_PATHWAYS_RETENTION_DAYS=0 \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT_HOSTED" >>"$SVR_LOG" 2>&1 &
SVR=$!
for i in $(seq 1 50); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_HOSTED/api/version" | grep -q 200; then
    break
  fi
  sleep 0.2
done
if ! curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_HOSTED/api/version" | grep -q 200; then
  echo "FAIL: hosted mode did not come up" >&2
  tail -30 "$SVR_LOG" >&2
  exit 1
fi
echo "[hosted] ok — booted; checking headers"

HEAD_OUT="$(curl -sI "http://127.0.0.1:$PORT_HOSTED/api/version")"
fail_if_missing() {
  if ! printf '%s' "$HEAD_OUT" | grep -qi "^$1"; then
    echo "FAIL: hosted-mode response missing header: $1" >&2
    printf '%s\n' "$HEAD_OUT" >&2
    exit 1
  fi
}
fail_if_missing 'Strict-Transport-Security'
fail_if_missing 'X-Frame-Options'
fail_if_missing 'Content-Security-Policy'
if ! printf '%s' "$HEAD_OUT" | grep -i 'X-Frame-Options' | grep -qi 'DENY'; then
  echo "FAIL: X-Frame-Options is not DENY" >&2
  printf '%s\n' "$HEAD_OUT" >&2
  exit 1
fi
echo "[hosted] ok — Strict-Transport-Security, X-Frame-Options: DENY, Content-Security-Policy all present"

# Verify mode is reflected in /api/version body too.
VBODY="$(curl -s "http://127.0.0.1:$PORT_HOSTED/api/version")"
if ! printf '%s' "$VBODY" | grep -q '"mode":"hosted"'; then
  echo "FAIL: /api/version did not report mode=hosted: $VBODY" >&2
  exit 1
fi
echo "[hosted] ok — /api/version reports mode=hosted"

kill -INT "$SVR" 2>/dev/null
wait "$SVR" 2>/dev/null
SVR=""

# -- 3. local mode header check --
LOCAL_SQLITE="$DB_DIR/local.sqlite"
echo "[local] booting default (local) mode"
SQLITE_PATH="$LOCAL_SQLITE" \
OPEN_PATHWAYS_RETENTION_DAYS=0 \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT_LOCAL" >>"$SVR_LOG" 2>&1 &
SVR2=$!
for i in $(seq 1 50); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_LOCAL/api/version" | grep -q 200; then
    break
  fi
  sleep 0.2
done
HEAD_LOCAL="$(curl -sI "http://127.0.0.1:$PORT_LOCAL/api/version")"
if printf '%s' "$HEAD_LOCAL" | grep -qi '^Strict-Transport-Security'; then
  echo "FAIL: local mode emitted HSTS header (expected: absent on plain HTTP)" >&2
  printf '%s\n' "$HEAD_LOCAL" >&2
  exit 1
fi
if ! printf '%s' "$HEAD_LOCAL" | grep -i 'X-Frame-Options' | grep -qi 'DENY'; then
  echo "FAIL: local mode missing X-Frame-Options: DENY" >&2
  printf '%s\n' "$HEAD_LOCAL" >&2
  exit 1
fi
echo "[local] ok — no HSTS, X-Frame-Options: DENY still set"

echo
echo "PASS: Phase 9A hosted-mode header smoke test"

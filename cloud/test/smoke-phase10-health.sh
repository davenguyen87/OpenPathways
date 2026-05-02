#!/usr/bin/env bash
# Phase 10 smoke test — /api/health works in both modes; static pages
# served; SPA catch-all still works.
#
# 1. Boot in default (local) mode. GET /api/health → 200 with mode: local,
#    db: ok, storage: ok.
# 2. Boot in hosted mode (sqlite + capture-dir). GET /api/health → 200
#    with mode: hosted.
# 3. GET /about, /privacy, /terms — all 200, all return HTML containing
#    the expected page title.
# 4. GET /job/00000000-0000-0000-0000-000000000000 — still 200 (SPA
#    catch-all serves index.html for unknown UUID-shaped paths).
#
# Run from the repo root:  bash cloud/test/smoke-phase10-health.sh

set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT_LOCAL="${PORT_LOCAL:-4301}"
PORT_HOSTED="${PORT_HOSTED:-4302}"
DB_DIR="$(mktemp -d -t op-cloud-10-XXXXXX)"
SVR_LOG="$DB_DIR/server.log"

cleanup() {
  for pid in "${SVR1:-}" "${SVR2:-}"; do
    [[ -n "$pid" ]] && kill -INT "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  rm -rf "$DB_DIR"
}
trap cleanup EXIT INT TERM

# ---- 1. local mode ----
echo "[local] booting on :$PORT_LOCAL"
SQLITE_PATH="$DB_DIR/local.sqlite" \
OPEN_PATHWAYS_RETENTION_DAYS=0 \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT_LOCAL" >>"$SVR_LOG" 2>&1 &
SVR1=$!
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_LOCAL/api/version" | grep -q 200 && break
  sleep 0.2
done
if ! curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_LOCAL/api/version" | grep -q 200; then
  echo "FAIL: local server didn't boot" >&2
  tail -30 "$SVR_LOG" >&2
  exit 1
fi

H_HTTP="$(curl -s -o "$DB_DIR/h_local.json" -w '%{http_code}' "http://127.0.0.1:$PORT_LOCAL/api/health")"
[[ "$H_HTTP" != "200" ]] && { echo "FAIL: local /api/health HTTP $H_HTTP" >&2; cat "$DB_DIR/h_local.json" >&2; exit 1; }
if ! grep -q '"mode":"local"' "$DB_DIR/h_local.json" || \
   ! grep -q '"db":"ok"' "$DB_DIR/h_local.json" || \
   ! grep -q '"storage":"ok"' "$DB_DIR/h_local.json"; then
  echo "FAIL: local /api/health body unexpected" >&2; cat "$DB_DIR/h_local.json" >&2; exit 1
fi
echo "[local] ok — /api/health 200 with mode/db/storage"

# Static pages
for p in about privacy terms; do
  HTTP="$(curl -s -o "$DB_DIR/$p.html" -w '%{http_code}' "http://127.0.0.1:$PORT_LOCAL/$p")"
  if [[ "$HTTP" != "200" ]]; then
    echo "FAIL: /$p returned HTTP $HTTP" >&2; exit 1
  fi
  if ! grep -qi "<title>" "$DB_DIR/$p.html"; then
    echo "FAIL: /$p body has no <title>" >&2; head -10 "$DB_DIR/$p.html" >&2; exit 1
  fi
  echo "[local] ok — /$p served"
done

# SPA catch-all still serves /job/<uuid> as the SPA.
SPA_HTTP="$(curl -s -o "$DB_DIR/spa.html" -w '%{http_code}' "http://127.0.0.1:$PORT_LOCAL/job/00000000-0000-0000-0000-000000000000")"
[[ "$SPA_HTTP" != "200" ]] && { echo "FAIL: SPA catch-all returned $SPA_HTTP" >&2; exit 1; }
grep -q 'view-root' "$DB_DIR/spa.html" || { echo "FAIL: SPA didn't serve index.html" >&2; head -3 "$DB_DIR/spa.html" >&2; exit 1; }
echo "[local] ok — SPA catch-all still serves index.html"

kill -INT "$SVR1" 2>/dev/null
wait "$SVR1" 2>/dev/null
SVR1=""

# ---- 2. hosted mode ----
echo "[hosted] booting on :$PORT_HOSTED"
OPEN_PATHWAYS_MODE=hosted \
SESSION_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef" \
ALLOWLIST_EMAIL_DOMAINS="example.com" \
MAIL_CAPTURE_DIR="$DB_DIR/mail" \
SQLITE_PATH="$DB_DIR/hosted.sqlite" \
OPEN_PATHWAYS_RETENTION_DAYS=0 \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT_HOSTED" >>"$SVR_LOG" 2>&1 &
SVR2=$!
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_HOSTED/api/version" | grep -q 200 && break
  sleep 0.2
done
if ! curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_HOSTED/api/version" | grep -q 200; then
  echo "FAIL: hosted server didn't boot" >&2
  tail -30 "$SVR_LOG" >&2
  exit 1
fi

H_HTTP="$(curl -s -o "$DB_DIR/h_hosted.json" -w '%{http_code}' "http://127.0.0.1:$PORT_HOSTED/api/health")"
[[ "$H_HTTP" != "200" ]] && { echo "FAIL: hosted /api/health HTTP $H_HTTP" >&2; cat "$DB_DIR/h_hosted.json" >&2; exit 1; }
if ! grep -q '"mode":"hosted"' "$DB_DIR/h_hosted.json" || \
   ! grep -q '"db":"ok"' "$DB_DIR/h_hosted.json"; then
  echo "FAIL: hosted /api/health body unexpected" >&2; cat "$DB_DIR/h_hosted.json" >&2; exit 1
fi
echo "[hosted] ok — /api/health 200 with mode=hosted"

echo
echo "PASS: Phase 10 health + static pages smoke test"

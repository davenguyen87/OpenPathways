#!/usr/bin/env bash
# Phase 9C smoke test — per-user quota enforcement.
#
# Three independent scenarios, each booted fresh:
#   1. QUOTA_CONCURRENT_JOBS=1 → second simultaneous upload returns 429
#      with reason=concurrent. After the first finishes, a third upload
#      succeeds.
#   2. QUOTA_UPLOADS_PER_DAY=2 → third upload (after the first two finish)
#      returns 429 with reason=daily.
#   3. QUOTA_STORED_BYTES set just above one fixture but below two.
#      First upload succeeds; second upload is rejected with reason=storage.
#
# All three reuse the same magic-link login flow as smoke-phase9b-auth.sh.
# Run from the repo root:  bash cloud/test/smoke-phase9c-quotas.sh

set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_CLEAN="${FIXTURE_CLEAN:-$ROOT/test/fixtures/scorm12-clean.zip}"
FIXTURE_VIOL="${FIXTURE_VIOL:-$ROOT/test/fixtures/scorm12-violations.zip}"
[[ -f "$FIXTURE_CLEAN" ]] || { echo "FAIL: missing $FIXTURE_CLEAN" >&2; exit 1; }
[[ -f "$FIXTURE_VIOL" ]]  || { echo "FAIL: missing $FIXTURE_VIOL"  >&2; exit 1; }

# Helpers reused across scenarios.
extract_link() {
  local mailbox="$1" email="$2"
  node -e '
(() => {
  const fs=require("fs"),path=require("path");
  const dir=process.argv[1], target=process.argv[2];
  const files=fs.readdirSync(dir).filter(f=>f.endsWith(".json")).sort().reverse();
  for (const f of files){
    const m=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
    if (m.to===target){
      const link=String(m.text||"").match(/(https?:\/\/[^\s]+\/api\/auth\/verify\/[A-Za-z0-9]+)/) || String(m.text||"").match(/(\/api\/auth\/verify\/[A-Za-z0-9]+)/);
      if (link){ process.stdout.write(link[1]); return; }
    }
  }
  process.exit(2);
})();
' "$mailbox" "$email"
}

login() {
  local port="$1" email="$2" jar="$3" mail_dir="$4"
  curl -s -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$email\"}" "http://127.0.0.1:$port/api/auth/request" >/dev/null
  local link=""
  for i in $(seq 1 25); do
    link="$(extract_link "$mail_dir" "$email" 2>/dev/null || echo "")"
    [[ -n "$link" ]] && break
    sleep 0.1
  done
  [[ -z "$link" ]] && { echo "FAIL: no captured email for $email" >&2; return 1; }
  local p
  p="$(printf '%s' "$link" | sed -E 's|^https?://[^/]+||')"
  curl -s -c "$jar" -o /dev/null "http://127.0.0.1:$port$p"
  grep -q 'op_session' "$jar" || { echo "FAIL: no op_session for $email" >&2; return 1; }
}

get_csrf() {
  local port="$1" jar="$2"
  curl -s -b "$jar" -c "$jar" "http://127.0.0.1:$port/api/auth/me" | \
    node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).csrfToken||"")}catch(e){}})'
}

# Boot helper: start a hosted-mode server with caller-supplied env.
# Usage: boot_server <port> <db_dir> [extra env=val ...]
boot_server() {
  local port="$1"; shift
  local db_dir="$1"; shift
  mkdir -p "$db_dir/mail"
  (
    export OPEN_PATHWAYS_MODE=hosted
    export SESSION_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef"
    export ALLOWLIST_EMAIL_DOMAINS="example.com"
    export MAIL_CAPTURE_DIR="$db_dir/mail"
    export SQLITE_PATH="$db_dir/op.sqlite"
    export OPEN_PATHWAYS_RETENTION_DAYS=0
    for kv in "$@"; do export "$kv"; done
    node "$ROOT/cloud/server/index.js" --no-open --port "$port" >>"$db_dir/server.log" 2>&1 &
    echo $! >"$db_dir/server.pid"
    wait
  ) &
  # Wait for /api/version (max 10 s).
  for i in $(seq 1 50); do
    curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/version" 2>/dev/null | grep -q 200 && return 0
    sleep 0.2
  done
  echo "FAIL: server on :$port did not boot" >&2
  tail -30 "$db_dir/server.log" >&2
  return 1
}

stop_server() {
  local db_dir="$1"
  local pid
  pid="$(cat "$db_dir/server.pid" 2>/dev/null || echo "")"
  [[ -n "$pid" ]] && kill -INT "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  rm -f "$db_dir/server.pid"
}

cleanup() {
  for d in "${ALL_DIRS[@]:-}"; do
    [[ -n "$d" ]] && stop_server "$d" 2>/dev/null
    [[ -n "$d" && "${KEEP_ARTIFACTS:-}" != "1" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT INT TERM
ALL_DIRS=()

# ---------------------------------------------------------------------
# Scenario 1: QUOTA_CONCURRENT_JOBS=1
# ---------------------------------------------------------------------
PORT_C=4298
DIR_C="$(mktemp -d -t op-cloud-9c-conc-XXXXXX)"
ALL_DIRS+=("$DIR_C")
echo "[s1] booting hosted with QUOTA_CONCURRENT_JOBS=1 on :$PORT_C"
boot_server "$PORT_C" "$DIR_C" "QUOTA_CONCURRENT_JOBS=1" || exit 1

JAR_C="$DIR_C/alice.jar"
login "$PORT_C" "alice@example.com" "$JAR_C" "$DIR_C/mail" || exit 1
CSRF_C="$(get_csrf "$PORT_C" "$JAR_C")"
[[ -z "$CSRF_C" ]] && { echo "FAIL: no csrfToken (s1)" >&2; exit 1; }

# Upload a violations fixture so the first job stays running for a while.
RESP1="$(curl -s -X POST -b "$JAR_C" -H "X-CSRF-Token: $CSRF_C" -F "package=@$FIXTURE_VIOL" "http://127.0.0.1:$PORT_C/api/audits")"
JID1="$(printf '%s' "$RESP1" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).jobId||"")}catch(e){}})')"
[[ -z "$JID1" ]] && { echo "FAIL: first upload failed: $RESP1" >&2; exit 1; }
echo "[s1] first upload ok — jobId=$JID1"

# Second upload while first is in flight — must 429 with reason=concurrent.
RESP2_HTTP="$(curl -s -o "$DIR_C/resp2.json" -w '%{http_code}' -X POST -b "$JAR_C" -H "X-CSRF-Token: $CSRF_C" -F "package=@$FIXTURE_CLEAN" "http://127.0.0.1:$PORT_C/api/audits")"
if [[ "$RESP2_HTTP" != "429" ]]; then
  echo "FAIL: second concurrent upload returned $RESP2_HTTP (expected 429)" >&2
  cat "$DIR_C/resp2.json" >&2
  exit 1
fi
REASON2="$(node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).reason||"")}catch(e){}})' < "$DIR_C/resp2.json")"
[[ "$REASON2" != "concurrent" ]] && { echo "FAIL: expected reason=concurrent, got $REASON2" >&2; exit 1; }
echo "[s1] ok — second upload → 429 reason=concurrent"

# Wait for the first job to finish, then a third upload should succeed.
for i in $(seq 1 360); do
  S="$(curl -s -b "$JAR_C" "http://127.0.0.1:$PORT_C/api/audits/$JID1" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  [[ "$S" == "done" || "$S" == "error" ]] && break
  sleep 0.5
done
RESP3="$(curl -s -X POST -b "$JAR_C" -H "X-CSRF-Token: $CSRF_C" -F "package=@$FIXTURE_CLEAN" "http://127.0.0.1:$PORT_C/api/audits")"
JID3="$(printf '%s' "$RESP3" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).jobId||"")}catch(e){}})')"
[[ -z "$JID3" ]] && { echo "FAIL: third upload (after first done) failed: $RESP3" >&2; exit 1; }
echo "[s1] ok — third upload (after slot freed) → $JID3"

stop_server "$DIR_C"

# ---------------------------------------------------------------------
# Scenario 2: QUOTA_STORED_BYTES tiny (rejects every real fixture)
# ---------------------------------------------------------------------
PORT_S=4299
DIR_S="$(mktemp -d -t op-cloud-9c-stor-XXXXXX)"
ALL_DIRS+=("$DIR_S")
echo "[s2] booting hosted with QUOTA_STORED_BYTES=1024 on :$PORT_S"
boot_server "$PORT_S" "$DIR_S" "QUOTA_STORED_BYTES=1024" || exit 1

JAR_S="$DIR_S/alice.jar"
login "$PORT_S" "alice@example.com" "$JAR_S" "$DIR_S/mail" || exit 1
CSRF_S="$(get_csrf "$PORT_S" "$JAR_S")"
[[ -z "$CSRF_S" ]] && { echo "FAIL: no csrfToken (s2)" >&2; exit 1; }

RESP_S_HTTP="$(curl -s -o "$DIR_S/resp.json" -w '%{http_code}' -X POST -b "$JAR_S" -H "X-CSRF-Token: $CSRF_S" -F "package=@$FIXTURE_CLEAN" "http://127.0.0.1:$PORT_S/api/audits")"
if [[ "$RESP_S_HTTP" != "429" ]]; then
  echo "FAIL: storage-cap upload returned $RESP_S_HTTP (expected 429)" >&2
  cat "$DIR_S/resp.json" >&2
  exit 1
fi
REASON_S="$(node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).reason||"")}catch(e){}})' < "$DIR_S/resp.json")"
[[ "$REASON_S" != "storage" ]] && { echo "FAIL: expected reason=storage, got $REASON_S" >&2; exit 1; }
echo "[s2] ok — over-cap upload → 429 reason=storage"

stop_server "$DIR_S"

# ---------------------------------------------------------------------
# Scenario 3: QUOTA_UPLOADS_PER_DAY=2 with QUOTA_CONCURRENT_JOBS high so
# concurrent isn't the limit. Need three sequential uploads; first two
# succeed, third is 429 reason=daily.
# ---------------------------------------------------------------------
PORT_D=4300
DIR_D="$(mktemp -d -t op-cloud-9c-day-XXXXXX)"
ALL_DIRS+=("$DIR_D")
echo "[s3] booting hosted with QUOTA_UPLOADS_PER_DAY=2 on :$PORT_D"
boot_server "$PORT_D" "$DIR_D" "QUOTA_UPLOADS_PER_DAY=2" "QUOTA_CONCURRENT_JOBS=10" || exit 1

JAR_D="$DIR_D/alice.jar"
login "$PORT_D" "alice@example.com" "$JAR_D" "$DIR_D/mail" || exit 1
CSRF_D="$(get_csrf "$PORT_D" "$JAR_D")"

# Upload twice — both should succeed.
for i in 1 2; do
  R="$(curl -s -X POST -b "$JAR_D" -H "X-CSRF-Token: $CSRF_D" -F "package=@$FIXTURE_CLEAN" "http://127.0.0.1:$PORT_D/api/audits")"
  J="$(printf '%s' "$R" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).jobId||"")}catch(e){}})')"
  [[ -z "$J" ]] && { echo "FAIL: upload $i failed: $R" >&2; exit 1; }
  # Wait for it so the next upload sees a clean concurrent slot.
  for j in $(seq 1 360); do
    S="$(curl -s -b "$JAR_D" "http://127.0.0.1:$PORT_D/api/audits/$J" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
    [[ "$S" == "done" || "$S" == "error" ]] && break
    sleep 0.5
  done
done
echo "[s3] ok — first two uploads succeeded"

# Third upload — must 429 reason=daily.
HTTP3="$(curl -s -o "$DIR_D/resp3.json" -w '%{http_code}' -X POST -b "$JAR_D" -H "X-CSRF-Token: $CSRF_D" -F "package=@$FIXTURE_CLEAN" "http://127.0.0.1:$PORT_D/api/audits")"
[[ "$HTTP3" != "429" ]] && { echo "FAIL: third upload returned $HTTP3 (expected 429)" >&2; cat "$DIR_D/resp3.json" >&2; exit 1; }
REASON3="$(node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).reason||"")}catch(e){}})' < "$DIR_D/resp3.json")"
[[ "$REASON3" != "daily" ]] && { echo "FAIL: expected reason=daily, got $REASON3" >&2; exit 1; }
echo "[s3] ok — third upload → 429 reason=daily"

stop_server "$DIR_D"

echo
echo "PASS: Phase 9C quotas smoke test"

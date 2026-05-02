#!/usr/bin/env bash
# Phase 9B smoke test — magic-link auth + CSRF + tenant isolation.
#
# 1. Boot in OPEN_PATHWAYS_MODE=hosted with sqlite + local-fs + MAIL_CAPTURE_DIR
#    + allowlist for example.com.
# 2. POST /api/auth/request {email: alice@example.com} → 200; capture email,
#    extract verify URL.
# 3. GET the verify URL → 200 with Set-Cookie op_session=...
# 4. GET /api/auth/me with cookie → 200 { user, csrfToken }.
# 5. POST /api/audits with cookie + CSRF → 201 jobId.
# 6. POST /api/audits with cookie but NO CSRF → 403.
# 7. POST /api/auth/request {email: mallory@evil.com} → 403 (allowlist).
# 8. Repeat the verify flow for bob@example.com; verify GET /api/audits with
#    Bob's cookie does NOT include Alice's job (tenant isolation).
# 9. POST /api/audits with no cookie → 401.
#
# Run from the repo root:  bash cloud/test/smoke-phase9b-auth.sh

set -u
set -o pipefail

PORT="${PORT:-4297}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/test/fixtures/scorm12-clean.zip}"
DB_DIR="$(mktemp -d -t op-cloud-9b-XXXXXX)"
SQLITE_PATH="$DB_DIR/op.sqlite"
SVR_LOG="$DB_DIR/server.log"
MAIL_DIR="$DB_DIR/mail"
mkdir -p "$MAIL_DIR"
ALICE_JAR="$DB_DIR/alice.jar"
BOB_JAR="$DB_DIR/bob.jar"

cleanup() {
  if [[ -n "${SVR:-}" ]]; then kill -INT "$SVR" 2>/dev/null && wait "$SVR" 2>/dev/null; fi
  if [[ "${KEEP_ARTIFACTS:-}" == "1" ]]; then
    echo "(KEEP_ARTIFACTS=1; preserving $DB_DIR)" >&2
  else
    rm -rf "$DB_DIR"
  fi
}
trap cleanup EXIT INT TERM

[[ -f "$FIXTURE" ]] || { echo "FAIL: fixture missing" >&2; exit 1; }

echo "[boot] hosted mode on :$PORT"
OPEN_PATHWAYS_MODE=hosted \
SESSION_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef" \
ALLOWLIST_EMAIL_DOMAINS="example.com" \
MAIL_CAPTURE_DIR="$MAIL_DIR" \
SQLITE_PATH="$SQLITE_PATH" \
OPEN_PATHWAYS_RETENTION_DAYS=0 \
  node "$ROOT/cloud/server/index.js" --no-open --port "$PORT" >>"$SVR_LOG" 2>&1 &
SVR=$!
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" | grep -q 200 && break
  sleep 0.2
done
if ! curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" | grep -q 200; then
  echo "FAIL: server did not boot" >&2; tail -50 "$SVR_LOG" >&2; exit 1
fi

# --- pre-auth assertion: POST /api/audits without cookie → 401 ---
PRE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
if [[ "$PRE" != "401" ]]; then
  echo "FAIL: unauthenticated POST /api/audits returned $PRE (expected 401)" >&2; exit 1
fi
echo "[pre] ok — unauth POST /api/audits → 401"

extract_link() {
  local mailbox="$1" email="$2"
  # Find the most recent capture whose 'to' equals email; print its verifyUrl.
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
  local email="$1" jar="$2"
  RESP="$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$email\"}" "http://127.0.0.1:$PORT/api/auth/request")"
  if ! printf '%s' "$RESP" | grep -q '"ok":true'; then
    echo "FAIL: /api/auth/request $email did not return ok: $RESP" >&2; return 1
  fi
  # Wait briefly for the JSON file to land.
  for i in $(seq 1 25); do
    LINK="$(extract_link "$MAIL_DIR" "$email" 2>/dev/null || echo "")"
    [[ -n "$LINK" ]] && break
    sleep 0.1
  done
  if [[ -z "$LINK" ]]; then
    echo "FAIL: no captured email for $email" >&2; ls "$MAIL_DIR" >&2; return 1
  fi
  # The link captured may be relative or absolute; either way the path
  # portion is what we need. We hit our own server.
  local p
  p="$(printf '%s' "$LINK" | sed -E 's|^https?://[^/]+||')"
  curl -s -c "$jar" -o /dev/null "http://127.0.0.1:$PORT$p"
  # Sanity: the cookie jar now has op_session.
  if ! grep -q 'op_session' "$jar"; then
    echo "FAIL: no op_session cookie set for $email" >&2
    cat "$jar" >&2
    return 1
  fi
  echo "  ok — $email signed in"
}

echo "[login] alice@example.com"
login "alice@example.com" "$ALICE_JAR" || exit 1

# Fetch /api/auth/me to get csrfToken.
ME="$(curl -s -b "$ALICE_JAR" -c "$ALICE_JAR" "http://127.0.0.1:$PORT/api/auth/me")"
ALICE_CSRF="$(printf '%s' "$ME" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); process.stdout.write(j.csrfToken||"")})')"
[[ -z "$ALICE_CSRF" ]] && { echo "FAIL: no csrfToken from /api/auth/me: $ME" >&2; exit 1; }
echo "[me] ok — got csrfToken (${#ALICE_CSRF} chars)"

# --- POST /api/audits without CSRF → 403 ---
NO_CSRF="$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$ALICE_JAR" -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
if [[ "$NO_CSRF" != "403" ]]; then
  echo "FAIL: POST without CSRF returned $NO_CSRF (expected 403)" >&2; exit 1
fi
echo "[csrf] ok — POST without CSRF → 403"

# --- POST /api/audits with cookie + CSRF → 201 ---
RESP="$(curl -s -X POST -b "$ALICE_JAR" -H "X-CSRF-Token: $ALICE_CSRF" -F "package=@$FIXTURE" "http://127.0.0.1:$PORT/api/audits")"
ALICE_JOB_ID="$(printf '%s' "$RESP" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d); process.stdout.write(j.jobId||"")}catch(e){}})')"
[[ -z "$ALICE_JOB_ID" ]] && { echo "FAIL: authenticated upload did not return jobId: $RESP" >&2; exit 1; }
echo "[upload] ok — Alice's jobId=$ALICE_JOB_ID"

# Wait for Alice's job to finish.
for i in $(seq 1 360); do
  S="$(curl -s -b "$ALICE_JAR" "http://127.0.0.1:$PORT/api/audits/$ALICE_JOB_ID" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  [[ "$S" == "done" || "$S" == "error" ]] && break
  sleep 0.5
done
[[ "$S" != "done" ]] && { echo "FAIL: Alice's job didn't complete (status=$S)" >&2; exit 1; }

# --- mallory@evil.com is NOT allowlisted → 403 ---
M_HTTP="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"email":"mallory@evil.com"}' "http://127.0.0.1:$PORT/api/auth/request")"
if [[ "$M_HTTP" != "403" ]]; then
  echo "FAIL: non-allowlisted email returned $M_HTTP (expected 403)" >&2; exit 1
fi
echo "[allowlist] ok — mallory@evil.com → 403"

# --- bob@example.com signs in; should not see Alice's job ---
echo "[login] bob@example.com"
login "bob@example.com" "$BOB_JAR" || exit 1

BOB_LIST="$(curl -s -b "$BOB_JAR" "http://127.0.0.1:$PORT/api/audits")"
if printf '%s' "$BOB_LIST" | grep -q "\"$ALICE_JOB_ID\""; then
  echo "FAIL: Bob's GET /api/audits leaked Alice's jobId" >&2
  printf '%s\n' "$BOB_LIST" >&2; exit 1
fi
echo "[isolation] ok — Bob does not see Alice's job in /api/audits"

# Direct fetch by id should also 404 for Bob.
BOB_DIRECT="$(curl -s -o /dev/null -w '%{http_code}' -b "$BOB_JAR" "http://127.0.0.1:$PORT/api/audits/$ALICE_JOB_ID")"
if [[ "$BOB_DIRECT" != "404" ]]; then
  echo "FAIL: Bob fetching Alice's job by id returned $BOB_DIRECT (expected 404)" >&2; exit 1
fi
echo "[isolation] ok — Bob fetching Alice's job by id → 404"

echo
echo "PASS: Phase 9B auth + CSRF + tenant-isolation smoke test"

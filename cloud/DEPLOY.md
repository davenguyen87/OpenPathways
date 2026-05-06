# Prism Cloud — Deploy

End-to-end: how to put this on a real URL via Coolify on a self-hosted VPS.

The full plan lives in `ROADMAP.md` Phase 10. This document is the
operational runbook — what you need to install, configure, and verify.

---

## Coolify quickstart (10 minutes)

Push this repo to GitHub, then in Coolify do these steps in order. Every
field listed has a specific value — don't improvise.

**Prerequisites**
- Coolify installed on an 8 GB / 2–4 vCPU VPS.
- A domain pointed at the VPS (CNAME `Prism` → coolify-host).
- An SMTP provider (Postmark, SES, Mailgun, ...) with credentials ready,
  OR you accept that you'll only test the captured-email path first.

---

**1. Provision Postgres** — Coolify → **Project → Add Resource → Database
→ PostgreSQL 16**. Name it whatever; copy the connection string Coolify
shows (it will look like `postgres://user:pass@hostname:5432/dbname`).
This is your `DATABASE_URL`.

**2. Add the application** — Coolify → **Add Resource → Application →
Public Repository** (or private with deploy key). Then:
- **Build Pack:** `Docker Compose`
- **Repository root:** Leave blank (uses repo root by default).
- **Health check path:** `/api/health`
- **Domain:** `Prism.skill-loop.com` (Coolify provisions Let's Encrypt).

**3. Set environment variables** in Coolify's UI (Application → Environment).
The `docker-compose.yaml` at repo root references these variables and injects
them into all four services (web, worker, minio, minio-init):

```
PUBLIC_BASE_URL=https://Prism.skill-loop.com
SESSION_SECRET=<output of: openssl rand -hex 32>
DATABASE_URL=<from step 1>
S3_ACCESS_KEY=<random alphanumeric, e.g. minioadmin>
S3_SECRET_KEY=<random alphanumeric>
ALLOWLIST_EMAIL_DOMAINS=skill-loop.com
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587
SMTP_USER=<your SMTP user>
SMTP_PASS=<your SMTP password>
SMTP_FROM=Prism <noreply@skill-loop.com>
PRISM_RETENTION_DAYS=30
QUOTA_CONCURRENT_JOBS=2
QUOTA_UPLOADS_PER_DAY=50
QUOTA_STORED_BYTES=5368709120
```

(Sensible defaults for the rest are baked into the compose file; see
`docker-compose.yaml` for details.)

**4. Deploy.** Coolify reads `/docker-compose.yaml` at repo root and brings
up four services in a single stack: `web` (binds to port 80 inside the
container for Traefik routing), `worker` (Playwright job processor), `minio`
(S3-compatible object storage), and `minio-init` (one-shot bucket creator).
The services share a Docker network natively, so `minio` is reachable as
just `minio:9000` from web/worker without exposing it publicly.

Watch the logs; you should see:
- `minio-init` complete and exit (bucket created or already exists).
- `web` and `worker` start and report healthy.
- `worker` logs show `subscribed to pg-boss` once Postgres is reachable.

**5. Verify** in this order:
- `curl https://Prism.skill-loop.com/api/health` → `{"mode":"hosted","db":"ok","storage":"ok"}` (HTTP 200).
- `curl -I https://Prism.skill-loop.com` → response includes
  `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `Content-Security-Policy`.
- Visit `https://Prism.skill-loop.com` in a browser; you see the login form.
- Enter an allowlisted email → "Check your email"; the email actually
  arrives (or hits your inbox catcher).
- Click the link → redirected to `/`, logged in (your email shown top right).
- Drop a `.zip`; the audit completes; the report is downloadable.
- In Coolify's logs (Application → Logs), you see the web accepting the
  upload and the worker dequeuing + processing the pg-boss job.

If any of these fail, jump to **Troubleshooting** below.

---

## How Coolify builds and deploys this repo

**Coolify reads `/docker-compose.yaml` at the repo root** as the build pack.
The compose file bundles four services in a single stack so they share a
Docker network natively:

1. **Web service** (`web`): Runs the default `CMD` from `cloud/Dockerfile`
   (`node cloud/server/index.js --no-open`), bound to port 80 inside the
   container. Coolify's auto-Traefik routing (which targets port 80 by default
   for compose apps) forwards traffic here. Runs as `root` so it can bind to
   the low port (the Playwright image's `pwuser` cannot). No sensitive
   on-disk state — uploads go to MinIO, sessions/jobs to Postgres.

2. **Worker service** (`worker`): Runs `node cloud/worker/index.js` (command
   override in the compose file). Consumes pg-boss queue jobs from Postgres
   and runs audits via Chromium (pre-installed in the Playwright base image).
   Resource limits (`memory: 4g`, `cpus: "2"`) prevent it from starving
   Postgres or web on an 8 GB box.

3. **MinIO service** (`minio`): S3-compatible object storage. Listens on
   `minio:9000` (reachable only within the Docker network, not publicly
   exposed). Stores uploaded `.zip` files and extracted artifacts.

4. **MinIO-init service** (`minio-init`): One-shot container using `minio/mc`
   to create the upload bucket if it doesn't exist. Runs only on first deploy,
   then exits. Re-runs idempotently on every redeploy.

**Postgres is separate.** Coolify provisions it as a managed resource
(not part of the compose stack). Web/worker reach it via the external
`coolify` Docker network (the compose file declares `networks: coolify:
external: true`). The auto-generated `DATABASE_URL` env var includes the
internal Coolify hostname.

**Domain & TLS.** In Coolify's application UI, navigate to **Domains** and
add `Prism.skill-loop.com`. Coolify auto-provisions a Let's Encrypt
cert. No `docker_compose_domains` field is needed — the web service binds
to port 80 (Traefik's default), so Coolify routes traffic there
automatically.

**Environment variables.** All variables are injected by Coolify at deploy
time. The compose file reads them via `${VAR_NAME}` syntax and passes them
to all four services. There is no `.env` file in production — Coolify injects
everything at runtime via the Application → Environment tab.

---

## TL;DR (mental model)

The above quickstart is the literal recipe. The mental model:

- **Postgres** (separate Coolify resource) holds users, sessions, jobs,
  audit logs, the pg-boss queue.
- **MinIO** (one of four services in the compose stack) holds uploaded `.zip`
  files and extracted artifacts. Reachable as `minio:9000` within the
  internal Docker network.
- **Web service** terminates HTTPS (via Coolify's Traefik), authenticates
  users, accepts uploads, enqueues to pg-boss.
- **Worker service** dequeues from pg-boss, runs `audit()` against Chromium,
  writes results back to Postgres.
- **One image, two commands.** The Dockerfile builds once; the compose file
  runs the same image twice with different entry points.

---

## Required environment

Every variable the compose file uses, with defaults and required context.
Set these in Coolify's Environment tab. The compose file injects them into
all four services.

| Var                            | Used by                       | Default                | Notes                                                                                       |
| ------------------------------ | ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`              | web                           | —                      | e.g. `https://Prism.skill-loop.com`. Used in magic-link emails. **Required.**        |
| `SESSION_SECRET`               | web                           | —                      | Hex, 32+ chars. Generate with `openssl rand -hex 32`. **Required.**                         |
| `DATABASE_URL`                 | web + worker                  | —                      | Postgres connection string from Coolify. **Required.** Format: `postgres://user:pass@host:5432/db` |
| `S3_ACCESS_KEY`                | web + worker + minio-init     | —                      | MinIO root user. Can be `minioadmin` or any alphanumeric. **Required.**                     |
| `S3_SECRET_KEY`                | web + worker + minio          | —                      | MinIO root password. Should be strong random. **Required.**                                 |
| `AUTH_ADAPTER`                 | web + worker                  | `magic-link`           | Auth adapter: `magic-link` (production) or `none` (testing only—disables auth entirely). |
| `ALLOWLIST_EMAIL_DOMAINS`      | web                           | —                      | Comma-separated domains (e.g. `skill-loop.com,example.com`). At least one of `*_DOMAINS` / `*_EMAILS` required (not needed if `AUTH_ADAPTER=none`). |
| `ALLOWLIST_EMAILS`             | web                           | —                      | Comma-separated specific addresses. At least one of `*_DOMAINS` / `*_EMAILS` required.      |
| `SMTP_HOST`                    | web                           | —                      | Your SMTP provider (Postmark, SES, Mailgun, etc.). **Required** unless testing captured email. |
| `SMTP_PORT`                    | web                           | `587`                  | Usually 587 (STARTTLS) or 465 (implicit TLS).                                               |
| `SMTP_USER`                    | web                           | —                      | SMTP login user (e.g. API key for some providers).                                          |
| `SMTP_PASS`                    | web                           | —                      | SMTP login password.                                                                        |
| `SMTP_FROM`                    | web                           | `Prism <noreply@example.com>` | Sender address. Set to a domain you control (should match DKIM/SPF). |
| `PRISM_RETENTION_DAYS` | web                           | `30`                   | Job retention (audit results). Set to `30` in production.                                    |
| `QUOTA_CONCURRENT_JOBS`        | web                           | `2`                    | Max uploads per user at once. Per-user limit.                                                |
| `QUOTA_UPLOADS_PER_DAY`        | web                           | `50`                   | Max uploads per user per day. Per-user limit.                                                |
| `QUOTA_STORED_BYTES`           | web                           | `5368709120` (5 GiB)   | Max bytes per user. Per-user limit.                                                         |
| `QUOTA_STORED_BYTES_TOTAL`     | web                           | `0` (disabled)         | Bucket-wide cap; triggers eviction of oldest jobs when exceeded.                            |

**Automatically set by the compose file** (no need to override in Coolify):
- `PRISM_MODE=hosted` — hardened multi-tenant mode.
- `PRISM_PORT=80` — web binds to port 80 for Traefik routing.
- `PRISM_BEHIND_TLS=true` — cookies get `Secure` flag.
- `DB_DRIVER=postgres`, `STORAGE_DRIVER=s3`, `WORKER_QUEUE=pgboss` — required
  in hosted mode.
- `S3_ENDPOINT=http://minio:9000` — MinIO service reachable within the network.
- `S3_BUCKET=op-uploads` — bucket name (created by minio-init).
- `S3_REGION=us-east-1` — MinIO accepts any value; defaults to us-east-1.
- `RATE_LIMIT_STORE=postgres` — survive restarts.
- `WORKER_CONCURRENCY=3` — recommended for 8 GB box.

Web and worker must agree on `DATABASE_URL`, `S3_*` secrets, `WORKER_QUEUE`,
and `SESSION_SECRET`.

---

---

## Disabling auth (testing only)

**⚠️ Security warning:** The following configuration is for testing only and makes your
instance fully open to the public. Do not use in production.

If you want to test the app without setting up magic-link auth, set:

```
AUTH_ADAPTER=none
```

When `AUTH_ADAPTER=none`:
- The login form is skipped; users go straight to the upload UI.
- **No authentication is enforced**; anyone with the URL can use the instance.
- `ALLOWLIST_EMAIL_DOMAINS` and `ALLOWLIST_EMAILS` are ignored (not needed).
- `SMTP_HOST`, `SMTP_PORT`, etc. are ignored.
- All quotas apply to a single virtual user (`__no_user__`).

To re-enable auth:
1. Remove `AUTH_ADAPTER=none` from Coolify's Environment tab, OR set it to `magic-link`.
2. Add `ALLOWLIST_EMAIL_DOMAINS` and `SMTP_*` variables.
3. Redeploy.

---

## Coolify setup

### 1. Provision Postgres

Coolify → **Project → Add Resource → Database → PostgreSQL 16**.
- Give it any name (the UI just needs a label for you).
- Once provisioned, Coolify displays a connection string. Copy it exactly;
  this is your `DATABASE_URL` env var. It will look like:
  ```
  postgres://username:password@internal-hostname:5432/databasename
  ```

### 2. Add the application

Coolify → **Add Resource → Application → Public Repository** (or private with
deploy key).
- **Build pack:** Select `Docker Compose` from the dropdown.
- **Repository root:** Leave blank (defaults to repo root).
- **Health check path:** `/api/health`
- **Domains tab:** Add `Prism.skill-loop.com`; Coolify provisions
  Let's Encrypt TLS automatically.

### 3. Set environment variables

Application → **Environment tab.** Paste the variables from **Required
environment** above. The compose file at the repo root reads these and
injects them into all four services (web, worker, minio, minio-init).

At minimum:
```
PUBLIC_BASE_URL=https://Prism.skill-loop.com
SESSION_SECRET=<output of: openssl rand -hex 32>
DATABASE_URL=<from Postgres step 1>
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=<something random>
ALLOWLIST_EMAIL_DOMAINS=skill-loop.com
SMTP_HOST=<your SMTP provider>
SMTP_PORT=587
SMTP_USER=<SMTP user>
SMTP_PASS=<SMTP password>
SMTP_FROM=Prism <noreply@skill-loop.com>
```

### 4. Deploy

Trigger a deploy. Coolify reads `/docker-compose.yaml` at the repo root and
brings up the stack:
- `minio-init` creates the bucket and exits.
- `minio`, `web`, and `worker` start and report healthy.

Watch Application → Logs. You should see:
```
minio-init ... bucket op-uploads ready
web ... listening on 0.0.0.0:80
worker ... subscribed to pg-boss
```

### 5. Verify DNS + TLS

Once the deploy finishes:
- Add a CNAME at your DNS provider pointing `Prism` at the Coolify
  host (the IP or hostname Coolify shows in the UI).
- Wait 5–10 minutes for DNS propagation and Let's Encrypt issuance.
- `curl https://Prism.skill-loop.com/api/health` should return HTTP 200
  with `{"mode":"hosted","db":"ok","storage":"ok"}`.

### 6. Backups off-box

Coolify supports scheduled Postgres dumps natively:
- **Postgres resource → Backups → Schedule daily.** Configure an S3 bucket
  on a different host (Backblaze B2, Cloudflare R2, another VPS, etc.) as
  the destination.
- For MinIO, use a sidecar `mc mirror` cron or take a volume snapshot via
  your VPS provider. The roadmap recommends mirroring the bucket nightly to
  a remote S3 endpoint.

Test recovery at least once. A backup you've never restored isn't a
backup.

---

## Local hosted-mode dev (no Coolify)

For working on hosted-mode features without pushing to a VPS:

```bash
cd cloud
cp .env.example .env
# Edit .env: at minimum set SESSION_SECRET to a real random hex string
# and ALLOWLIST_EMAIL_DOMAINS to a domain you own.

docker compose -f docker-compose.yml up
```

The compose file at `cloud/docker-compose.yml` (note: lowercase `.yml`, for
local dev only — **not** the repo-root `docker-compose.yaml` which is for
Coolify production) brings up Postgres + MinIO, creates the bucket, then
starts web + worker. Visit `http://localhost:4280`, sign in via the captured
email at `cloud/.tmp/mail/`, upload a fixture, watch the worker process it.

---

## What to verify after a real deploy

A short post-deploy checklist. All steps assume the domain is propagated
and the TLS cert has issued (check Coolify's logs if unsure).

- `curl https://Prism.skill-loop.com/api/health` → HTTP 200 with
  `{ mode: 'hosted', db: 'ok', storage: 'ok' }`.
- `curl -i https://Prism.skill-loop.com` → response includes
  `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `Content-Security-Policy` headers.
- Visit the URL in a browser; you see a login form (no auth bypass).
- Sign in with an allowlisted email; the magic-link email arrives via
  your real SMTP (check the provider's log if not in inbox).
- Click the magic link in the email; redirected to `/`, logged in (email
  shown top right), cookies set.
- Upload a test `.zip` file; job appears `pending`, then `running`, then
  `done`. Coolify → Application → Logs shows both the web service
  accepting the upload and the worker service dequeuing + processing
  the pg-boss job (filter by service name in the log viewer).
- (Optional) To inspect the MinIO bucket directly, the console runs on
  port 9001 inside the Docker network but is **not** publicly exposed
  by the compose file. Either add a temporary `ports:` mapping for
  9001, or use Coolify's per-service "Open in browser" if available.
- Try signing in with a non-allowlisted email; `POST /api/auth/request`
  returns HTTP 403 (forbidden).

If `/api/health` returns 503, the response body tells you which subsystem
is unreachable. Common causes: `DATABASE_URL` typo, MinIO endpoint not
reachable from the web container's network, bucket missing.

---

## Operational notes

- **A failed audit doesn't take down the server.** The /src auto-fix
  listener leak shipped fixed in Phase 6; cancellation lands clean within
  ~1 second. Long-running orphaned audits aren't possible.
- **Restart-safe.** Phase 5's `markInterrupted()` flips orphaned in-flight
  jobs to `error` on boot. The user re-uploads.
- **Quota enforcement is per-user.** Override per-user limits by writing
  directly to the database — there's no admin UI yet (that's a Phase 11+
  item).

---

## Troubleshooting

The build / deploy phase has a small number of common traps; each
maps to a specific symptom.

| Symptom | Most likely cause | Fix |
| ------- | ----------------- | --- |
| Build fails on `COPY src ./src` | Compose build context wrong. | Coolify → app → General → ensure **Build pack** is set to `Docker Compose` (not Dockerfile). Repository root should be blank (uses repo root by default). Re-deploy. |
| Build fails on `npm ci` | Lockfile out of sync with package.json. | Run `npm install` locally, commit updated `package-lock.json` and `cloud/package-lock.json`, push. |
| Web container boots, healthcheck 503, body says `db: error` | `DATABASE_URL` typo, or Postgres still starting. | Wait 30 sec, retry. If persists, copy the connection string fresh from Coolify's Postgres resource page and paste it into the application's Environment. |
| Healthcheck 503, body says `storage: error` (with `Access Denied` or similar) | `S3_ACCESS_KEY` / `S3_SECRET_KEY` mismatch between env and MinIO. | Verify the values in Application → Environment match exactly. MinIO service and web/worker must have identical credentials. |
| Healthcheck 503, body says `storage: error` (with `getaddrinfo ENOTFOUND`) | `S3_ENDPOINT` unreachable. | The compose file bakes in `S3_ENDPOINT=http://minio:9000`. Do not override it. MinIO service is reachable within the Docker network as just `minio`. |
| Healthcheck 503 with no subsystem errors, or 500 response | Permission or network issue. | Check Coolify → Application → Logs for the full stack trace. Common: web can't reach Postgres or MinIO on their internal network. |
| Login page loads but form submission returns 400 | CSRF token missing or invalid. | Rare if using fresh browser cookies. Hard-refresh (Ctrl-Shift-R) or clear cookies and retry. If persists, check `SESSION_SECRET` is set and identical across web and worker. |
| Magic-link email never arrives | SMTP credentials wrong or email test mode enabled. | Verify SMTP creds: host, port, user, pass against your provider's docs. Check provider's SMTP logs. Don't set `MAIL_CAPTURE_DIR` in production (it's for local dev). |
| Magic-link email arrives but link goes to `localhost` | `PUBLIC_BASE_URL` not set. | Set to `https://Prism.skill-loop.com` in Application → Environment. Past sent emails are stale; have the user request a new link. |
| Logged in successfully, but every POST (upload, etc.) returns 403 | `PRISM_BEHIND_TLS` not properly set. | The compose file bakes in `PRISM_BEHIND_TLS=true`. If you see this, cookies may not be sent over HTTPS. Verify Coolify reverse proxy is serving HTTPS (not plain HTTP). |
| Upload returns 429 immediately | Rate limit or quota hit. | Check which: `QUOTA_CONCURRENT_JOBS` (too many uploads at once), `QUOTA_UPLOADS_PER_DAY` (daily limit), `QUOTA_STORED_BYTES` (per-user storage cap). Increase as needed in Environment. |
| Upload accepted, status stuck at `pending` forever | Worker not running or not connected to queue. | Coolify → Application → Logs. Check worker service is up and shows `subscribed to pg-boss`. Verify `DATABASE_URL` is set and correct. |
| Worker boots, then exits immediately | Env var mismatch or Postgres unreachable. | Check Coolify → Application → Logs for the worker service. `DATABASE_URL`, `S3_*`, `SESSION_SECRET` must be set. Worker can't boot if it can't reach Postgres. |
| Login form rejects every email with 403 | Email not in allowlist. | `ALLOWLIST_EMAIL_DOMAINS=skill-loop.com` allows `user@skill-loop.com`. For multiple domains: `skill-loop.com,example.com`. For specific addresses: `ALLOWLIST_EMAILS=alice@example.com,bob@example.com`. |
| Login form returns 500 | `SESSION_SECRET` missing or invalid. | Set `SESSION_SECRET=$(openssl rand -hex 32)` locally, paste output into Application → Environment. Must be 32+ hex characters. |
| TLS cert not issuing, domain not resolving | DNS not propagated, or Coolify's Let's Encrypt failing. | Wait 5–10 minutes for DNS propagation. Check Coolify's Caddy/Traefik logs. Verify CNAME is set at your DNS provider: `Prism CNAME coolify-host-ip-or-hostname`. |

For anything not in this table: `/api/health` is the first thing to
check. The body tells you which subsystem is unhappy. Then Coolify →
Application → Logs and filter by the failing service.

---

## Out of scope

Per ROADMAP §10:

- Multi-region.
- CDN.
- Paid monitoring.
- Status page.
- Custom uptime SLA.

When this grows enough to need any of those, lift them into Phase 11+.

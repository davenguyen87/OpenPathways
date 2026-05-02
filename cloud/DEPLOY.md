# Open Pathways Cloud — Deploy

End-to-end: how to put this on a real URL via Coolify on a self-hosted VPS.

The full plan lives in `ROADMAP.md` Phase 10. This document is the
operational runbook — what you need to install, configure, and verify.

---

## Coolify quickstart (10 minutes)

Push this repo to GitHub, then in Coolify do these steps in order. Every
field listed has a specific value — don't improvise.

**Prerequisites**
- Coolify installed on an 8 GB / 2–4 vCPU VPS.
- A domain pointed at the VPS (CNAME `op` → coolify-host).
- An SMTP provider (Postmark, SES, Mailgun, ...) with credentials ready,
  OR you accept that you'll only test the captured-email path first.

---

**1. Provision Postgres** — Coolify → **Project → Add Resource → Database
→ PostgreSQL 16**. Name it whatever; copy the connection string Coolify
shows. This is your `DATABASE_URL`.

**2. Provision MinIO** — Coolify → **Add Resource → Service → search
"MinIO"** (community template). Pick credentials (`minioadmin` / something
random); these become `S3_ACCESS_KEY` / `S3_SECRET_KEY`. Coolify exposes
MinIO at an internal hostname like `minio:9000`; that's `S3_ENDPOINT`.
**You do not need to pre-create the bucket** — the app does this on first
boot (Phase 10.8 fix).

**3. Add the web application** — Coolify → **Add Resource → Application →
Public Repository** (or private with deploy key). Then:
- **Build Pack:** `Dockerfile`
- **Dockerfile location:** `cloud/Dockerfile`
- **Build context:** `.` (the repo root — **NOT** `cloud/`. The Dockerfile
  copies `src/` and `cloud/` from repo root; setting context to `cloud/`
  breaks the build.)
- **Port:** `4280`
- **Health check path:** `/api/health`
- **Domain:** `op.yourdomain.com` (Coolify provisions Let's Encrypt).

**4. Set the web app's environment variables** in Coolify's UI:

```
OPEN_PATHWAYS_MODE=hosted
OPEN_PATHWAYS_BEHIND_TLS=true                       # ← REQUIRED in production
PUBLIC_BASE_URL=https://op.yourdomain.com           # ← used in magic-link emails
SESSION_SECRET=<output of: openssl rand -hex 32>
DB_DRIVER=postgres
DATABASE_URL=<from step 1>
STORAGE_DRIVER=s3
S3_ENDPOINT=<from step 2, e.g. http://minio:9000>
S3_BUCKET=op-uploads
S3_ACCESS_KEY=<from step 2>
S3_SECRET_KEY=<from step 2>
S3_REGION=us-east-1
WORKER_QUEUE=pgboss
RATE_LIMIT_STORE=postgres
ALLOWLIST_EMAIL_DOMAINS=yourdomain.com              # ← at least one allowlist required
SMTP_HOST=smtp.postmarkapp.com                      # ← your real SMTP
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=Open Pathways <noreply@yourdomain.com>
OPEN_PATHWAYS_RETENTION_DAYS=30
QUOTA_CONCURRENT_JOBS=2
QUOTA_UPLOADS_PER_DAY=50
QUOTA_STORED_BYTES=5368709120
```

**5. Add the worker application** — Coolify → **Add Resource →
Application** again. Same repo, same Dockerfile, same build context.
Then:
- **Start command override:** `node cloud/worker/index.js`
- **No exposed port** (worker doesn't serve HTTP).
- **Resource limits:** 2 vCPU / 4 GiB (so the worker can't starve
  Postgres or the web container on an 8 GB box).
- **Environment:** copy the same vars from step 4. Add:
  ```
  WORKER_CONCURRENCY=3
  ```

**6. Deploy both applications.** Web first (so the bucket gets created
before the worker tries to fetch). Watch the build logs; the worker
container logs should show `worker subscribed to pg-boss` once Postgres
is reachable.

**7. Verify** in this order:
- `curl https://op.yourdomain.com/api/health` → `{"mode":"hosted","db":"ok","storage":"ok"}` (HTTP 200).
- `curl -I https://op.yourdomain.com` → response includes
  `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `Content-Security-Policy`.
- Visit `https://op.yourdomain.com` in a browser; you see the login form.
- Enter an allowlisted email → "Check your email"; the email actually
  arrives (or hits your inbox catcher).
- Click the link → redirected to `/`, logged in (your email shown top right).
- Drop a `.zip`; the audit completes; the report is downloadable.
- In Coolify's worker logs, you see the job being consumed.

If any of these fail, jump to **Troubleshooting** below.

---

## TL;DR (mental model)

The above quickstart is the literal recipe. The mental model:

- **Postgres** holds users, sessions, jobs, audit logs, the pg-boss queue.
- **MinIO** holds the uploaded `.zip` files plus extracted artifacts.
- **Web container** terminates HTTPS (via Coolify's reverse proxy),
  authenticates users, accepts uploads, enqueues to pg-boss.
- **Worker container** dequeues from pg-boss, runs `audit()` against
  Chromium (pre-installed in the Playwright base image), writes results
  back to Postgres.
- **Same image, different command.** Coolify treats them as two apps.

---

## Required environment

Every variable across the codebase, with defaults and where each is
required. Set these in Coolify's environment-variable UI (web + worker
share most; both columns marked when so).

| Var                            | Required where                | Default                | Notes                                                                                       |
| ------------------------------ | ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `OPEN_PATHWAYS_MODE`           | web + worker                  | `local`                | Must be `hosted` in production.                                                             |
| `OPEN_PATHWAYS_PORT`           | web                           | `4280`                 | Coolify routes to this port.                                                                |
| `OPEN_PATHWAYS_BEHIND_TLS`     | web                           | `false`                | Set to `true` so cookies get `Secure`.                                                      |
| `PUBLIC_BASE_URL`              | web                           | empty                  | e.g. `https://op.yourdomain.com`. Used in magic-link emails.                                |
| `SESSION_SECRET`               | web (hosted)                  | —                      | Hex, 32+ chars. Generate with `openssl rand -hex 32`.                                       |
| `DB_DRIVER`                    | web + worker                  | `sqlite`               | `postgres` in production.                                                                   |
| `DATABASE_URL`                 | web + worker                  | —                      | `postgres://user:pass@host:5432/db`. Coolify auto-injects for managed Postgres.             |
| `STORAGE_DRIVER`               | web + worker                  | `local-fs`             | `s3` in production.                                                                         |
| `S3_ENDPOINT`                  | web + worker (s3)             | —                      | e.g. `http://minio:9000` (Coolify-internal).                                                |
| `S3_BUCKET`                    | web + worker (s3)             | —                      | Pre-create on first deploy.                                                                 |
| `S3_ACCESS_KEY`                | web + worker (s3)             | —                      |                                                                                              |
| `S3_SECRET_KEY`                | web + worker (s3)             | —                      |                                                                                              |
| `S3_REGION`                    | web + worker (s3)             | `us-east-1`            | MinIO accepts any value.                                                                    |
| `WORKER_QUEUE`                 | web + worker                  | `inprocess`            | `pgboss` in production. Worker container only consumes when this is set.                    |
| `WORKER_CONCURRENCY`           | worker                        | `1`                    | Roadmap recommends `3` on an 8 GB box.                                                      |
| `RATE_LIMIT_STORE`             | web                           | memory                 | `postgres` in production so limits survive restarts.                                        |
| `ALLOWLIST_EMAIL_DOMAINS`      | web (hosted)                  | —                      | Comma-separated. At least one of `*_DOMAINS` / `*_EMAILS` is required.                      |
| `ALLOWLIST_EMAILS`             | web (hosted)                  | —                      | Comma-separated.                                                                            |
| `SMTP_HOST`                    | web (hosted, no capture)      | —                      | Required unless `MAIL_CAPTURE_DIR` is set. Postmark / SES / Mailgun / etc.                  |
| `SMTP_PORT`                    | web                           | `587`                  |                                                                                              |
| `SMTP_USER`                    | web                           | —                      |                                                                                              |
| `SMTP_PASS`                    | web                           | —                      |                                                                                              |
| `SMTP_SECURE`                  | web                           | `false`                | `true` for TLS-on-connect (port 465).                                                       |
| `SMTP_FROM`                    | web                           | `Open Pathways <noreply@example.com>` | Set to a domain you control.                                                          |
| `MAIL_CAPTURE_DIR`             | web (test/dev)                | —                      | Captures emails to disk instead of sending. Don't set in production.                        |
| `OPEN_PATHWAYS_RETENTION_DAYS` | web                           | `0` (forever)          | `30` in production.                                                                         |
| `QUOTA_CONCURRENT_JOBS`        | web                           | `2`                    | Per-user.                                                                                   |
| `QUOTA_UPLOADS_PER_DAY`        | web                           | `50`                   | Per-user.                                                                                   |
| `QUOTA_STORED_BYTES`           | web                           | `5368709120` (5 GiB)   | Per-user.                                                                                   |
| `QUOTA_STORED_BYTES_TOTAL`     | web                           | `0` (disabled)         | Bucket-wide eviction trigger; set to your bucket cap to enable.                             |

The web and worker containers must agree on `DATABASE_URL`,
`STORAGE_DRIVER`/S3 secrets, `WORKER_QUEUE`, and `SESSION_SECRET`. Differ
on `WORKER_CONCURRENCY` (worker only) and `OPEN_PATHWAYS_PORT` (web only).

---

## Coolify setup

### 1. Provision

In your Coolify dashboard:

- **Services → Database → PostgreSQL.** Take the connection string Coolify
  generates; this becomes your `DATABASE_URL`.
- **Services → New service → MinIO** (community template). Set root user /
  password; these become `S3_ACCESS_KEY` / `S3_SECRET_KEY`. Note the
  internal hostname (something like `minio:9000`); this is `S3_ENDPOINT`.
- **MinIO console → Buckets → Create.** Make a bucket named `op-uploads`
  (or whatever you set as `S3_BUCKET`). The application will not auto-
  create it.

### 2. Web application

- **Applications → New → from Git repository.** Point at your fork.
- **Build pack:** Dockerfile. **Dockerfile location:** `cloud/Dockerfile`.
- **Build context:** repo root (`.`).
- **Port:** 4280.
- **Health check path:** `/api/health`.
- **Environment:** copy from the table above.

### 3. Worker application

- **Applications → New → from Git repository.** Same repo as the web.
- **Same Dockerfile**, same build context, same secrets — so the image is
  identical.
- **Custom start command:** `node cloud/worker/index.js`.
- **No exposed port** — the worker doesn't serve HTTP.
- **CPU + memory limits:** 2 vCPU / 4 GiB. Lower than the box's total so
  the worker can't starve Postgres or the web container.

### 4. Domain + TLS

- In the web application's **Domains** tab, add `op.yourdomain.com`.
- Coolify provisions a Let's Encrypt cert automatically.
- Add a CNAME from your DNS provider pointing `op` at the Coolify host.
- Wait for the cert to issue; verify `https://op.yourdomain.com/api/health`
  returns 200.

### 5. Backups off-box

Coolify supports scheduled Postgres dumps natively:

- **Postgres service → Backups → Schedule daily.** Configure an S3 bucket
  on a different host as the destination. (Backblaze B2, Cloudflare R2,
  another VPS via rsync, all work.)
- For MinIO, use a sidecar `mc mirror` cron or take a volume snapshot
  via your VPS provider. The roadmap recommends mirroring the bucket
  nightly to a remote S3 endpoint.

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

docker compose up
```

The first boot brings up Postgres + MinIO, creates the bucket, then starts
the web + worker containers. Visit http://localhost:4280, sign in via the
captured email at `cloud/.tmp/mail/`, upload a fixture, watch the worker
process it.

---

## What to verify after a real deploy

A short post-deploy checklist:

- `curl https://op.yourdomain.com/api/health` → 200 with `{ db: 'ok',
  storage: 'ok', mode: 'hosted' }`.
- `curl -i https://op.yourdomain.com` → response includes
  `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `Content-Security-Policy`.
- Sign in with an allowlisted email; the magic-link email arrives via
  your real SMTP.
- Upload a `.zip`; the job appears `pending`, then `running`, then `done`.
  The worker logs (Coolify → worker app → logs) show it consumed the
  pg-boss job.
- The MinIO console shows the upload object.
- A non-allowlisted email's `POST /api/auth/request` returns 403.

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
| Build fails on `COPY src ./src` | Build context set to `cloud/` not repo root | Coolify → app → Configuration → Build → set Build Context to `.` |
| Build fails on `npm ci` | Lockfile out of sync with package.json | `npm install` locally, commit the updated `package-lock.json` and `cloud/package-lock.json` |
| Web container boots, healthcheck 503, body says `db: error` | `DATABASE_URL` typo, or Coolify Postgres still booting | Wait 30 seconds, retry. If still 503, copy the connection string fresh from Coolify's Postgres resource page |
| Healthcheck 503, body says `storage: error` (with `Access Denied` or similar) | `S3_ACCESS_KEY` / `S3_SECRET_KEY` mismatch | Re-copy from the MinIO service's environment |
| Healthcheck 503, body says `storage: error` (with `getaddrinfo ENOTFOUND minio`) | `S3_ENDPOINT` uses an unreachable hostname | Use Coolify's internal hostname (visible in the MinIO service config), not the public URL |
| Magic-link email never arrives | `MAIL_CAPTURE_DIR` left set, OR SMTP credentials wrong | Unset `MAIL_CAPTURE_DIR` for production. Check SMTP creds against your provider's docs |
| Magic-link email arrives but link goes to `localhost` | `PUBLIC_BASE_URL` not set | Set it to `https://op.yourdomain.com`. Past emails will need to be re-sent |
| Click magic link, page loads `/api/auth/verify/...` and stays there | Old version of the verify route (pre-Phase-10.9 fix) | Pull latest, redeploy. The fixed version 302s to `/` |
| Logged in successfully, but every POST returns 403 | `OPEN_PATHWAYS_BEHIND_TLS=true` not set, but app IS behind TLS — Secure cookie set, browser won't send it back over `https` (old Chrome quirk) OR `OPEN_PATHWAYS_BEHIND_TLS=true` set but app is on plain HTTP | Set `OPEN_PATHWAYS_BEHIND_TLS=true` in production (always). Local docker-compose without TLS sets it to `false` |
| Upload returns 429 immediately | One of the quotas is too tight | Bump `QUOTA_CONCURRENT_JOBS` / `QUOTA_UPLOADS_PER_DAY` / `QUOTA_STORED_BYTES` |
| Upload accepted, status stuck at `pending` forever | Worker container not running, or `WORKER_QUEUE=pgboss` not set on web | Check the worker app's logs. Confirm `WORKER_QUEUE=pgboss` is set on **both** apps |
| Worker boots, then exits with `WORKER_QUEUE=pgboss` mismatch | Env var not set on worker app, only on web | Copy env vars across. Coolify lets you import from one app's config to another |
| Login form rejects every email with 403 | `ALLOWLIST_EMAIL_DOMAINS` doesn't match the email | Set it to a comma-separated list of domains you control |
| Login form returns 500 | `SESSION_SECRET` empty or shorter than 32 chars | Set `SESSION_SECRET=$(openssl rand -hex 32)` |

For anything not in this table: `/api/health` is the first thing to
check. The body tells you which subsystem is unhappy. Then the Coolify
logs for the specific app.

---

## Out of scope

Per ROADMAP §10:

- Multi-region.
- CDN.
- Paid monitoring.
- Status page.
- Custom uptime SLA.

When this grows enough to need any of those, lift them into Phase 11+.

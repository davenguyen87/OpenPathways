# CLAUDE.md

## Project: Open Pathways — Cloud

The hosted, multi-tenant version of Open Pathways. Same audit core as the
local CLI and the local web tool, but with persistent storage, magic-link
auth, a worker queue, S3-compatible object storage, and a deploy target
of Coolify on a self-hosted VPS.

This directory is **separate from `/web`** by design. `/web` is the v1
local-only single-user dev tool, frozen as a working reference. `/cloud`
is the productionised version that everything new lands in.

Full multi-phase build plan: `ROADMAP.md`

---

## Relationship to the rest of the repo

```
OpenPathways/
├── src/             ← shared audit core. /web and /cloud both import from here.
│                       Modify only with explicit reason; document each touch.
├── web/             ← v1 local-only tool. Frozen-ish. Do NOT modify from /cloud work.
├── cloud/           ← THIS DIR. Hosted, multi-tenant, public-internet target.
└── test/            ← shared fixtures and integration tests for /src.
```

`/cloud` was forked as a copy from `/web` at Phase 5 start. The two are
expected to diverge; **do not** invent a shared module abstraction
prematurely. If a piece of code becomes obviously identical in both for
months, that's the time to extract — not before.

---

## Folder structure

```
cloud/
├── server/
│   ├── index.js          ← entry; mode-aware (local | hosted)
│   ├── job-manager.js    ← DB-backed, not in-memory
│   ├── routes/           ← upload, SSE, reports, sample, auth
│   ├── store/            ← Postgres + SQLite adapters, migrations
│   ├── storage/          ← local-fs + s3-compatible adapters (Phase 9)
│   ├── auth/             ← none + magic-link adapters (Phase 9)
│   └── lib/              ← small helpers
├── worker/               ← separate process for Playwright runs (Phase 9)
├── public/               ← forked from web/public; evolves independently
├── test/
├── migrations/           ← numbered SQL files (or under server/store/migrations)
├── Dockerfile            ← Phase 10
├── docker-compose.yml    ← Phase 10 (local hosted-mode dev)
├── package.json
├── README.md
├── ROADMAP.md            ← canonical multi-phase spec
└── CLAUDE.md             ← this file
```

---

## Locked-in decisions (do not relitigate without flagging)

**Hosting & runtime.**
- Target host: **Coolify on a self-hosted VPS** (8 GB / 2–4 vCPU baseline).
- Public-internet exposed; therefore auth is **mandatory** in hosted mode.
- Reverse proxy + TLS handled by Coolify (Caddy/Traefik + Let's Encrypt).

**Storage & data.**
- Database: **Postgres** in hosted mode (managed by Coolify), **SQLite** locally.
  Same store interface, two adapters.
- Object storage: **MinIO** (Apache 2.0) deployed alongside in Coolify.
  S3-compatible — same client code talks to MinIO, Garage, R2, AWS, etc.
- Job queue: **pg-boss** (MIT) on Postgres. No Redis dependency.

**Auth.**
- In-app **magic-link via SMTP** (`nodemailer`, MIT), JWT-or-signed-cookie sessions.
- Email allowlist (`ALLOWLIST_EMAIL_DOMAINS` or `ALLOWLIST_EMAILS`) **required**
  in hosted mode — refuses to start without it.
- `AUTH_ADAPTER=none` only valid when `OPEN_PATHWAYS_MODE=local`.
- **Temporary deviation (testing window):** `AUTH_ADAPTER=none` is currently allowed
  in hosted mode for the testing phase. This is gated by an explicit env var and
  reversible by removing it or setting to `magic-link`. Re-evaluate before opening
  to additional users.

**Hardening (hosted mode).**
- `helmet` for security headers (HSTS, CSP, X-Frame-Options DENY).
- `express-rate-limit` on auth + upload endpoints, Postgres-backed so it
  survives restarts.
- `httpOnly` + `Secure` + `SameSite=Lax` cookies.
- CSRF tokens on every state-changing route.
- Auth audit log table.

**Quotas.**
- Per-user: max 2 concurrent jobs, 50 uploads/day, 5 GB stored bytes
  (defaults; configurable per user later).
- Worker: `WORKER_CONCURRENCY=3` Playwright runs (8 GB box headroom).
- Disk eviction: when total bucket > 80% of cap, oldest jobs evicted early.

**Observability.**
- Structured logs via `pino` (MIT) → stdout → Coolify logs.
- `/api/health` returns 200 only when DB + S3 are both reachable.
- No paid APM in v1.

**Privacy.**
- Default retention: `OPEN_PATHWAYS_RETENTION_DAYS=30`.
- `/privacy` page populated at deploy time.
- No analytics on package contents.
- Encryption-at-rest left to the storage layer (MinIO server-side encryption
  + Postgres disk encryption via the VPS).

---

## Tech stack (all OSS)

| Layer                | Choice                       | License            |
| -------------------- | ---------------------------- | ------------------ |
| HTTP                 | Express                      | MIT                |
| Uploads              | multer                       | MIT                |
| DB (local)           | better-sqlite3               | MIT                |
| DB (hosted)          | Postgres + `pg`              | PostgreSQL / MIT   |
| Object storage       | MinIO (or Garage)            | Apache 2.0 / AGPL  |
| S3 SDK               | `@aws-sdk/client-s3`         | Apache 2.0         |
| Job queue            | pg-boss                      | MIT                |
| Auth (in-app)        | `nodemailer` + custom        | MIT                |
| Logs                 | pino                         | MIT                |
| Rate limit           | express-rate-limit + pg store| MIT                |
| Security headers     | helmet                       | MIT                |
| Browser engine       | Chromium via Playwright      | BSD-3 / Apache 2.0 |
| Reverse proxy / TLS  | Caddy or Traefik (Coolify)   | Apache 2.0         |
| Hosting              | Coolify                      | Apache 2.0         |

---

## Distribution

- **Local dev (cloud-mode):** `docker compose -f cloud/docker-compose.yml up -d`
  brings up Postgres + MinIO + mail-capture, then `node cloud/server/index.js`
  (or `npm run cloud` from project root) runs the app pointing at them.
- **Local dev (hosted-mode-lite):** `OPEN_PATHWAYS_MODE=hosted` with env vars
  pointing at any Postgres + S3 — exercises the full hardened path.
- **Production:** Docker image (`cloud/Dockerfile`) deployed via Coolify with
  the root `docker-compose.yaml`. Coolify provisions Postgres; MinIO ships
  in the compose stack. See `DEPLOY.md`.
- **Worker:** runs from the same image with `node cloud/worker/index.js`.
- **Not** published to npm. Not a CLI. Not standalone.

---

## Coding guidelines

Same spirit as `/web/CLAUDE.md`:

- Think before coding. State assumptions. Surface tradeoffs. Ask if unclear.
- Minimum code that solves the problem — no speculative features or abstractions.
- Touch only what the task requires. Match existing style.
- Define success criteria before implementing. Verify after.
- **Do not modify `/web`** from cloud work. They are separate apps.
- **Modify `/src` only with explicit reason**, and document the touch in the
  commit and in this file's "touches on /src" log below. Each touch should
  be small, isolated, and not break the local CLI or `/web`.
- Prefer adapters and env-flag-driven behavior over forks of the same
  function. Two adapters with the same interface > two `if (mode === 'local')`
  branches inside the same function.
- Frontend stays vanilla JS / no bundler **for now**. If a Phase 7+ feature
  genuinely needs a build step (e.g. a syntax-highlighter for the snippet
  field), raise it as a discussion before adding tooling.
- Delegate to subagents (Opus/Sonnet/Haiku) for parallelisable work.
- Each phase: implement, then verify against its success criteria, then
  check in with the user before moving to the next.

### Touches on `/src` from cloud work

Log every modification here so the next person can see the boundary
clearly. Each entry: phase, file, one-line reason.

- Phase 6, `src/index.js` — added `options.signal` (AbortSignal) for real cancellation; replaced the per-call `process.on('exit')` listener with a single module-level handler + `Set<tempRoot>` so 200 sequential audits no longer leak listeners.
- Phase 6, `src/lib/run-dynamic-checks.js` — accepts `options.signal`; closes the Playwright browser eagerly on abort and throws `AbortError` at inter-page / inter-check boundaries so cancel-to-stop is ~1 second mid-Playwright.

---

## Status

- Phases 5–10 shipped: persistence, real cancellation (`AbortSignal`), baseline diff + auto-fix in the UI, batch upload, hosted hardening (helmet + rate limit + magic-link + quotas + retention), Docker image, Coolify deploy.
- Phase 11 (later items: Stripe billing, admin UI, trends dashboard) preserved in `ROADMAP.md` as historical context, not currently active.
- `/web` Phases 1–4 complete; serves as reference implementation.

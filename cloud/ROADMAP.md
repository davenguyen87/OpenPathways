# Prism Cloud — Roadmap

The hosted, multi-tenant successor to `/web`. Same audit core, but persistent
storage, real auth, a worker queue, S3-compatible object storage, and a
deploy target of Coolify on a self-hosted VPS.

This document is the canonical spec for `/cloud`. Phases are sized in
working days for a single implementer. They are sequenced so that nothing
breaks `/web` (the local v1 tool, frozen as a working reference) and nothing
breaks the local CLI.

---

## Goal

`git push` to the project's repo deploys via Coolify to a public URL.
Authenticated users drop a SCORM/AICC `.zip`, watch a live progress log,
read a collapsible WCAG 2.2 AA report, and come back tomorrow to find their
history still there. Auto-fix produces a downloadable corrected package.
Baseline diff suppresses violations they've already triaged.

The local CLI (`/src/cli.js`) and the local web tool (`/web`) keep working
unchanged.

---

## Defaults baked in

- **Hosting target:** Coolify on a self-hosted VPS, **8 GB RAM**, 2–4 vCPU.
- **Public-internet exposed.** Auth is mandatory in hosted mode.
- **DB:** Postgres in hosted mode (Coolify-managed); SQLite locally.
- **Object storage:** MinIO (Apache 2.0) deployed alongside in Coolify.
  S3-compatible: same code talks to MinIO, Garage, R2, AWS.
- **Auth:** in-app magic-link via SMTP (`nodemailer`). Email allowlist
  required at boot.
- **Job queue:** pg-boss on Postgres. No Redis dependency.
- **Worker concurrency:** 3 Playwright runs (8 GB headroom).
- **Retention:** 30 days default (`PRISM_RETENTION_DAYS`).
- **Logs:** structured via `pino` → stdout → Coolify logs.

Everything in the dependency graph is OSS (Apache 2.0, MIT, BSD, AGPL for
optional Garage). See `CLAUDE.md` for the full table.

---

## Architecture

```
Public internet
   │  HTTPS  (Coolify-managed Caddy/Traefik + Let's Encrypt)
   ▼
cloud/server (Express, mode-aware)
   ├── auth (magic-link via SMTP)
   ├── routes (upload, SSE, reports, sample, fix, baseline)
   ├── job-manager → pg-boss queue
   └── store (Postgres adapter)
                ▲
                │ queue
                ▼
cloud/worker (separate process, runs audit() with Playwright)
                │
                ▼
storage (S3-compatible: MinIO in Coolify, but adapter is interchangeable)
```

Same Docker image runs as `web` and `worker` containers; entry command
distinguishes them.

---

## Phase 5 — Persistence (~1 day)

**Goal:** A job survives a server restart. `/job/:id` works tomorrow. The
"Recent audits" panel becomes a real history.

**Success criteria:**
- Restart the server mid-session; reload `/job/:id` of a previously
  completed audit; the report still renders.
- Recent panel shows entries from prior sessions.
- Re-downloading `report.json` and `report.md` works for any historic job.
- `/web` and `/src/cli.js` are untouched and still pass their tests.

**Tasks:**

1. Fork-copy `/web/server`, `/web/public`, `/web/test` into `/cloud/`.
   Drop the parts that don't apply (the `lib/launch.js` browser-opener stays
   for local dev only; the in-memory job manager gets replaced).
2. `/cloud/server/store/` — store interface with two adapters:
   - `sqlite.js` (default for local dev, `better-sqlite3`).
   - `postgres.js` (default for hosted mode, `pg`).
3. Schema (numbered SQL migrations under `/cloud/server/store/migrations/`):
   ```sql
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     options JSONB NOT NULL,
     original_name TEXT,
     upload_path TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     error TEXT,
     result_json JSONB,
     progress_json JSONB NOT NULL DEFAULT '[]'
   );
   CREATE INDEX jobs_created_at_desc ON jobs (created_at DESC);
   ```
4. Refactor `/cloud/server/job-manager.js` to read/write through the store.
   Keep the in-memory `Map` as a write-through cache for hot jobs;
   on cold start hydrate only non-terminal jobs (terminal jobs lazy-load).
5. SSE replay: when a subscriber attaches, replay buffered events from
   `progress_json` then forward live events from the in-memory cache.
6. Replace the 10-minute cleanup timer with a configurable retention
   policy: `PRISM_RETENTION_DAYS` env var (default `0` in local
   mode = forever; default `30` in hosted mode).
7. Update `_snapshot()` to handle hydrated jobs that may not have an
   in-memory progress array.
8. Smoke test: restart-mid-session test that uploads, kills the process
   between SSE events, restarts, and confirms reload-safety.

**Out of scope:** sharing across machines, search across history,
deletion UI, multi-user (no `user_id` column yet — Phase 9 adds it).

**Open question to resolve at start:** retention default for local-mode
cloud dev. "Forever" is friendly until the SQLite file gets large.
Pragmatic answer: 0 means forever, document the migration to a real value
when the file gets uncomfortable.

---

## Phase 6 — Audit core hardening (~½ day)

**Goal:** Cancel actually cancels. The audit core stops leaking listeners.

**Success criteria:**
- Clicking "Cancel" mid-audit stops Playwright within ~1 second.
- 200 sequential audits in one process produce no
  `MaxListenersExceededWarning`.
- CLI behavior unchanged (verified by re-running the existing vitest suite).

**Tasks:**

1. Add `options.signal` (`AbortSignal`) to `audit()` in `src/index.js`.
   Check `signal.aborted` between static checks; pass to `runDynamicChecks`.
   The dynamic runner aborts page navigation and closes the browser
   early when the signal fires. Document the contract inline.
2. Fix the `process.on('exit')` listener leak in `audit()` — register
   the cleanup handler **once** at module load, track temp dirs in a
   module-level set.
3. Wire `AbortController` per job in `cloud/server/job-manager.js`.
   `cancel()` aborts the controller; the runner catches the abort cleanly
   and marks the job `cancelled`.
4. Replace the option-(b) cancel docs in `/web/README.md` with a note that
   cancel is now real (the fix back-applies to `/web` too because
   it's in `/src`).

**Out of scope:** cancellation of queued (not-yet-running) jobs — that
already works via queue removal.

**Touch on `/src`:** yes. This is a deliberate, documented exception.
Log it in `/cloud/CLAUDE.md` "touches on /src" section.

---

## Phase 7 — Workflow features that earn their keep (~2–3 days)

### 7a. Auto-fix in the browser (~1 day)

**Success criteria:** From the done view, the user previews mechanical
fixes, downloads `<package>.scorm-fixed.zip`. Re-running the audit on the
fixed package shows fewer violations.

**Tasks:**

1. `POST /api/audits/:id/fix?dry-run=true` returns proposed changes.
   Reuses `src/lib/auto-fix.js`.
2. `POST /api/audits/:id/fix` applies them and creates a new job for the
   fixed package, returning the new `jobId`. Result: a re-audited package
   with its own URL.
3. Frontend: "Preview fixes" button on done view; modal showing per-file
   diffs; "Apply & re-audit" creates the follow-up job and navigates to it.

**Open question:** all-or-nothing vs per-fix accept/reject. MVP: all-or-nothing.
Per-fix is a stretch.

### 7b. Baseline diff (~1 day)

**Success criteria:** Pick a prior audit as a baseline; the current view
shows only violations not present in the baseline. Score recomputes
against the filtered set. Diffed view is a shareable URL.

**Tasks:**

1. Frontend: "Compare against…" dropdown above the violations list,
   populated from the user's history.
2. `GET /api/audits/:id?baseline=:baselineId` returns a filtered scorecard.
   Reuses `src/lib/baseline.js` server-side.
3. URL state: `/job/:id?baseline=:baselineId`.
4. Visual treatment: faded criteria that exist in baseline; "new since
   baseline" badge on remaining violations.

### 7c. Per-violation page screenshots (~½ day, stretch)

**Success criteria:** Dynamic-check violations include a screenshot of
the rendered SCO with the offending element outlined.

**Tasks:**

1. In `runDynamicChecks`, after the AX snapshot, screenshot the page
   and outline the violating element by selector or AX bounding box.
   Save PNG keyed by `jobId+violationIndex`.
2. `GET /api/audits/:id/screenshots/:n.png`.
3. Frontend: lazy-loaded image inside the violation card.

Stretch because it touches `src/lib/run-dynamic-checks.js` non-trivially.
If deferred, lift to Phase 11.

---

## Phase 8 — Batch & power-user UX (~1–2 days)

**Goal:** Auditing 30 SCOs before a release is one drag-drop, not 30.

**Success criteria:**
- Drop multiple `.zip` files at once or pick a folder; see a live-updating
  summary table (name · status · score · violations · drill-in link).
- URL-encoded filters (`/job/:id?severity=critical&q=alt`) survive reload
  and are shareable.
- Common keyboard shortcuts work: `/`, `j`/`k`, `1`–`4`, `Esc`, `?`.
- CSV export of batch results.

**Tasks:**

1. `POST /api/audits/batch` creates N jobs in one request, returns a
   `batchId`.
2. New view at `/batch/:batchId` with multiplexed SSE.
3. Frontend file input gets `multiple`; drag-drop accepts > 1 file.
4. URL-state for filters; init from URL on bootstrap, write back via
   `replaceState` on change.
5. Keyboard shortcut module + `?` help overlay.
6. CSV export endpoint reusing the JSON scorecards.

**Out of scope:** per-file batch options (everything in a batch uses the
same standard / packageType).

---

## Phase 9 — Multi-tenant foundations + hardening (~3–4 days)

**Goal:** Same code can run as `npm run dev` on your laptop *or* as a
multi-user public server. No fork. Public-internet-grade hardening
included.

**Success criteria:**
- `PRISM_MODE=hosted` enables auth, per-user job isolation,
  S3 storage, Postgres, and security headers. Refuses to start without
  the required env vars.
- `PRISM_MODE=local` (default) preserves the simple single-user
  behavior for development.
- A magic-link signup → email → click → session lifecycle works
  end-to-end against a local SMTP test server (e.g. MailHog).
- Rate-limited endpoints reject excess requests and the limit survives
  a server restart (Postgres-backed).

**Tasks:**

1. **Auth abstraction** under `cloud/server/auth/` with adapters
   `none.js` (local-only) and `magic-link.js` (`nodemailer`-based).
   Sessions in DB. Signed cookies (`httpOnly`, `Secure`, `SameSite=Lax`).
2. **Per-user ownership.** Migrate `jobs` table: `ALTER TABLE jobs ADD
   COLUMN user_id TEXT REFERENCES users(id)`. Snapshot/list/SSE/report
   endpoints filter by current user. `user_id IS NULL` rows are pre-auth
   "local" rows from earlier phases.
3. **Storage abstraction** under `cloud/server/storage/` with
   `local-fs.js` and `s3.js` adapters. Job manager calls
   `storage.put(stream)` / `storage.get(key)` rather than reading from
   `web/.tmp/`. S3 adapter uses `@aws-sdk/client-s3` and works against
   any S3-compatible endpoint via `S3_ENDPOINT`.
4. **DB abstraction** matures: same store interface from Phase 5,
   ANSI SQL where possible, small dialect shim for SQLite vs Postgres.
5. **Worker queue.** `cloud/worker/index.js` is a separate process that
   reads from pg-boss queue. Web container enqueues; worker dequeues
   and runs `audit()`. Same image, different command.
6. **Quotas.** Per-user limits enforced before upload starts:
   max concurrent jobs, max uploads/day, max stored bytes.
7. **Hardening.** `helmet` headers, `express-rate-limit` (Postgres
   store), CSRF tokens, login throttle, auth audit log table.
8. **Allowlist enforcement** via `ALLOWLIST_EMAIL_DOMAINS` (comma-sep)
   or `ALLOWLIST_EMAILS` (comma-sep). Refuse to start if neither set
   in hosted mode.
9. **Disk eviction** policy when the bucket exceeds 80% of cap.

**Env contract** (vendor-neutral):

```
PRISM_MODE=hosted

DATABASE_URL=postgres://...
S3_ENDPOINT=https://minio.example.com
S3_BUCKET=op-uploads
S3_ACCESS_KEY=...
S3_SECRET_KEY=...

SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Prism <noreply@example.com>"

SESSION_SECRET=<32+ random bytes hex>
ALLOWLIST_EMAIL_DOMAINS=mycompany.com

WORKER_CONCURRENCY=3
PRISM_RETENTION_DAYS=30
QUOTA_CONCURRENT_JOBS=2
QUOTA_UPLOADS_PER_DAY=50
QUOTA_STORED_BYTES=5368709120
```

**Out of scope:** SSO/OAuth, teams/orgs, billing, admin UI.

---

## Phase 10 — Deploy on Coolify (~1–2 days)

**Goal:** A pushed commit appears at your real URL. Boring to operate.
Fully OSS. All on your VPS.

**Success criteria:**
- `git push` triggers a Coolify deploy.
- HTTPS works automatically (Coolify + Let's Encrypt).
- Magic-link auth works against your real SMTP.
- Uploads land in MinIO; reports are downloadable.
- A failed audit doesn't take down the server.
- Postgres dumps run nightly and land off-box.

**Tasks:**

1. **Dockerfile.** Multi-stage, final stage on
   `mcr.microsoft.com/playwright:v1.x-jammy` so Chromium and deps come
   pre-installed. `COPY` only what's needed; `npm ci --omit=dev`.
   Expose 4280; healthcheck on `/api/health`.
2. **`docker-compose.yml`** for local hosted-mode dev: `web`, `worker`,
   `postgres`, `minio` services. Same env contract as production.
3. **Coolify project setup:**
   - New application: point at the repo; build from Dockerfile.
   - Add managed **Postgres** service.
   - Add **MinIO** as a community/generic Docker service.
   - Add a second application (the worker) using the same image, command
     `node cloud/worker/index.js`. Same env vars, same DB.
   - Set CPU/memory limits on the worker so it can't starve Postgres.
   - Configure secrets in Coolify env-var UI (none in git).
4. **Backups off-box.** Coolify scheduled Postgres dumps + MinIO volume
   snapshot, target a remote S3 bucket or a second VPS via rsync.
5. **Retention worker.** pg-boss-scheduled hourly job: deletes expired
   uploads from S3 and rows from Postgres.
6. **Health & readiness.** `/api/health` returns 200 only when DB + S3
   are both reachable; 503 otherwise. Coolify routes accordingly.
7. **Public pages.** `/about`, `/privacy` (real text — what's stored,
   for how long, who can see it, how to delete), `/terms`.
8. **DNS + domain** in Coolify. CNAME from your domain.

**Out of scope:** multi-region, CDN, paid monitoring, status page,
custom uptime SLA.

---

## Phase 11+ — only if it grows into something

Out of scope for now but named so they don't surprise us:

- **Teams / orgs.** Shared workspaces, RBAC, shared audit visibility.
- **OAuth.** Google / GitHub for friction-free sign-in.
- **Webhooks / API tokens.** CI integration, GitHub Actions, PR-comment
  bot.
- **Billing.** Stripe + a free-tier limit.
- **Side-by-side compare.** Beyond Phase 7b's simple baseline diff.
- **Trends dashboard.** Score over time, regression detection.
- **Admin UI.** User list, quota override, force-cancel runaway job.
- **Open-source-vs-proprietary fork.** Real decision once it ships
  publicly.

---

## Total shape

Roughly **9–11 days of focused work** to go from where `/web` is today
to a hardened, hosted, multi-user app on your VPS via Coolify.

Recommended order: **5 → 6 → 9 → 10**, deferring 7 and 8 until after
hosted is live. That puts the public URL up in ~7 days and the
high-value workflow features land as v1.1 a week later.

If hosted-online is less urgent than great-local-tool: **5 → 6 → 7 → 8 → 9
→ 10**, same total time.

Phases 12 / 12.5 / 8b shipped 2026-05-08, ~12 days of focused work, delivered with parallel agents.

---

## Out of scope for v1.0 (lifted from `/web/PLAN.md`, still true)

- Editing the SCORM source in the browser (CLI `--fix` is the path).
- Comparing > 2 audit runs in one view.
- Publishing to npm.
- Publishing as a managed SaaS for paying users.

---

## Phase 12 — Rebuild in cloud (~5–8 days)

**Status (2026-05-08): Shipped.** Cloud rebuild surface is live: rebuild CTA, tier picker, SSE progress, checkpoint review UI, undo controls, queue separation, rate limits, integration tests. See `cloud/CLAUDE.md` § "Rebuild surfaces" for the full endpoint list and storage layout.

**Goal:** A logged-in user uploads a package, runs an audit, then runs a rebuild from the same UI. Safe-tier rebuilds produce a downloadable `rebuilt.zip` directly. Full-tier rebuilds open a browser-based checkpoint review with per-transform approve/reject controls and promote on submission. Atomic transform undo lives in the same per-job UI as v4 single-patch undo.

**Success criteria:**
- "Rebuild this audit" CTA appears next to every completed audit job in the history pane. Clicking it queues a rebuild against the same uploaded package.
- Rebuild jobs run in the existing pg-boss queue. The worker reuses `src/rebuild/index.js`. Cancel via `AbortSignal` works the same as audit cancel.
- After a safe-tier rebuild completes: the report panel exposes `rebuilt.zip`, `rebuild-manifest.json`, and a rendered `rebuild-diff.html` inline.
- After a full-tier rebuild completes: the panel renders `rebuild-preview.html` in an iframe with a sidebar listing every staged transform. Per-transform approve / reject toggles + a single "Promote" button POST decisions to the server.
- Promote calls `src/rebuild/checkpoint.js`'s `promote()`, runs verify, and updates the job. On failure (verify regression, manifest XML invalid, SCO sequence broken), the staging area is preserved server-side and the UI surfaces the rollback reason.
- Transform-atomic undo is reachable from the job's actions menu: "Revert transform <id>" reverses the bundle and re-renders the diff.

**Decisions to lock in:**
- **Storage layout for staging:** `.rebuild-staging/` lives under the same per-engagement bucket prefix as the audit results. Lifecycle: 7-day TTL on staging if no decision has been recorded; promoted artifacts honor the engagement's normal retention window.
- **Concurrency:** rebuild is heavier than audit. Cap the queue at `WORKER_REBUILD_CONCURRENCY=2` separate from `WORKER_CONCURRENCY=3` for audit. Per-user quota: 1 in-flight rebuild + 2 in-flight audits.
- **Checkpoint state:** the browser POSTs `{ [transformId]: 'approve'|'reject' }` to `/api/jobs/:id/checkpoint`. Server writes `checkpoint-state.json` to the staging dir, then calls `promote()`. The HTML's localStorage is a UX nicety, not the source of truth.
- **Auth scope:** rebuild and approve both require the same role as the original audit's owner. No team sharing in v1.0; that's a Phase 13+ decision.
- **LLM provider:** assisted-tier rebuild is gated behind a per-engagement env-configured provider, same shape as v3's audit `--llm-provider` flag. No firm-wide default.

**Out of scope for Phase 12:**
- Editing the rebuilt package in the browser before download.
- Comparing two rebuild manifests side-by-side.
- Multi-tenant approval workflows (one user proposes, another approves) — single-approver only.
- Modernizing SCORM versions (still its own future workstream).

**Sizing:** rough working-day estimates for a single implementer.

| Work | Days |
|------|------|
| Backend: rebuild job kind, worker dispatch, queue separation, quota | 1.0 |
| Backend: checkpoint endpoints, staging storage adapter, retention worker | 1.0 |
| Backend: undo endpoint with `--transform` semantics, audit log entries | 0.5 |
| Frontend: "Rebuild this audit" CTA, mode picker, progress feedback | 1.0 |
| Frontend: full-tier checkpoint review UI (preview iframe + sidebar + promote button) | 2.0 |
| Frontend: undo controls + post-undo diff refresh | 0.5 |
| Tests: integration tests covering safe + full + promote-failure rollback | 1.0 |
| Hardening: rate limits on rebuild + checkpoint, quota enforcement, error UX | 0.5 |
| **Total** | **~7.5 days** |

Order this **after** Phase 11 settles. Don't start Phase 12 without confirming the v5 engine ships are stable in CLI usage for at least one full Skill Loop engagement cycle — the engine is well-tested in unit + integration land but real-package edge cases will surface from consultant use first.

The relevant engine modules are in `src/rebuild/`, `src/transformers/`, `src/widgets/`, and `src/reporter/rebuild-preview.js`. The per-package output contract is documented in `archive/workstreams/v5-full-tier/PRD_v5_FullTier.md` § "Manifest schema v2.0.0".

---

## Phase 12.5 — LLM activation in cloud (~3–4 days)

**Status (2026-05-08): Shipped.** v3.1 server-env activation landed first (Wave 1: `writeReports` forwarding for `report.html`; the `report.md` gap was closed as a Wave 1 follow-up). Per-workspace BYO keys, Settings UI, cost telemetry, and rebuild LLM threading all shipped in Wave 2 (2026-05-08). The phase is complete.

**Goal:** the LLM features shipped in v3.1 (audit narrative), v4.1 (assisted
rebuild fixers), and v5.1 (transformer judgment) all reach Prism.skill-loop.com
under per-workspace control, with consultant-grade isolation and cost visibility.

**Success criteria:**
- A logged-in user can store their own Anthropic API key from a Settings page;
  the key is encrypted at rest, never logged, never returned in any API
  response except as a redacted last-4-digits summary.
- Per-engagement narrative on/off toggle in the upload form (default on when
  the workspace has a key set).
- After Phase 12 lands: assisted-tier fixers fire when a workspace key is
  present; rebuild-manifest carries `provenance.source: 'llm'` for assisted
  patches and the diff report renders the "needs sign-off" chip.
- After Phase 12 lands: transformer judgment surfaces in the checkpoint
  preview as the AI verdict pill (`AI-CONFIRMED`, `AI-UNCERTAIN`) per the
  v5.1 PRD's preview contract.
- Per-workspace token-spend counter in the user's Settings page (last 30 days,
  rolling).

**Decisions to lock in:**
- **Storage:** new table `workspace_llm_config` keyed on `user_id`. Columns:
  `provider`, `model`, `encrypted_api_key`, `key_last4`, `created_at`,
  `updated_at`. Encrypted via AES-GCM with a derived key from a new env var
  `DATA_ENCRYPTION_KEY` (32 bytes, refused-to-start if missing in hosted
  mode). Key rotation is a Phase 13+ question.
- **Forwarding pattern:** the cloud reads workspace config in the audit/rebuild
  route, decrypts the key into a local variable, sets it as a per-request env
  var only for the writeReports/rebuild call (using a fresh provider instance).
  Engagement isolation uses the same posture as v4.1: provider reinstantiated
  per call.
- **Cost telemetry:** `usage` from the v4.1/v3.1/v5.1 provenance objects gets
  rolled into `workspace_llm_usage` (date, input_tokens, output_tokens,
  estimated_cost_usd). Aggregated nightly. Per-user cost dashboard is a
  Settings-page widget.
- **Default model:** Anthropic Haiku 4.5 across all three features — same
  default the CLI uses. Sonnet/Opus opt-in via the per-workspace `llm_model`
  field.

**Out of scope for Phase 12.5:**
- OAuth-based key handoff (Anthropic doesn't offer this today).
- Multi-provider fallback (OpenAI is reserved in `getProvider` but no Phase
  ships it before there's demand).
- Token-budget enforcement on the cloud beyond the existing per-call
  `--llm-narrative-token-budget` and `--llm-judgment-token-budget` defaults.
  Cost alerts are dashboard-only in this phase.

**Sizing:**

| Work | Days |
|------|------|
| DB migration + crypto helper + workspace_llm_config CRUD | 1.0 |
| Settings page UI (provider picker, key input, last-4 redacted display, save/test/delete) | 1.0 |
| Workspace-key threading: audit route, rebuild route (depends on Phase 12 first), narrative toggle | 0.5 |
| Cost telemetry: usage rollup table + nightly aggregation + Settings widget | 1.0 |
| Tests: encrypt/decrypt round-trip, key isolation across users, narrative on/off | 0.5 |
| **Total** | **~4 days** (depends on Phase 12 for the rebuild + checkpoint surfaces) |

---

## Phase 8b — Bigger batches + parallel upload (~1 day)

**Status (2026-05-08): Shipped.** The original Phase 8 cap of 50 files per batch was
hard-coded; the cap is now env-configurable via `PRISM_MAX_BATCH_COUNT`
(default 200). The browser uploader now runs N concurrent uploads (default 4)
with sequential fallback. Per-file progress and a sequential-vs-parallel toggle
are in the batch upload UI.

**Goal:** a 200-package upload completes in ~5 minutes instead of ~25.

**Success criteria:**
- Browser uploader runs N concurrent uploads (configurable via the Settings
  page; default 4) with backpressure when the worker queue is saturated.
- Sequential-vs-parallel mode toggle in the batch upload UI; default
  parallel. Per-file progress bars stack vertically with completion order
  preserved in the rollup.
- 413 batch_count_exceeded message displays the current cap honestly, not a
  baked-in "50".

**Out of scope:** resumable uploads (browser-side state for partial transfers
is a Phase 13+ question — the workaround is "create a new batch and re-upload
the failed files," which the existing per-file 202 + idempotent-by-sha256
path already supports).

**Sizing:** ~1 day, mostly frontend.

---

## Capacity baseline (CX31, measured 2026-05-08)

The hosting target is a Hetzner CX31 (8 GB RAM, 2–4 vCPU, ~80 GB SSD).
Measured per-package wall-clock against representative fixtures:

| Operation | Per-package | At 3-concurrent |
|---|---|---|
| Audit | ~1 s (fixture) → ~20 s (real) | ~7 s/pkg amortized |
| Audit + safe rebuild | ~2 s (fixture) → ~40 s (real) | ~13 s/pkg amortized |
| Audit + full rebuild | ~8 s (fixture) → ~75 s (real) | ~25 s/pkg amortized |

For a 200-package library:

- Audit-only: **~22 minutes** at 3-concurrent, ~2.5 GB peak RAM.
- Audit + safe rebuild: **~45 minutes**, same peak RAM.
- Audit + full rebuild: **~80 minutes**.

LLM cost (Anthropic Haiku 4.5, default budgets):

- v3.1 narrative only: ~$0.054/package → **~$11/200-package library**.
- v3.1 + v5.1 (judgment) on full rebuild: roughly +$0.025/package → **~$16/200-package library**.

These numbers were measured against the project's own test fixtures, then
scaled by typical-package multipliers. They're not promises — real packages
with 20+ SCOs and bigger asset trees will push the upper bound. But they're
adequate to falsify the "CX31 can't handle bulk" assumption: it can. The
upload bottleneck has been addressed by Phase 8b's parallel browser upload,
and the cloud rebuild surface (Phase 12) is now live.


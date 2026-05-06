# Bulk Audit — Implementation Plan

**Status:** Draft for review
**Author:** Dave Nguyen + Claude (planning session)
**Owner surface:** `cloud/` (the hosted multi-tenant service)
**Ships:** Phase 8 in `cloud/ROADMAP.md` ("Batch & Power-User UX")

---

## 1. Problem and goal

The cloud UI accepts one zip at a time. Skill Loop consultants regularly audit 20–50 SCORM packages per engagement, so the current flow forces tedious one-at-a-time uploads. A previous attempt at batching produced **502 errors from the Coolify/Traefik front end** during upload — the proxy gave up on long multipart requests.

Goal: a bulk audit experience that handles **up to 50 packages per batch** without recurring the 502 problem, with live per-file progress and a cross-package rollup at the end. Local `web/` stays frozen by policy; CLI gets no behavior change.

## 2. Why the 502 happened (the design constraint)

Two probable contributors, in order of likelihood:

1. **One big multipart request.** The existing `POST /api/audits/batch` accepts up to 30 files in one multer call. A single slow upload — common with multi-MB SCORM zips — pushes the request past Traefik's `proxy_read_timeout`, and the whole batch dies.
2. **Synchronous work on the upload path.** If anything (parsing, manifest detection) runs before `res.send`, the upload connection stays open through audit work too.

Every architectural choice below flows from this: **upload and audit are decoupled, no HTTP request ever spans more than a single file, and the response is sent the moment the file is on disk.**

## 3. Scope

In:

- New batch endpoints in `cloud/server/routes/audits.js` (or a new `routes/batches.js`).
- New cloud UI for multi-select / drag-drop / folder pick.
- Live progress via Server-Sent Events.
- Cross-package rollup, reusing `src/lib/library-rollup.js` and `scope-estimator.rollupLibrary`.
- Reverse-proxy timeout / body-size doc for the Coolify deployment.

Out:

- Anything in `web/` (frozen).
- Audit pipeline changes (`src/checks`, `src/dynamic-checks`, scoring).
- pg-boss queue swap (Phase 9C/10 — already scaffolded in `cloud/server/lib/queue.js`).
- S3 storage swap (adapter exists at `cloud/server/storage/s3.js`; cutover is Phase 9).
- Multi-tenant quotas tightening (`cloud/server/lib/quotas.js` already exists; we'll respect it, not redesign it).

## 4. Architecture

### 4.1 Upload contract (the 502 fix)

| Step | Endpoint | Body | Response | Notes |
|------|----------|------|----------|-------|
| Open batch | `POST /api/batches` | `{ engagementId, label?, count }` | `{ batchId, expiresAt }` | No file. Cheap. |
| Add file | `POST /api/batches/:id/files` | multer single file (`package`) | `202 { jobId, filename }` | One zip per request. Returns the moment the file lands on disk and the job is enqueued. |
| Inspect | `GET /api/batches/:id` | — | `{ batchId, jobs[], counts }` | Snapshot. |
| Subscribe | `GET /api/batches/:id/events` | — | SSE stream | Pushes job state transitions. |
| Rollup | `GET /api/batches/:id/rollup.{html,md,json}` | — | rendered rollup | Materialized when the last job completes. |

Why per-file POST instead of one multipart-N: each request is short, so Traefik's default timeouts are no longer load-bearing; a 5xx on file 7 of 20 doesn't poison the batch (client retries that one file with the same `batchId`); upload progress is naturally per-file in the UI.

The existing `POST /api/audits/batch` is **deprecated** with a `Sunset` header for one release, then removed. (Open question — see §10 — happy to drop it now since it's consultant-internal.)

### 4.2 Worker concurrency

`cloud/server/job-manager.js` currently runs jobs serially via `_tick`. The CLI's `audit-library` is also serial **by considered design** — `src/lib/audit-library.js` line 13 explicitly notes "Playwright browser contention isn't worth the complexity in v3.0."

Plan: **default `WORKER_CONCURRENCY=1`** (match CLI), expose as env var, ship hidden support for 2 by giving each worker its own Playwright browser context. The 502 is an upload problem, not an audit-throughput problem; we can leave concurrency at 1 and revisit only if consultants complain about wall-clock time on a 50-package batch.

### 4.3 Live progress (SSE, not WebSockets)

Server-Sent Events because:

- Firewall-friendlier than WS (consultant networks vary).
- Auto-reconnect built into the browser.
- One-way (server → client) is exactly what we need.
- No new dependency — Express + plain `res.write`.

Each batch keeps an in-memory subscriber set. `JobManager` already emits state transitions; we add a `batch:` namespace and fan out to subscribers. On reconnect, the client re-fetches `GET /api/batches/:id` to catch missed events.

### 4.4 Frontend

Single new page (or modal) at `/batch`. Three intake modes funneling the same uploader:

- `<input type="file" accept=".zip" multiple>` — multi-select.
- HTML5 drag-and-drop on a dropzone.
- `<input type="file" webkitdirectory>` — folder pick. Filter to `*.zip` client-side, **one level deep only** to match `audit-library` semantics.

**Bounded uploader:** 3 in flight at a time, exponential backoff retry on 5xx (each file retries independently), per-file progress bar from `XMLHttpRequest.upload` events. (Native `fetch` doesn't expose upload progress; this is the one place XHR is the right tool.)

**Live table:** filename · upload bar · audit phase · violations · disposition · per-package report link. Updates in place from SSE.

**Rollup CTA:** appears when all jobs reach a terminal state. Links to `/batches/:id/rollup.html` and offers `.md` / `.json` downloads.

### 4.5 Reuse, not extraction

- `src/lib/library-rollup.js` → `renderLibraryRollupHtml`, `renderLibraryRollupMarkdown` are already pure renderers. Cloud worker imports and calls.
- `src/lib/scope-estimator.js` → `rollupLibrary` is the aggregator. Same.
- The audit core (`src/index.js`) is unchanged.

The only reason to touch `src/` is if a function needed by cloud isn't reachable; today it is. **Zero changes to `src/` planned.**

## 5. File and surface inventory

```
cloud/server/routes/batches.js              NEW
cloud/server/routes/audits.js               EDIT (deprecate /audits/batch)
cloud/server/job-manager.js                 EDIT (add worker pool + batch fan-out)
cloud/server/lib/batch-store.js             NEW (in-memory + sqlite/postgres rows)
cloud/server/lib/sse.js                     NEW (small fan-out helper)
cloud/server/store/migrations/00x-batches.sql NEW
cloud/public/batch.html                     NEW (vanilla HTML — matches existing cloud/public/ pages)
cloud/public/batch-uploader.js              NEW (XHR-based bounded uploader)
cloud/public/batch-live-table.js            NEW (SSE consumer + table renderer)
cloud/public/app.js                         EDIT (route to new page; today calls /api/audits/batch directly at L214–249)
docs/BULK_AUDIT_PLAN.md                     this doc
cloud/ROADMAP.md                            EDIT (Phase 8 → done on merge)
cloud/COOLIFY_TIMEOUTS.md                   NEW (proxy config notes)
src/**                                       UNCHANGED
web/**                                        UNCHANGED
```

## 6. Phasing and delegation

Per CLAUDE.md ("Delegate to subagents using the best model — Opus, Sonnet, or Haiku — and run them in parallel whenever possible"). Model picks reflect the cognitive load of each slice.

### Phase 1 — Backend contract and core (≈1.5 days)

| Slice | Model | Rationale | Output |
|-------|-------|-----------|--------|
| Lock the wire contract: endpoint shapes, SSE event schema, rollup URL pattern, Sunset semantics for the old route. | **Opus** | Architectural; the contract is what every other slice depends on, including the frontend uploader's retry logic and the worker pool's fan-out. Mistakes here cost the most to undo. | `docs/BULK_AUDIT_API.md` (the contract). |
| Implement `POST /api/batches`, `POST /api/batches/:id/files`, `GET /api/batches/:id`. Wire to `JobManager`. | **Sonnet** | Solid Express plumbing once the contract is set. | Routes + tests. |
| Implement SSE endpoint and the small fan-out helper. | **Sonnet** | Mechanical once the event schema is set. | `lib/sse.js`, route handler. |
| Add bounded worker pool to `JobManager._tick`, env-controlled, default 1. | **Opus** | Touches the only place audit execution could break; "bounded pool" + Playwright contexts has subtle pitfalls (shared browser, leak on crash). Worth the heavier model. | Patch + concurrency test. |
| Migration for `batches` table; integration with both sqlite and postgres stores. | **Sonnet** | Routine SQL with two driver paths. | Migration file. |
| Stamp `Sunset` header + warning log on legacy `POST /api/audits/batch`. | **Haiku** | Three lines of header/log code. | Patch. |

Phase 1 ships **behind a feature flag** (`BULK_AUDIT_UI=1`) so the existing single-upload UX keeps working in prod while we iterate.

### Phase 2 — Frontend (≈2 days)

| Slice | Model | Rationale | Output |
|-------|-------|-----------|--------|
| `/batch` page shell, three intake modes (multi-select, drag-drop, folder), client-side `*.zip` filter. | **Sonnet** | Standard browser UI work. | `batch.html`, intake JS. |
| Bounded XHR uploader: 3 in flight, exponential backoff on 5xx, per-file progress. | **Opus** | The 502-resistance lives here. Backoff + idempotency edge cases (same filename retried, network drop mid-upload) need careful logic. This is the slice the user is most exposed to if it's wrong. | `batch-uploader.js` + unit tests against a mock server that injects 502s. |
| Live table component, SSE subscription with reconnect-and-resync, terminal-state detection. | **Sonnet** | Display-tier wiring on top of the contract. | `batch-live-table.js`. |
| Rollup CTA + report links. | **Haiku** | Two buttons and an anchor pattern. | Patch. |
| Empty/error states + copy. | **Haiku** | Pure copy/CSS. | Patch. |

### Phase 3 — Hardening (≈0.5 day)

| Slice | Model | Rationale | Output |
|-------|-------|-----------|--------|
| Coolify/Traefik config doc: `client_max_body_size`, `proxy_read_timeout`, healthcheck guidance. | **Sonnet** | Operations-flavored writing; needs to be precise about which endpoint gets which value. | `cloud/COOLIFY_TIMEOUTS.md`. |
| Idempotency on `POST /api/batches/:id/files`: same `(batchId, filename, sha256)` → returns the existing `jobId` instead of double-enqueueing. | **Opus** | Subtle correctness; race conditions if two clients retry the same file. | Patch + race test. |
| Playwright integration test: upload 20 zips, force a 502 on file 7, verify batch completes and only file 7 retried. | **Sonnet** | High-value end-to-end test; the canary that says "the 502 problem is actually fixed." | `cloud/test/batch-resilience.spec.js`. |
| Vitest coverage for batch-store, SSE fan-out, uploader retry logic. | **Haiku** | Mechanical unit tests. | `*.test.js`. |

### Phase 4 — Docs and rollout (≈0.25 day)

| Slice | Model | Rationale | Output |
|-------|-------|-----------|--------|
| Flip Phase 8 → complete in `cloud/ROADMAP.md`; cross-link this plan and the API doc. | **Haiku** | Tiny edits. | Roadmap diff. |
| Consultant-facing "how to run a batch audit" page in whatever consultant docs exist. | **Sonnet** | Tone matters; needs to read like the rest of Skill Loop's docs. | New doc. |

### Parallelism

Within each phase, slices run concurrently wherever they don't share a file:

- Phase 1: routes (Sonnet) + worker pool (Opus) + migration (Sonnet) + Sunset header (Haiku) all in parallel after the contract is locked.
- Phase 2: page shell, uploader, and live table can all start the moment Phase 1's contract is signed off — they only converge at integration time. Empty-state copy (Haiku) can run alongside everything.
- Phase 3: doc, idempotency, and tests are independent.

The only hard serialization: **the wire contract (Phase 1, Opus) blocks everything else**. That's intentional — it's the most expensive thing to redo.

## 7. Defenses against the 502 recurrence

A short list to verify on every PR in this stack:

1. No HTTP request spans more than one file.
2. `POST /api/batches/:id/files` returns within ~`f(file_size / network_speed)` — never waits for audit work.
3. Client retries individual files independently with exponential backoff capped at ~30s.
4. Idempotency keyed on `(batchId, filename, sha256)` — a successful retry-after-server-success is a no-op, not a duplicate job.
5. Reverse-proxy timeouts and body-size limits set explicitly in `cloud/COOLIFY_TIMEOUTS.md`, with values justified to the file route's worst case.
6. The Phase 3 Playwright "force 502 on file 7 of 20" test must pass on every PR.

## 8. Success criteria

- Consultant can upload 50 zips via drag-drop and walk away without watching the tab.
- A single transient 5xx mid-batch results in exactly one retry of that file, no user intervention.
- Live table updates within ~2 s of a job state transition.
- Rollup HTML matches the existing `audit-library` rollup format byte-for-byte (same renderer).
- `npm test` green; new Playwright resilience test green; `npm run check-no-network` green.
- ROADMAP Phase 8 box ticked.

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Worker pool > 1 introduces Playwright instability the CLI deliberately avoided. | Default is 1. Knob exists for ops, not users. Don't ship pool > 1 to prod until a soak test says otherwise. |
| SSE through a long-lived proxy connection re-introduces a different timeout class of bug. | Server emits a heartbeat every 15 s. Client uses `EventSource`'s built-in reconnect. Snapshot endpoint covers any gaps. |
| Drag-drop folder upload pulls in non-zip files or recurses too deep. | Client filters to `*.zip` and a single directory level (matches `audit-library`). Server rejects non-zip MIME types as a backstop. |
| In-memory batch state is lost on web container restart. | Persist `batches` and `batch_files` rows; reconstruct in-memory subscriber state lazily on first request. |
| Per-engagement quota in `quotas.js` could silently reject mid-batch. | Pre-flight check at `POST /api/batches` against current usage + the announced `count`; reject the batch up front, not file-by-file. |

## 10. Decisions

- **Hard cap.** **50 per batch.** Decided 2026-05-06.
- **Legacy `POST /api/audits/batch`.** **Delete in Phase 1**, no Sunset window. It's the source of the 502s; keeping it alive invites regression. Consultant-internal only, no external integrations.
- **Worker concurrency in prod.** **Default 1**, env var `WORKER_CONCURRENCY` exposed for ops. Matches the considered serial-Playwright decision in `src/lib/audit-library.js`. Revisit only if wall-clock becomes the complaint.

---

## Appendix A — SSE event schema (draft, to be finalized in Phase 1 / Opus)

```jsonc
// event: file
{ "type": "file.uploaded",  "batchId": "b_…", "jobId": "j_…", "filename": "course-1.zip" }
{ "type": "file.queued",    "batchId": "b_…", "jobId": "j_…" }
{ "type": "file.running",   "batchId": "b_…", "jobId": "j_…", "phase": "static" | "dynamic" }
{ "type": "file.done",      "batchId": "b_…", "jobId": "j_…", "violations": 12, "reportUrl": "/jobs/j_…/report.html" }
{ "type": "file.failed",    "batchId": "b_…", "jobId": "j_…", "error": "…", "exitCode": 2 }

// event: batch
{ "type": "batch.complete", "batchId": "b_…", "rollupUrl": "/batches/b_…/rollup.html" }

// keep-alive (every 15 s)
{ "type": "ping", "ts": 1730000000000 }
```

## Appendix B — Why not just bump Traefik timeouts?

Tempting, and we will set them deliberately rather than rely on defaults — but bumping timeouts is a stopgap, not an architecture. If one zip is slow today and we set the timeout to 5 minutes, a slower zip tomorrow needs 10. The fix is to make each request short. Per-file POSTs do that structurally; large timeouts only buy time.

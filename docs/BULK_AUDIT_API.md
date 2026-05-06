# Bulk Audit API Contract

**Status:** Phase 1 wire contract  
**Date:** 2026-05-06  
**Scope:** Endpoints, SSE event schema, persistence, error model, and quota interaction for the bulk audit feature.

This document is the single source of truth for the five Phase 1 slices: routes, SSE, migrations, worker pool, and frontend uploader. Every implementation choice below flows from the constraints in [BULK_AUDIT_PLAN.md](BULK_AUDIT_PLAN.md) §2 (the 502 problem) and §7 (defenses against its recurrence).

---

## Overview

The bulk audit API decouples upload from audit execution: clients POST one file per request, get an immediate 202 response, and receive live job state via Server-Sent Events. No HTTP request spans more than one file, so Traefik's reverse-proxy timeouts never become a load-bearing concern. The user can upload 50 packages in parallel without the server blocking, and a transient 5xx on file 7 of 20 is a self-contained retry—not a cascade failure. Per [BULK_AUDIT_PLAN.md §4.1](BULK_AUDIT_PLAN.md#41-upload-contract-the-502-fix), this architecture replaced the previous synchronous `POST /api/audits/batch` (which accepted 1–30 files in a single multipart request and caused the proxies to time out during slow uploads).

---

## Endpoints

### 1. POST /api/batches

**Create a batch session.**

**Auth:** Required (hosted mode). `requireAuth` middleware gates this endpoint.

**CSRF:** Required (hosted mode). `csrfProtect` middleware validates the token.

**Request body** (JSON):

```json
{
  "engagementId": "eng_abc123",
  "label": "Kickoff audit - ACME Corp",
  "count": 25
}
```

**Fields:**
- `engagementId` (string, required): Engagement identifier. Used to isolate output on disk at `engagements/{engagementId}/{batchId}/`.
- `label` (string, optional): User-provided batch label for display. Stored with the batch record.
- `count` (number, required): Announced file count. Validated immediately: if `count > 50`, the request fails with 413. Passed to quota pre-flight (see Quota Interaction §6).

**Success response** (HTTP 202):

```json
{
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "expiresAt": 1714982400000
}
```

**Fields:**
- `batchId` (string): UUID for this batch session.
- `expiresAt` (number, milliseconds since epoch): When this batch and its associated storage become eligible for cleanup (default: 30 days after creation).

**Error responses:**

| Code | Reason | Body |
|------|--------|------|
| 413 | `count > 50` | `{ "error": { "code": "batch_count_exceeded", "message": "Batch cannot exceed 50 files (requested 67)" } }` |
| 429 | Quota exceeded (concurrent, daily, or storage) | `{ "error": { "code": "quota_exceeded", "message": "...", "reason": "concurrent" \| "daily" \| "storage", "limit": <number>, "current": <number> } }` |
| 401 | Auth required but not present | `{ "error": { "code": "unauthorized", "message": "Authentication required" } }` |
| 403 | CSRF token invalid | `{ "error": { "code": "csrf_failed", "message": "CSRF token mismatch" } }` |
| 500 | Server error | `{ "error": { "code": "internal_error", "message": "..." } }` |

**Side effects:**
- Creates a row in the `batches` table with `status='active'`, `createdAt=now()`, `engagementId`, `userId`, `label` (optional).
- No files are uploaded at this point. Batch is ready to receive files.

**Timeouts & body size:**
- Request: max JSON body = 10 KB (single JSON object).
- Timeout: 5 seconds (no file work).

---

### 2. POST /api/batches/:id/files

**Upload a single file and enqueue the audit job.**

**Auth:** Required (hosted mode). Same `requireAuth` middleware.

**CSRF:** Required (hosted mode). Same `csrfProtect` middleware.

**Request headers:**
- `Content-Type: multipart/form-data`
- `X-Content-SHA256: <hex>` (required): SHA256 hash of the uploaded file (computed client-side before upload). Used for idempotency keying. Example: `X-Content-SHA256: d3d9446802a44259755d38e6d163e820`.

**Request body** (multipart):
- Single file field named `package` (required). File size: 0–1 GB per file (enforced by multer).

**Success on first upload** (HTTP 202):

```json
{
  "jobId": "j_550e8400-e29b-41d4-a716-446655440001",
  "filename": "course-module-1.zip",
  "uploadedAt": 1714982340000
}
```

**Success on retry-after-success (idempotent)** (HTTP 200):

Same response body (HTTP 200, not 202). The client knows this is a replay because the status code is 200, not 202.

**Error responses:**

| Code | Reason | Body |
|------|--------|------|
| 202 | First upload (terminal) | `{ "jobId": "...", "filename": "...", "uploadedAt": <number> }` |
| 200 | Replay of same file (idempotent hit) | `{ "jobId": "...", "filename": "...", "uploadedAt": <number> }` |
| 400 | Missing `package` field or `X-Content-SHA256` header | `{ "error": { "code": "missing_field", "message": "Missing form field 'package' or header 'X-Content-SHA256'" } }` |
| 404 | Batch not found or belongs to different user | `{ "error": { "code": "batch_not_found", "message": "Batch not found" } }` |
| 409 | Batch no longer accepting files (status != 'active') | `{ "error": { "code": "batch_not_active", "message": "Batch is no longer accepting files (status: complete)" } }` |
| 413 | File too large (> 1 GB) | `{ "error": { "code": "file_too_large", "message": "File exceeds 1 GB limit" } }` |
| 429 | Quota exceeded (storage, daily count, or concurrency) | `{ "error": { "code": "quota_exceeded", "message": "...", "reason": "storage" \| "daily" \| "concurrent", "limit": <number>, "current": <number> } }` |
| 401 | Auth required but not present | `{ "error": { "code": "unauthorized", "message": "Authentication required" } }` |
| 403 | CSRF token invalid | `{ "error": { "code": "csrf_failed", "message": "CSRF token mismatch" } }` |
| 500 | Server error (e.g., write to disk failed) | `{ "error": { "code": "internal_error", "message": "..." } }` |

**Side effects (on HTTP 202 / first upload):**
- Writes file to disk at `cloud/.tmp/uploads/pending-<uuid>.zip`.
- Creates a job record via `jobs.create({ uploadPath, userId, originalName: filename, batchId, options: { ... } })`. The `batchId` is a top-level parameter that lands in the existing `jobs.batch_id` column (added in migration `0002_jobs_batch_id.sql`, with a partial index for fast "jobs in batch X" lookups).
- Creates a row in `batch_files` table with `batchId`, `jobId`, `filename`, `sha256`, `createdAt`. This row is the **idempotency record only** — batch *membership* is resolved via the `jobs.batch_id` column and the existing `store.listBatchSnapshots(batchId)` method, not via a JOIN through `batch_files`.
- Job is enqueued (added to the in-process queue or pg-boss message).
- JobManager's `_tick` loop will pick it up and begin audit (after pending jobs ahead of it). When emitting SSE events, JobManager reads `batchId` from the job row and routes events to that batch's subscriber set.

**Side effects (on HTTP 200 / idempotent replay):**
- Returns the existing `jobId` without re-enqueueing. No file written to disk again. No quota deducted again.

**Idempotency:**
- Key: `(batchId, filename, sha256)` (UNIQUE index in `batch_files` table).
- If the triple already exists in the table, return the stored `jobId` with HTTP 200.
- If the triple is new, create the file and job, return HTTP 202.
- If a retry arrives with the same `batchId` and `filename` but **different** `sha256`, treat it as a different file. This is allowed; the same filename can be uploaded twice if the content differs. (Constraint: within a single batch, allowing duplicate filenames with different sha256 is acceptable because the idempotency key includes the hash.)

**Timeouts & body size:**
- Request: max 1 GB file (multer limit).
- Timeout: per-file upload timeout = 5 minutes (conservative for slow networks; can be overridden in Coolify config). **Critical:** this is why the architecture works—each request is short enough that the proxy never times out. See [BULK_AUDIT_PLAN.md §7](BULK_AUDIT_PLAN.md#7-defenses-against-the-502-recurrence).

---

### 3. GET /api/batches/:id

**Fetch the current state of a batch and all its jobs.**

**Auth:** Required (hosted mode). Returns 404 if the batch belongs to a different user.

**CSRF:** Not required (read-only).

**Query parameters:** None.

**Success response** (HTTP 200):

```json
{
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "label": "Kickoff audit - ACME Corp",
  "createdAt": 1714982400000,
  "status": "active",
  "jobs": [
    {
      "id": "j_550e8400-e29b-41d4-a716-446655440001",
      "filename": "course-1.zip",
      "status": "done",
      "createdAt": 1714982340000,
      "startedAt": 1714982345000,
      "finishedAt": 1714982405000,
      "summary": {
        "score": 85,
        "passed": true,
        "totalViolations": 3,
        "packageType": "scorm2004",
        "complete": true,
        "incompleteReason": null
      },
      "error": null
    },
    {
      "id": "j_550e8400-e29b-41d4-a716-446655440002",
      "filename": "course-2.zip",
      "status": "running",
      "createdAt": 1714982350000,
      "startedAt": 1714982351000,
      "finishedAt": null,
      "summary": null,
      "error": null
    },
    {
      "id": "j_550e8400-e29b-41d4-a716-446655440003",
      "filename": "course-3.zip",
      "status": "error",
      "createdAt": 1714982360000,
      "startedAt": 1714982361000,
      "finishedAt": 1714982365000,
      "summary": null,
      "error": "Package extraction failed: invalid zip structure"
    }
  ]
}
```

**Fields:**
- `batchId` (string): The batch ID.
- `label` (string): User-provided label, or `null`.
- `createdAt` (number, milliseconds): When the batch was created.
- `status` (string): One of `active`, `complete`, `error`. `complete` means all jobs reached a terminal state (done, error, or cancelled).
- `jobs` (array): List of job snapshots. Each job has `status`, `summary` (present only for done jobs), `error` (present only for error/cancelled jobs), and timestamps.

**Error responses:**

| Code | Reason | Body |
|------|--------|------|
| 404 | Batch not found or belongs to different user | `{ "error": { "code": "batch_not_found", "message": "Batch not found" } }` |
| 401 | Auth required but not present | `{ "error": { "code": "unauthorized", "message": "Authentication required" } }` |
| 500 | Server error | `{ "error": { "code": "internal_error", "message": "..." } }` |

**Side effects:** None (read-only).

**Timeouts:**
- 5 seconds. Batch snapshots are cheap to assemble (store query + in-memory cache lookup).

---

### 4. GET /api/batches/:id/events

**Subscribe to live job state changes via Server-Sent Events.**

**Auth:** Required (hosted mode). Returns 404 if the batch belongs to a different user.

**CSRF:** Not required (streaming read).

**Response headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**Initial event** (sent once on connection):

```
event: batch
data: { "batchId": "b_...", "status": "active", "jobs": [ { "id": "j_...", "status": "pending", ... }, ... ] }
```

Replays the current state of the batch (same shape as `GET /api/batches/:id`).

**Live job events** (emitted as jobs transition):

See §3 (SSE Event Schema) for the full list. Examples:

```
event: file.uploaded
data: { "type": "file.uploaded", "batchId": "b_...", "jobId": "j_...", "filename": "course-1.zip" }

event: file.queued
data: { "type": "file.queued", "batchId": "b_...", "jobId": "j_..." }

event: file.running
data: { "type": "file.running", "batchId": "b_...", "jobId": "j_..." }

event: file.done
data: { "type": "file.done", "batchId": "b_...", "jobId": "j_...", "violations": 5, "score": 92, "passed": true }

event: file.failed
data: { "type": "file.failed", "batchId": "b_...", "jobId": "j_...", "error": "Package extraction failed" }

event: batch.complete
data: { "type": "batch.complete", "batchId": "b_..." }

event: ping
data: { "type": "ping", "ts": 1714982400000 }
```

**Heartbeat:** Server emits a `ping` event every 15 seconds to keep the connection alive and detect network drops on the client side.

**Stream closes when:**
- All jobs reach a terminal state (done, error, or cancelled) AND a `batch.complete` event has been sent.
- Client disconnects (browser tab closes, network drops, etc.).

**Fallback after disconnect:**
- Client loses the SSE connection mid-batch (network glitch, proxy timeout, etc.).
- Client closes the EventSource, waits 5–10 seconds, and re-opens a new SSE connection to the same `/api/batches/:id/events` endpoint.
- The new connection replays the initial `batch` event (with current state) plus any progress events buffered by the server since the last connection.
- **Clients do NOT fall back to polling.** The SSE contract is reliable enough for this use case. If the stream closes unexpectedly, a fresh connection to the same endpoint is the recovery strategy.

**Error responses:**

| Code | Reason | Body (before stream closes) |
|------|--------|-------------|
| 404 | Batch not found or belongs to different user | `{ "error": { "code": "batch_not_found", "message": "Batch not found" } }` |
| 401 | Auth required but not present | `{ "error": { "code": "unauthorized", "message": "Authentication required" } }` |
| 500 | Server error | `{ "error": { "code": "internal_error", "message": "..." } }` (stream closes immediately) |

**Side effects:** None (read-only). Server maintains an in-memory subscriber set per batch; SSE connections are added/removed as clients connect/disconnect.

**Timeouts:**
- Initial connection: 5 seconds.
- Stream: no timeout (long-lived). Client receives a ping every 15 seconds. If the client doesn't receive a ping within 45 seconds, it should assume the connection is stale and reconnect.

---

### 5. GET /api/batches/:id/rollup.{html,md,json}

**Render a cross-package rollup report.**

**Auth:** Required (hosted mode). Returns 404 if the batch belongs to a different user.

**CSRF:** Not required (read-only).

**Path parameters:**
- `:id` — batch ID
- Format: one of `html`, `md`, or `json` (based on file extension).

**Success response** (HTTP 200):

Depends on format:
- **html**: `Content-Type: text/html; charset=utf-8`. Full HTML report matching the single-job report style, but aggregating all jobs in the batch.
- **md**: `Content-Type: text/markdown; charset=utf-8`. Markdown report with the same sections as the HTML variant.
- **json**: `Content-Type: application/json`. JSON scorecard with library-level aggregation (violations, score, triage breakdown, etc.).

**Response body:**
- **html/md**: Full rendition of `src/lib/library-rollup.js` template with batch violations, scope estimates, triage tags, top risks, and section 508 mapping.
- **json**: JSON object with the same fields as a single-job report, but with violations from all jobs merged and scored at the batch level.

**Error responses:**

| Code | Reason | Body |
|------|--------|------|
| 404 | Batch not found, or belongs to different user, or no jobs in the batch | `{ "error": { "code": "batch_not_found", "message": "Batch not found or has no jobs" } }` |
| 409 | Batch not yet complete (at least one job still pending/running) | `{ "error": { "code": "batch_incomplete", "message": "Batch is still running; rollup unavailable until all jobs complete" } }` |
| 401 | Auth required but not present | `{ "error": { "code": "unauthorized", "message": "Authentication required" } }` |
| 500 | Server error | `{ "error": { "code": "internal_error", "message": "..." } }` |

**Side effects:** None (read-only). Rollup is computed on demand by loading all job results from the store and calling `src/lib/library-rollup.js`.

**Timeouts:**
- 30 seconds (rendering large HTML/Markdown rollups can be slow; the JSON variant is cheaper).

---

## SSE Event Schema

Every event carries a `type` field and optional metadata. Clients parse the event type and dispatch to handlers. The server emits a single event per line over the stream; the client's EventSource API automatically parses each `event: <name>` and `data: <json>` pair.

### Event: file.uploaded

**When:** Emitted immediately after a file is written to disk (response to `POST /api/batches/:id/files`).

```json
{
  "type": "file.uploaded",
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "jobId": "j_550e8400-e29b-41d4-a716-446655440001",
  "filename": "course-1.zip",
  "uploadedAt": 1714982340000
}
```

---

### Event: file.queued

**When:** Emitted when a job transitions from `pending` to `queued` (waiting for a worker slot).

```json
{
  "type": "file.queued",
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "jobId": "j_550e8400-e29b-41d4-a716-446655440001",
  "filename": "course-1.zip"
}
```

---

### Event: file.running

**When:** Emitted when a job transitions from `pending`/`queued` to `running`.

```json
{
  "type": "file.running",
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "jobId": "j_550e8400-e29b-41d4-a716-446655440001",
  "filename": "course-1.zip"
}
```

**Note on phases:** The current JobManager does not distinguish `static` vs `dynamic` phases in the event stream; it emits generic `progress` events with a `stage` field. If JobManager later gains phase-level tracking, a `phase: "static"` or `phase: "dynamic"` field can be added to this event. For now, omit the phase tag.

---

### Event: file.done

**When:** Emitted when a job completes successfully (status transitions to `done`).

```json
{
  "type": "file.done",
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "jobId": "j_550e8400-e29b-41d4-a716-446655440001",
  "filename": "course-1.zip",
  "score": 92,
  "passed": true,
  "totalViolations": 3,
  "finishedAt": 1714982405000
}
```

**Fields:**
- `score` (number): Audit score (0–100).
- `passed` (boolean): True if audit passed (no critical violations, or as defined by policy).
- `totalViolations` (number): Count of violations found.
- `finishedAt` (number): Timestamp when the audit finished.

---

### Event: file.failed

**When:** Emitted when a job fails (status transitions to `error`).

```json
{
  "type": "file.failed",
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "jobId": "j_550e8400-e29b-41d4-a716-446655440001",
  "filename": "course-1.zip",
  "error": "Package extraction failed: invalid zip structure",
  "exitCode": 2,
  "finishedAt": 1714982365000
}
```

**Fields:**
- `error` (string): Error message.
- `exitCode` (number): Exit code (1 = violations found, 2 = tool error / audit incomplete).
- `finishedAt` (number): Timestamp when the job failed.

---

### Event: batch.complete

**When:** Emitted once when the last job in the batch reaches a terminal state. This signals the client that the entire batch is done and the rollup is ready.

```json
{
  "type": "batch.complete",
  "batchId": "b_550e8400-e29b-41d4-a716-446655440000",
  "completedAt": 1714982405000
}
```

After this event, the server closes the SSE stream.

---

### Event: ping

**When:** Emitted every 15 seconds as a keep-alive (prevents proxy/firewall timeouts and allows the client to detect a dead connection).

```json
{
  "type": "ping",
  "ts": 1714982400000
}
```

---

## Idempotency Contract

Idempotency applies to `POST /api/batches/:id/files` only.

**Key:** `(batchId, filename, sha256)` — the triple uniquely identifies a file within a batch.

**Behavior:**
1. **First upload of the triple:** Response is HTTP 202 with the new `jobId`. File is written to disk. Job is created and enqueued.
2. **Retry with identical triple:** Response is HTTP 200 with the existing `jobId`. File is NOT written to disk again. Job is NOT re-enqueued. Quota is NOT deducted again.
3. **Upload of same filename, different sha256:** Treated as a new file. Allowed. Creates a separate job (as long as the batch is still `active`).

**Storage:**
- `batch_files` table has a UNIQUE index on `(batch_id, sha256, filename)` to detect collisions.
- The idempotency key is stored in the `batch_files` row and queried on every upload attempt.

**Cleanup:**
- Idempotency keys are cleaned up when the batch transitions to `complete` status (all jobs terminal).
- Old entries (batches > 30 days old) are cleaned up during the nightly retention sweep.

---

## Error Model

All error responses use a consistent shape:

```json
{
  "error": {
    "code": "<snake_case_code>",
    "message": "<human_readable_message>",
    "details": { /* optional, context-specific */ }
  }
}
```

**Error codes used across the API:**

| Code | HTTP | Meaning |
|------|------|---------|
| `batch_count_exceeded` | 413 | Announced batch count > 50 |
| `batch_not_found` | 404 | Batch ID doesn't exist or belongs to different user |
| `batch_not_active` | 409 | Batch status is not `active` (already `complete` or `error`) |
| `missing_field` | 400 | Required form field or header is missing |
| `file_too_large` | 413 | Uploaded file > 1 GB |
| `quota_exceeded` | 429 | Quota check failed (see §6). Response includes `reason`, `limit`, `current`. |
| `unauthorized` | 401 | Auth middleware rejected the request |
| `csrf_failed` | 403 | CSRF token validation failed |
| `batch_incomplete` | 409 | Batch is still running; rollup unavailable |
| `internal_error` | 500 | Server error (unclassified) |

---

## Quota Interaction

Quota enforcement happens at **batch creation time**, not file-by-file.

**Pre-flight check (on `POST /api/batches`):**

When `isHosted=true` (hosted mode), the server calls `quotas.check()` with:
- `userId`: Current user ID (from `req.user`).
- `addingCount`: The `count` field from the request body.
- `addingBytes`: Estimated total bytes (not available at batch creation; assume 0 for the pre-flight).
- Config: Loaded from `cloud/server/lib/quotas.js`.

**Quota limits checked:**
1. **Concurrent jobs:** `store.getUserJobsAggregate(userId).concurrent + addingCount <= QUOTA_CONCURRENT_JOBS`
2. **Daily uploads:** `store.getUserJobsAggregate(userId).uploadsLast24h + addingCount <= QUOTA_UPLOADS_PER_DAY`
3. **Stored bytes:** (0-byte estimate at batch time; individual file checks happen at upload time).

**Response on rejection:**

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Quota exceeded: concurrent jobs (2 active, limit 2)",
    "reason": "concurrent",
    "limit": 2,
    "current": 2
  }
}
```

**Per-file quota check (on `POST /api/batches/:id/files`):**

Before enqueuing each job, `quotas.check()` is called again with:
- `addingBytes`: Size of this single file.
- `addingCount`: 1 (one job per file).

If rejected at file-level (e.g., file is 2 GB and the storage quota is exhausted), the response is HTTP 429 with the same error shape. The file is NOT written to disk. The batch remains `active` and can accept other files.

**Aggregate quota:** Quota is enforced **per user**, not per batch. A user cannot have more than `QUOTA_CONCURRENT_JOBS` active (pending or running) jobs across all batches. Daily and storage quotas are also per-user.

---

## Persistence

The bulk audit API uses one pre-existing column and adds two new tables.

**Pre-existing (since migration `0002_jobs_batch_id.sql`):**
- `jobs.batch_id TEXT` — nullable; partial index `jobs_batch_id` covers `WHERE batch_id IS NOT NULL`.
- Store helpers `createJob({ ..., batchId })` and `listBatchSnapshots(batchId, filter)` are already wired across `cloud/server/store/sqlite.js` and `cloud/server/store/postgres.js`.

**New tables added by `0006_batches.sql` (this work):**

### batches table

```sql
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,                          -- UUID
  user_id TEXT,                                 -- FK to user (NULL in local mode)
  engagement_id TEXT NOT NULL,                  -- e.g., "eng_abc123"
  label TEXT,                                   -- optional user-provided label
  status TEXT NOT NULL,                         -- 'active' | 'complete' | 'error'
  created_at INTEGER NOT NULL,                  -- milliseconds since epoch
  completed_at INTEGER,                         -- NULL until batch is complete
  error TEXT,                                   -- NULL unless status='error'
  metadata_json TEXT                            -- reserved for future use (e.g., user options)
);

CREATE INDEX IF NOT EXISTS batches_user_id_created_at_desc ON batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS batches_engagement_id ON batches (engagement_id);
```

**Postgres variant:** Use `TIMESTAMPTZ` instead of `INTEGER` for timestamps. Use `JSONB` for `metadata_json`.

---

### batch_files table

```sql
CREATE TABLE IF NOT EXISTS batch_files (
  id TEXT PRIMARY KEY,                          -- UUID
  batch_id TEXT NOT NULL,                       -- FK to batches(id)
  job_id TEXT NOT NULL,                         -- FK to jobs(id)
  filename TEXT NOT NULL,                       -- original filename (e.g., "course-1.zip")
  sha256 TEXT NOT NULL,                         -- hex hash of file content (idempotency key)
  created_at INTEGER NOT NULL,                  -- milliseconds since epoch
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (batch_id, sha256, filename)           -- idempotency key
);

CREATE INDEX IF NOT EXISTS batch_files_batch_id ON batch_files (batch_id);
CREATE INDEX IF NOT EXISTS batch_files_job_id ON batch_files (job_id);
```

**Postgres variant:** Same structure; use `TIMESTAMPTZ` for `created_at` in the migration.

---

## Migration from Legacy

The legacy `POST /api/audits/batch` endpoint is **deleted** in Phase 1 (no deprecation window).

**For clients calling the old endpoint:**

If a request arrives at `POST /api/audits/batch`, the route handler returns:

```
HTTP 410 Gone

{
  "error": {
    "code": "endpoint_removed",
    "message": "POST /api/audits/batch is no longer available. Use the new bulk audit API: POST /api/batches (create batch) followed by POST /api/batches/:id/files (upload files). See cloud/docs/BULK_AUDIT_PLAN.md.",
    "learnMore": "https://internal.skillloop.local/audit-bulk-api"
  }
}
```

The frontend must be updated in the same release. The old batch-upload flow in `cloud/public/app.js` (lines 214–249) is replaced with the new multi-step flow.

---

## Open Implementation Questions

**None.** All architectural decisions are locked in BULK_AUDIT_PLAN.md. The contract above is complete and executable by Phase 1 slices.

---

## Appendix A — Migration SQL (sqlite & postgres)

### SQLite (cloud/server/store/migrations/sqlite/0006_batches.sql)

```sql
-- Phase 8: Bulk audit batch and batch_files tables (SQLite).

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  engagement_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS batches_user_id_created_at_desc ON batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS batches_engagement_id ON batches (engagement_id);

CREATE TABLE IF NOT EXISTS batch_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (batch_id, sha256, filename)
);

CREATE INDEX IF NOT EXISTS batch_files_batch_id ON batch_files (batch_id);
CREATE INDEX IF NOT EXISTS batch_files_job_id ON batch_files (job_id);
```

### Postgres (cloud/server/store/migrations/postgres/0006_batches.sql)

```sql
-- Phase 8: Bulk audit batch and batch_files tables (Postgres).

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  engagement_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error TEXT,
  metadata_json JSONB
);

CREATE INDEX IF NOT EXISTS batches_user_id_created_at_desc ON batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS batches_engagement_id ON batches (engagement_id);

CREATE TABLE IF NOT EXISTS batch_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (batch_id, sha256, filename)
);

CREATE INDEX IF NOT EXISTS batch_files_batch_id ON batch_files (batch_id);
CREATE INDEX IF NOT EXISTS batch_files_job_id ON batch_files (job_id);
```

---

## Appendix B — Response Code Matrix

Quick reference for all HTTP status codes used:

| Code | Meaning | Endpoints |
|------|---------|-----------|
| 200 | OK (idempotent replay) | `POST /api/batches/:id/files` (retry-after-success) |
| 202 | Accepted (file uploaded, job enqueued) | `POST /api/batches` (success), `POST /api/batches/:id/files` (first upload) |
| 400 | Bad request | `POST /api/batches` / `POST /api/batches/:id/files` (missing fields) |
| 401 | Unauthorized | All endpoints (hosted mode, no auth token) |
| 403 | Forbidden | All endpoints (CSRF failed) |
| 404 | Not found | `GET /api/batches/:id`, `GET /api/batches/:id/events`, `GET /api/batches/:id/rollup.*` |
| 409 | Conflict | `POST /api/batches/:id/files` (batch not active), `GET /api/batches/:id/rollup.*` (batch incomplete) |
| 413 | Payload too large | `POST /api/batches` (count > 50), `POST /api/batches/:id/files` (file > 1 GB) |
| 429 | Too many requests | `POST /api/batches`, `POST /api/batches/:id/files` (quota exceeded) |
| 500 | Internal server error | All endpoints (unclassified server error) |


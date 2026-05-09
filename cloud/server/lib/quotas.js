/**
 * Per-user upload quotas (Phase 9C).
 *
 * Three independent limits, each readable from env at boot:
 *   QUOTA_CONCURRENT_JOBS    (default 100)
 *   QUOTA_UPLOADS_PER_DAY    (default 500)
 *   QUOTA_STORED_BYTES       (default 5 GiB = 5368709120)
 *
 * Hosted mode applies them on POST /api/audits, POST /api/batches, and
 * POST /api/batches/:id/files. Local mode bypasses (single-tenant; nothing
 * to bound).
 *
 * The 429 response body includes a stable `reason` string ('concurrent' /
 * 'daily' / 'storage') so the SPA can show a useful message and the smoke
 * test can assert the right limit fired.
 *
 * Note on the 'concurrent' semantic: it counts jobs in pending or running
 * state, not just running. A batch of 50 files registers 50 'concurrent'
 * jobs even though WORKER_CONCURRENCY (default 1) means only one runs at a
 * time. Defaults below give 2× MAX_BATCH_COUNT (50) and 10× headroom on
 * daily uploads so a single batch doesn't immediately trip the limit.
 * Operators with multi-batch workloads should raise QUOTA_CONCURRENT_JOBS
 * accordingly via Coolify env (or whatever orchestration is in use).
 */

const DEFAULT_CONCURRENT = 100;
const DEFAULT_UPLOADS_PER_DAY = 500;
const DEFAULT_STORED_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

function readQuotaConfig() {
  const num = (raw, def) => {
    if (raw === undefined || raw === null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return def;
    return n;
  };
  return {
    concurrent: num(process.env.QUOTA_CONCURRENT_JOBS, DEFAULT_CONCURRENT),
    uploadsPerDay: num(process.env.QUOTA_UPLOADS_PER_DAY, DEFAULT_UPLOADS_PER_DAY),
    storedBytes: num(process.env.QUOTA_STORED_BYTES, DEFAULT_STORED_BYTES),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.store        - SqliteStore | PostgresStore
 * @param {string} opts.userId       - REQUIRED in hosted mode.
 * @param {number} [opts.addingBytes] - bytes about to be uploaded (counts
 *                                       toward the storage check). For batch
 *                                       uploads, sum of all files.
 * @param {number} [opts.addingCount] - jobs about to be created (counts
 *                                       toward concurrent + daily). Default 1.
 * @param {object} [opts.config]      - override env-derived config (tests).
 */
async function check({ store, userId, addingBytes, addingCount, config }) {
  if (!userId) return { allowed: true };
  const cfg = config || readQuotaConfig();
  const agg = await store.getUserJobsAggregate(userId);
  const newJobs = Number.isFinite(addingCount) ? addingCount : 1;
  const newBytes = Number.isFinite(addingBytes) ? addingBytes : 0;

  if (agg.concurrent + newJobs > cfg.concurrent) {
    return {
      allowed: false,
      reason: 'concurrent',
      limit: cfg.concurrent,
      current: agg.concurrent,
    };
  }
  if (agg.uploadsLast24h + newJobs > cfg.uploadsPerDay) {
    return {
      allowed: false,
      reason: 'daily',
      limit: cfg.uploadsPerDay,
      current: agg.uploadsLast24h,
    };
  }
  if (cfg.storedBytes > 0 && agg.storedBytes + newBytes > cfg.storedBytes) {
    return {
      allowed: false,
      reason: 'storage',
      limit: cfg.storedBytes,
      current: agg.storedBytes,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Phase 12: rebuild quota
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENT_REBUILDS = 1;

/**
 * Enforce the per-user rebuild concurrency limit.
 *
 * Reads `QUOTA_CONCURRENT_REBUILDS` env (default 1). Counts the user's
 * in-flight rebuild jobs (status pending|running, kind='rebuild') via
 * `store.getUserRebuildAggregate()`. Throws `QuotaError` if at cap.
 *
 * Pattern mirrors `assertConcurrentJobsAllowed` but is a standalone function
 * to keep the audit quota path unchanged and avoid a coupled refactor.
 *
 * @param {object} store   - SqliteStore | PostgresStore
 * @param {string} userId  - required; the current authenticated user's id.
 * @throws {QuotaError} when the user is at or over the rebuild cap.
 */
async function assertRebuildAllowed(store, userId) {
  if (!userId) return; // no-auth local mode — no limit
  const raw = process.env.QUOTA_CONCURRENT_REBUILDS;
  const cap = (raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0)
    ? Number(raw)
    : DEFAULT_CONCURRENT_REBUILDS;

  if (typeof store.getUserRebuildAggregate !== 'function') {
    // Store adapter predates Phase 12 migration — skip (defensive).
    return;
  }
  const agg = await store.getUserRebuildAggregate(userId);
  if (agg.concurrentRebuilds >= cap) {
    const err = new Error(`Rebuild quota exceeded: max ${cap} in-flight rebuild(s) per user`);
    err.code = 'QUOTA_REBUILD_CONCURRENT';
    err.limit = cap;
    err.current = agg.concurrentRebuilds;
    throw err;
  }
}

module.exports = {
  check,
  readQuotaConfig,
  assertRebuildAllowed,
  DEFAULT_CONCURRENT,
  DEFAULT_UPLOADS_PER_DAY,
  DEFAULT_STORED_BYTES,
  DEFAULT_CONCURRENT_REBUILDS,
};

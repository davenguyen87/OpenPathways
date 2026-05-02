/**
 * Per-user upload quotas (Phase 9C).
 *
 * Three independent limits, each readable from env at boot:
 *   QUOTA_CONCURRENT_JOBS    (default 2)
 *   QUOTA_UPLOADS_PER_DAY    (default 50)
 *   QUOTA_STORED_BYTES       (default 5 GiB = 5368709120)
 *
 * Hosted mode applies them on POST /api/audits and POST /api/audits/batch.
 * Local mode bypasses (single-tenant; nothing to bound).
 *
 * The 429 response body includes a stable `reason` string ('concurrent' /
 * 'daily' / 'storage') so the SPA can show a useful message and the smoke
 * test can assert the right limit fired.
 */

const DEFAULT_CONCURRENT = 2;
const DEFAULT_UPLOADS_PER_DAY = 50;
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

module.exports = { check, readQuotaConfig, DEFAULT_CONCURRENT, DEFAULT_UPLOADS_PER_DAY, DEFAULT_STORED_BYTES };

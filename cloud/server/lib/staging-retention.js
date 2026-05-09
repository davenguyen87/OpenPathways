/**
 * Staging retention worker.
 *
 * Finds rebuild jobs with status='staged' that are older than retentionDays
 * (by created_at) and:
 *   1. Calls clearStaging(jobId) on the staging storage to remove artifacts.
 *   2. Updates the job row to status='expired'.
 *
 * This prevents stale staging directories from accumulating indefinitely when
 * a consultant abandons a full-tier rebuild without approving or rejecting it.
 *
 * The default retention window is 7 days (configurable via the PRISM_STAGING_RETENTION_DAYS
 * env var or the retentionDays option).
 *
 * Designed to be scheduled hourly from cloud/worker/index.js via pg-boss, or
 * called directly as a one-shot function.
 *
 * @example
 *   const { runStagingRetention } = require('./staging-retention');
 *   await runStagingRetention({ store, storage, log: console.log });
 */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Run one sweep of the staging retention policy.
 *
 * @param {object} opts
 * @param {object} opts.store         - store adapter (must expose listStagedOlderThan or
 *                                      an equivalent; falls back to a raw getJob scan
 *                                      when the method is absent)
 * @param {object} opts.storage       - base storage adapter
 * @param {object} [opts.staging]     - StagingStorage adapter; created from storage if absent
 * @param {function} [opts.log]       - logger function (defaults to console.log)
 * @param {number} [opts.retentionDays=7]
 * @returns {Promise<{ expired: string[], errors: string[] }>}
 */
async function runStagingRetention({ store, storage, staging: stagingParam, log, retentionDays } = {}) {
  if (!store) throw new Error('runStagingRetention: store is required');

  const doLog = typeof log === 'function' ? log : (msg) => console.log(`[staging-retention] ${JSON.stringify(msg)}`);
  const days = Number.isFinite(retentionDays) ? retentionDays : (() => {
    const raw = process.env.PRISM_STAGING_RETENTION_DAYS;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 7;
  })();

  const cutoffMs = Date.now() - days * DAY_MS;

  // Retrieve staged jobs older than the cutoff.
  let stagedJobs;
  try {
    // Prefer a dedicated store method if Agent #28 added it; fall back to
    // a generic query via the store's SQL interface.
    if (typeof store.listStagedOlderThan === 'function') {
      stagedJobs = await store.listStagedOlderThan(cutoffMs);
    } else {
      // Fallback: use the store's underlying db (sqlite) or pg client.
      // We query for jobs with status='staged' and created_at < cutoffMs.
      stagedJobs = await _fallbackListStaged(store, cutoffMs);
    }
  } catch (err) {
    doLog({ msg: 'staging-retention: store query failed', err: err.message });
    return { expired: [], errors: [err.message] };
  }

  if (!Array.isArray(stagedJobs) || stagedJobs.length === 0) {
    doLog({ msg: 'staging-retention: no expired staged jobs found' });
    return { expired: [], errors: [] };
  }

  doLog({ msg: 'staging-retention: found expired staged jobs', count: stagedJobs.length });

  // Lazily create the staging adapter if not injected.
  let stagingAdapter = stagingParam;
  if (!stagingAdapter && storage) {
    const { createStagingFromStorage } = require('../storage/staging');
    stagingAdapter = createStagingFromStorage(storage, { retentionDays: days });
  }

  const expired = [];
  const errors = [];

  for (const job of stagedJobs) {
    const jobId = job.id || job.jobId;
    if (!jobId) continue;

    try {
      // Clear staging artifacts.
      if (stagingAdapter) {
        await stagingAdapter.clearStaging(jobId);
      }

      // Update job status to 'expired'.
      await store.updateJob(jobId, {
        status: 'expired',
        finishedAt: Date.now(),
        error: `Staging expired after ${days} days without promotion`,
      });

      doLog({ msg: 'staging-retention: expired job', jobId, createdAt: job.createdAt || job.created_at });
      expired.push(jobId);
    } catch (err) {
      doLog({ msg: 'staging-retention: failed to expire job', jobId, err: err.message });
      errors.push(`${jobId}: ${err.message}`);
    }
  }

  doLog({ msg: 'staging-retention: sweep complete', expired: expired.length, errors: errors.length });
  return { expired, errors };
}

/**
 * Fallback implementation for stores that don't expose listStagedOlderThan.
 * Uses the store's db/pg handle directly if available (sqlite), or falls back
 * to a full scan via listSnapshots (expensive but correct).
 *
 * @param {object} store
 * @param {number} cutoffMs
 * @returns {Promise<Array<{id: string, createdAt: number}>>}
 */
async function _fallbackListStaged(store, cutoffMs) {
  // SQLite path: access db directly.
  if (store.db && typeof store.db.prepare === 'function') {
    const rows = store.db
      .prepare(
        `SELECT id, created_at, kind FROM jobs
          WHERE status = 'staged' AND created_at < ?`
      )
      .all(cutoffMs);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      kind: r.kind || 'rebuild',
    }));
  }

  // Postgres path: access pool directly.
  if (store.pool && typeof store.pool.query === 'function') {
    const result = await store.pool.query(
      `SELECT id, created_at, kind FROM jobs WHERE status = 'staged' AND created_at < $1`,
      [new Date(cutoffMs)]
    );
    return (result.rows || []).map((r) => ({
      id: r.id,
      createdAt: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at),
      kind: r.kind || 'rebuild',
    }));
  }

  // Last resort: listSnapshots with a large cap and filter in JS.
  // This is O(N) but is only reached if neither db nor pool is accessible.
  const all = await store.listSnapshots(10000);
  return all.filter((j) => {
    const createdAt = typeof j.createdAt === 'number' ? j.createdAt : 0;
    return j.status === 'staged' && createdAt < cutoffMs;
  });
}

module.exports = { runStagingRetention };

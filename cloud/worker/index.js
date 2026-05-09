#!/usr/bin/env node

/**
 * Prism Cloud — worker process (Phase 9C scaffolding, Phase 10
 * end-to-end).
 *
 * Subscribes to the pg-boss runAudit queue and executes audit() against
 * the same store + storage the web container uses. Same Docker image,
 * different command:
 *
 *   web:    node cloud/server/index.js
 *   worker: node cloud/worker/index.js
 *
 * Boot:
 *   1. Validate env (mode=hosted, DATABASE_URL set, WORKER_QUEUE=pgboss).
 *   2. Init store + storage.
 *   3. Construct a JobManager-like runner that pulls a job by id, runs
 *      audit(), and persists results through the existing store API.
 *   4. Start the pg-boss subscriber.
 *
 * SIGINT/SIGTERM: stop the queue gracefully, drain in-flight runs, exit.
 *
 * Concurrency: one job per worker process by default; scale by running
 * multiple worker containers. WORKER_CONCURRENCY env caps in-process
 * parallel jobs (default 1; the roadmap recommends 3 on an 8 GB box).
 */

const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const modeLib = require('../server/lib/mode');
const { createStore } = require('../server/store');
const { createStorage } = require('../server/storage');
const { JobManager } = require('../server/job-manager');
const { createQueue } = require('../server/lib/queue');
const { runStagingRetention } = require('../server/lib/staging-retention');
const { audit } = require('../../src/index');
const { rebuild } = require('../../src/rebuild/index');
const { resolveLlmConfig, injectLlmConfigForCall } = require('../server/lib/llm-key-resolver');
const { recordRebuildLlmUsage } = require('../server/lib/llm-usage-recorder');

async function main() {
  // Validate the same env the web container does.
  let config;
  try { config = modeLib.validate(); }
  catch (err) { console.error(err.message); process.exit(2); }

  if (!config.isHosted) {
    console.error('Worker requires PRISM_MODE=hosted.');
    process.exit(2);
  }
  if ((process.env.WORKER_QUEUE || '').toLowerCase() !== 'pgboss' &&
      (process.env.WORKER_QUEUE || '').toLowerCase() !== 'pg-boss') {
    console.error('Worker requires WORKER_QUEUE=pgboss.');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Worker requires DATABASE_URL.');
    process.exit(2);
  }

  const concurrency = (() => {
    const raw = process.env.WORKER_CONCURRENCY;
    if (!raw) return 1;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();

  // Phase 12: rebuild runs in a separate bounded pool (heavier than audit).
  const rebuildConcurrency = (() => {
    const raw = process.env.WORKER_REBUILD_CONCURRENCY;
    if (!raw) return 2;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  })();

  console.log(`Prism Cloud worker (concurrency=${concurrency}, rebuildConcurrency=${rebuildConcurrency})`);

  const store = createStore();
  await store.init();
  const storage = createStorage();
  await storage.init();

  // We reuse the JobManager for its persistence + cancellation logic by
  // creating a manager that talks to the store; we then call its runner
  // for each dequeued jobId (the queue replaces JobManager's _tick).
  const jobs = new JobManager({
    store,
    log: (entry) => console.log(`[worker job-manager] ${JSON.stringify(entry)}`),
  });
  jobs.setRunner(async (hot, emit) => {
    return audit(hot.uploadPath, {
      ...hot.options,
      packagePath: hot.uploadPath,
      onProgress: (ev) => emit(ev),
      signal: hot.signal,
    });
  });

  // Phase 12: a second JobManager for rebuild jobs. Separate instance so
  // concurrency caps are independently enforced. Both managers share the
  // same store (and therefore the same DB-backed job rows).
  const rebuildJobs = new JobManager({
    store,
    concurrency: rebuildConcurrency,
    log: (entry) => console.log(`[worker rebuild-manager] ${JSON.stringify(entry)}`),
  });

  rebuildJobs.setRunner(async (hot, emit) => {
    const mode = (hot.options && hot.options.mode) || 'safe';
    const noCheckpoint = !!(hot.options && hot.options.noCheckpoint);
    const llmUserId = (hot.options && hot.options.llmUserId) || null;

    // Load parent audit job's violations to drive the rebuild engine.
    const parentJobId = hot.parentJobId;
    let auditResults = null;
    if (parentJobId) {
      const parentRow = await store.getJob(parentJobId);
      if (parentRow && parentRow.result) {
        auditResults = parentRow.result;
      }
    }

    if (!auditResults) {
      emit({ stage: 'warn', message: 'Parent audit results unavailable; proceeding with empty violations list' });
      auditResults = { violations: [] };
    }

    // Dedicated output dir so rebuilt zip survives next to the original
    // upload and participates in the same retention cycle.
    const outputDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), `prism-rebuild-out-`)
    );

    emit({ stage: 'rebuild:start', mode });

    // Resolve the per-workspace LLM config at dispatch time (not stored in the
    // job options to avoid persisting the plaintext key in the DB).
    const resolvedLlm = await resolveLlmConfig(store, llmUserId).catch(() => null);
    const injected = injectLlmConfigForCall(resolvedLlm);

    let result;
    try {
      result = await rebuild(hot.uploadPath, auditResults, {
        mode,
        noCheckpoint,
        outputDir,
        engagementId: hot.id,
        packageName: hot.originalName || path.basename(hot.uploadPath || 'package.zip'),
        // Use per-workspace resolved LLM config (falls back to server env via resolveLlmConfig).
        llmProvider: injected.llmProvider,
        llmKeyFromEnv: injected.llmKeyFromEnv,
        llmModel: injected.llmModel,
        // AbortSignal for cooperative cancellation.
        signal: hot.signal,
      });
    } finally {
      injected._restore();
    }

    emit({ stage: 'rebuild:done', mode });

    // Record LLM usage telemetry (non-fatal if it fails).
    if (llmUserId && result && result.manifest) {
      await recordRebuildLlmUsage({
        userId: llmUserId,
        store,
        manifest: result.manifest,
      }).catch((err) => {
        console.warn(`[worker] recordRebuildLlmUsage failed: ${err.message}`);
      });
    }

    const isStagedResult = !!(result && result.stagingDir);
    return {
      kind: 'rebuild',
      mode,
      // Flag full-tier staged output so UI shows "Promote" instead of download.
      staging: isStagedResult,
      stagingDir: (result && result.stagingDir) || null,
      rebuiltZipPath: (result && result.rebuiltZipPath) || null,
      stagedZipPath: (result && result.stagedZipPath) || null,
      manifest: (result && result.manifest) || null,
    };
  });

  // The worker's runJob: pull the job into the hot cache, push it onto the
  // queue, and wait for _tick to drain. Concurrency is enforced by capping
  // the queue subscription's batch size.
  const runJob = async (jobId) => {
    const hot = await jobs.get(jobId);
    if (!hot) {
      console.warn(`[worker] runAudit: job ${jobId} not in store`);
      return;
    }
    if (hot.status !== 'pending') {
      console.warn(`[worker] runAudit: job ${jobId} status=${hot.status}, skipping`);
      return;
    }
    // Re-enqueue into the JobManager's internal queue and let _tick run it.
    jobs.queue.push(jobId);
    queueMicrotask(() => jobs._tick());
    // Resolve immediately; pg-boss considers the message handled. Real
    // completion is observed via the persisted row.
  };

  // Phase 12: rebuild job dispatcher.
  const runRebuildJob = async (jobId) => {
    const hot = await rebuildJobs.get(jobId);
    if (!hot) {
      console.warn(`[worker] runRebuild: job ${jobId} not in store`);
      return;
    }
    if (hot.status !== 'pending') {
      console.warn(`[worker] runRebuild: job ${jobId} status=${hot.status}, skipping`);
      return;
    }
    rebuildJobs.queue.push(jobId);
    queueMicrotask(() => rebuildJobs._tick());
  };

  const queue = createQueue({ runJob, runRebuildJob });
  await queue.start();
  console.log(`worker subscribed to ${queue.driver()}`);

  // ----- Staging retention (Phase 12): runs hourly via pg-boss schedule -----
  // When pg-boss is active, register a recurring cron job that sweeps expired
  // staged rebuild jobs. Falls back to a plain setInterval on in-process queue.
  const stagingRetentionLog = (entry) =>
    console.log(`[staging-retention] ${JSON.stringify(entry)}`);

  const stagingRetentionDays = (() => {
    const raw = process.env.PRISM_STAGING_RETENTION_DAYS;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 7;
  })();

  const runStagingRetentionSweep = () =>
    runStagingRetention({
      store,
      storage,
      log: stagingRetentionLog,
      retentionDays: stagingRetentionDays,
    }).catch((err) => {
      console.warn(`[staging-retention] sweep failed: ${err.message}`);
    });

  if (queue.driver() === 'pg-boss' && queue.boss) {
    // Schedule via pg-boss so the sweep survives restarts and only runs on
    // one worker at a time even when multiple workers are active.
    try {
      await queue.boss.schedule('stagingRetention', '0 * * * *', {});
      queue.boss.work('stagingRetention', async () => {
        await runStagingRetentionSweep();
      });
      console.log('worker: staging retention scheduled via pg-boss (hourly)');
    } catch (err) {
      console.warn(`[staging-retention] pg-boss schedule failed, falling back to setInterval: ${err.message}`);
      const stagingTimer = setInterval(runStagingRetentionSweep, 60 * 60 * 1000);
      stagingTimer.unref && stagingTimer.unref();
    }
  } else {
    // In-process queue (local dev): use setInterval.
    const stagingTimer = setInterval(runStagingRetentionSweep, 60 * 60 * 1000);
    stagingTimer.unref && stagingTimer.unref();
    console.log('worker: staging retention scheduled via setInterval (hourly)');
  }

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    try { await queue.stop(); } catch (_) {}
    try { await jobs.drainAll(); } catch (_) {}
    // Phase 12: drain rebuild jobs manager too.
    try { await rebuildJobs.drainAll(); } catch (_) {}
    try { await store.close(); } catch (_) {}
    try { await storage.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Worker fatal: ${err.stack || err.message || err}`);
    process.exit(1);
  });
}

module.exports = { main };

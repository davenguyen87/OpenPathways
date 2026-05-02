#!/usr/bin/env node

/**
 * Open Pathways Cloud — worker process (Phase 9C scaffolding, Phase 10
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

const modeLib = require('../server/lib/mode');
const { createStore } = require('../server/store');
const { createStorage } = require('../server/storage');
const { JobManager } = require('../server/job-manager');
const { createQueue } = require('../server/lib/queue');
const { audit } = require('../../src/index');

async function main() {
  // Validate the same env the web container does.
  let config;
  try { config = modeLib.validate(); }
  catch (err) { console.error(err.message); process.exit(2); }

  if (!config.isHosted) {
    console.error('Worker requires OPEN_PATHWAYS_MODE=hosted.');
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

  console.log(`Open Pathways Cloud worker (concurrency=${concurrency})`);

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

  const queue = createQueue({ runJob });
  await queue.start();
  console.log(`worker subscribed to ${queue.driver()}`);

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    try { await queue.stop(); } catch (_) {}
    try { await jobs.drainAll(); } catch (_) {}
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

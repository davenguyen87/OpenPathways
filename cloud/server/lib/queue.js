/**
 * Job queue abstraction (Phase 9C).
 *
 * Two implementations:
 *
 *   InProcessQueue  — default. enqueue() is a no-op; the JobManager's
 *                     internal _tick is the runner. Phase 5–9B behavior.
 *
 *   PgBossQueue     — opt-in via WORKER_QUEUE=pgboss + DATABASE_URL.
 *                     enqueue() publishes a runAudit message to pg-boss;
 *                     a separate cloud/worker/index.js process consumes
 *                     and runs audit() against the same store. Same Docker
 *                     image, different command. The web container does NOT
 *                     run audits in-process when this queue is in use.
 *
 * The web container constructs the queue once at boot and threads it to
 * the JobManager. JobManager.create() calls queue.enqueue() after the
 * row is persisted; the in-process queue's no-op preserves the original
 * code path (JobManager._tick handles execution).
 *
 * Phase 9C ships the scaffolding only — pg-boss is exercised end-to-end
 * in Phase 10 alongside docker-compose Postgres.
 */

const QUEUE_NAME = 'runAudit';
// Phase 12: second queue for rebuild jobs. Separate from runAudit so the
// worker can apply independent concurrency caps (WORKER_REBUILD_CONCURRENCY).
const REBUILD_QUEUE_NAME = 'runRebuild';

class InProcessQueue {
  driver() { return 'in-process'; }
  async start() { /* no-op */ }
  async stop() { /* no-op */ }
  async enqueue(_jobId) { /* JobManager._tick handles it */ }
  // Phase 12: rebuild jobs also use in-process dispatch.
  async enqueueRebuild(_jobId) { /* JobManager._tick handles it */ }
}

class PgBossQueue {
  /**
   * @param {object} opts
   * @param {string} opts.connectionString - Postgres URL.
   * @param {function} opts.runJob - async (jobId) => void (worker side only).
   *                                  Web side passes a noop; the worker passes
   *                                  the real audit-execution closure.
   */
  constructor({ connectionString, runJob, runRebuildJob }) {
    if (!connectionString) throw new Error('PgBossQueue: connectionString is required');
    this.connectionString = connectionString;
    this.runJob = runJob || null;
    // Phase 12: rebuild queue subscriber (worker side only).
    this.runRebuildJob = runRebuildJob || null;
    this.boss = null;
  }

  driver() { return 'pg-boss'; }

  async start() {
    // Lazy-require so the dep is only loaded when this queue is actually
    // selected. Phase 9C local dev (sqlite) never instantiates PgBossQueue.
    const PgBoss = require('pg-boss');
    this.boss = new PgBoss({ connectionString: this.connectionString });
    this.boss.on('error', (err) => {
      // best-effort log; the caller already has its own logger
      console.error(`[pg-boss] ${err && err.message}`);
    });
    await this.boss.start();

    // Subscribers attach when this queue is on the worker side.
    if (typeof this.runJob === 'function') {
      await this.boss.work(QUEUE_NAME, async (job) => {
        const data = job && job.data;
        if (data && data.jobId) {
          await this.runJob(data.jobId);
        }
      });
    }

    // Phase 12: rebuild subscriber. runRebuildJob is passed by the worker;
    // the web container passes null so it never dequeues rebuild messages.
    if (typeof this.runRebuildJob === 'function') {
      await this.boss.work(REBUILD_QUEUE_NAME, async (job) => {
        const data = job && job.data;
        if (data && data.jobId) {
          await this.runRebuildJob(data.jobId);
        }
      });
    }
  }

  async stop() {
    if (this.boss) {
      try { await this.boss.stop({ graceful: true, timeout: 5000 }); } catch (_) {}
      this.boss = null;
    }
  }

  async enqueue(jobId) {
    if (!this.boss) throw new Error('PgBossQueue: not started');
    await this.boss.send(QUEUE_NAME, { jobId });
  }

  // Phase 12: enqueue a rebuild job to the separate runRebuild queue.
  async enqueueRebuild(jobId) {
    if (!this.boss) throw new Error('PgBossQueue: not started');
    await this.boss.send(REBUILD_QUEUE_NAME, { jobId });
  }
}

function createQueue({ runJob, runRebuildJob } = {}) {
  const driver = (process.env.WORKER_QUEUE || 'inprocess').toLowerCase();
  if (driver === 'pgboss' || driver === 'pg-boss') {
    return new PgBossQueue({
      connectionString: process.env.DATABASE_URL,
      runJob,
      runRebuildJob,
    });
  }
  return new InProcessQueue();
}

module.exports = { createQueue, InProcessQueue, PgBossQueue, QUEUE_NAME, REBUILD_QUEUE_NAME };

/**
 * Store-backed job lifecycle for audit runs (Phase 5).
 *
 * The store (SQLite or Postgres) is the source of truth. The in-memory
 * `Map<jobId, hot>` is a write-through cache for jobs that are currently
 * pending/running, plus their live SSE subscribers. Terminal jobs (done /
 * error / cancelled) are loaded lazily from the store on demand and dropped
 * from the cache shortly after.
 *
 * Job row shape (caller-visible — see cloud/server/store/sqlite.js):
 *   { id, status, options, originalName, uploadPath,
 *     createdAt, startedAt, finishedAt,
 *     error, result, progress }
 *
 * Status transitions: pending → running → done | error | cancelled.
 *
 * Concurrency: serialized via a FIFO queue. One job runs at a time. (Phase 9
 * replaces this with pg-boss for hosted mode.)
 *
 * Persistence cadence:
 *   - createJob, status transitions, terminal events: written immediately.
 *   - progress events: appended to in-memory progress[], persisted to
 *     `progress_json` on a ~1s debounced timer plus immediately on every
 *     status transition and on shutdown.
 *
 * Restart semantics (Phase 5):
 *   - On boot the server calls `store.markInterrupted()` *before*
 *     constructing the JobManager — any pending/running rows are flipped to
 *     `error` with a stable reason. The JobManager itself starts with an
 *     empty hot cache and trusts the store.
 *
 * Cancellation (Phase 6):
 *   - Each hot job carries an AbortController. The runner reads
 *     `hot.signal` and threads it into `audit()`. cancel() calls
 *     `controller.abort()` synchronously before doing anything else, so
 *     the runner detects the abort at its next checkpoint (typically
 *     within 1 second even mid-Playwright). The catch block treats
 *     err.name === 'AbortError' as a cancellation regardless of the
 *     current status, so a race between `controller.abort()` and the
 *     status flip can't accidentally produce status='error'.
 */

const crypto = require('crypto');
const fs = require('fs').promises;

const PROGRESS_FLUSH_MS = 1000;

class JobManager {
  /**
   * @param {object} opts
   * @param {object} opts.store - SqliteStore | PostgresStore instance.
   * @param {function} [opts.runner] - (job, emit) => Promise<result>
   * @param {function} [opts.log] - structured logger; defaults to no-op.
   * @param {number} [opts.concurrency] - max concurrent workers (default: 1, read from WORKER_CONCURRENCY env var).
   */
  constructor({ store, runner, log, concurrency } = {}) {
    if (!store) throw new Error('JobManager: store is required');
    this.store = store;
    this.runner = runner || null;
    this.log = log || (() => {});

    // Bounded worker pool: default 1 to match CLI's serial behavior.
    // Configurable via WORKER_CONCURRENCY env var or constructor option.
    const concurrencyFromEnv = process.env.WORKER_CONCURRENCY
      ? parseInt(process.env.WORKER_CONCURRENCY, 10)
      : null;
    this.maxConcurrency = concurrency !== undefined ? concurrency : (concurrencyFromEnv || 1);
    if (this.maxConcurrency < 1) {
      throw new Error('JobManager: concurrency must be >= 1');
    }

    /** @type {Map<string, object>} hot cache for active jobs */
    this.hot = new Map();
    /** @type {string[]} FIFO of pending job IDs awaiting their turn */
    this.queue = [];
    /** @type {Set<string>} jobIds currently running */
    this.running = new Set();
    this.shuttingDown = false;
  }

  setRunner(runner) {
    this.runner = runner;
  }

  // --------------------------------------------------------------------
  // Hot-cache helpers
  // --------------------------------------------------------------------

  _newHot(row) {
    // Each hot job gets its own AbortController. Lazy: hydrated terminal
    // jobs get a controller too (cheap; never aborted). Active jobs use
    // controller.signal to drive cooperative cancellation in audit().
    const controller = new AbortController();
    return {
      // mirror of store row
      id: row.id,
      status: row.status,
      options: row.options || {},
      originalName: row.originalName,
      uploadPath: row.uploadPath,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
      result: row.result || null,
      progress: row.progress || [],
      batchId: row.batchId || null,
      userId: row.userId || null,
      // live state — never persisted
      subscribers: new Set(),
      flushTimer: null,
      progressDirty: false,
      controller,
      get signal() { return controller.signal; },
    };
  }

  _scheduleProgressFlush(hot) {
    if (this.shuttingDown) {
      // Drain immediately; we're heading for the exit.
      return this._flushProgress(hot);
    }
    if (hot.flushTimer) return;
    hot.progressDirty = true;
    hot.flushTimer = setTimeout(() => {
      hot.flushTimer = null;
      this._flushProgress(hot).catch((err) => {
        this.log({ msg: 'progress flush failed', jobId: hot.id, err: err.message });
      });
    }, PROGRESS_FLUSH_MS);
    hot.flushTimer.unref && hot.flushTimer.unref();
  }

  async _flushProgress(hot) {
    if (!hot.progressDirty) return;
    hot.progressDirty = false;
    try {
      await this.store.updateJob(hot.id, { progress: hot.progress });
    } catch (err) {
      // Re-mark dirty so the next tick or shutdown drain retries.
      hot.progressDirty = true;
      throw err;
    }
  }

  /**
   * Drain pending in-memory progress writes for every hot job.
   * Called from server shutdown handler before server.close().
   */
  async drainAll() {
    this.shuttingDown = true;
    const tasks = [];
    for (const hot of this.hot.values()) {
      if (hot.flushTimer) {
        clearTimeout(hot.flushTimer);
        hot.flushTimer = null;
      }
      tasks.push(this._flushProgress(hot).catch((err) => {
        this.log({ msg: 'drain flush failed', jobId: hot.id, err: err.message });
      }));
    }
    await Promise.all(tasks);
  }

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  /**
   * Create a new job. Persists immediately, returns the in-memory hot record.
   * Pass `batchId` to associate this job with a multi-file batch upload.
   * Pass `userId` (Phase 9B) to record ownership; required in hosted mode.
   */
  async create({ uploadPath, options, originalName, batchId, userId }) {
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    await this.store.createJob({
      id,
      status: 'pending',
      options: options || {},
      originalName: originalName || null,
      uploadPath,
      createdAt,
      batchId: batchId || null,
      userId: userId || null,
    });

    const hot = this._newHot({
      id,
      status: 'pending',
      options: options || {},
      originalName: originalName || null,
      uploadPath,
      createdAt,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      progress: [],
      batchId: batchId || null,
      userId: userId || null,
    });
    this.hot.set(id, hot);
    this.queue.push(id);
    queueMicrotask(() => this._tick());
    return hot;
  }

  /**
   * Phase 8: list all jobs in a batch. `filter.userId` narrows to a single
   * user (Phase 9B); pass undefined for no filter.
   */
  async listBatchSnapshots(batchId, filter) {
    const rows = await this.store.listBatchSnapshots(batchId, filter);
    return rows.map((row) => this._snapshot(this._rowSnapshotShape(row)));
  }

  /**
   * Get a job by id. Returns the hot record if cached, otherwise lazy-loads
   * from the store and caches briefly. Returns null if the row doesn't exist
   * — or, when filter.userId is set, doesn't belong to that user.
   *
   * @param {string} id
   * @param {object} [filter] - { userId } for ownership check.
   */
  async get(id, filter) {
    const cached = this.hot.get(id);
    if (cached) {
      if (filter && filter.userId !== undefined && cached.userId !== filter.userId) {
        return null;
      }
      return cached;
    }
    const row = await this.store.getJob(id, filter);
    if (!row) return null;
    const hot = this._newHot(row);
    this.hot.set(id, hot);
    return hot;
  }

  /**
   * Snapshot for /api/audits/:id. Async because get() may lazy-load.
   */
  async snapshot(id, filter) {
    const hot = await this.get(id, filter);
    return hot ? this._snapshot(hot) : null;
  }

  /**
   * Most-recent-first list straight from the store. Bypasses the cache by
   * design — we want history including jobs we've never loaded.
   * `filter.userId`: same semantics as the underlying store call.
   */
  async listSnapshots(limit = 50, filter) {
    const rows = await this.store.listSnapshots(limit, filter);
    return rows.map((row) => this._snapshot(this._rowSnapshotShape(row)));
  }

  /**
   * Build a snapshot from a bare store row (used by listSnapshots so we
   * don't have to materialize a full hot record per row).
   */
  _rowSnapshotShape(row) {
    return {
      id: row.id,
      status: row.status,
      options: row.options || {},
      originalName: row.originalName,
      uploadPath: row.uploadPath,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
      result: row.result || null,
      progress: row.progress || [],
      batchId: row.batchId || null,
      userId: row.userId || null,
    };
  }

  _snapshot(job) {
    return {
      id: job.id,
      status: job.status,
      options: job.options,
      originalName: job.originalName
        || (job.uploadPath ? job.uploadPath.split(/[\\/]/).pop() : null),
      batchId: job.batchId || null,
      userId: job.userId || null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // progress array may not be in memory for hydrated jobs that were
      // loaded by listSnapshots — defensive ?? []
      progressCount: (job.progress || []).length,
      lastEvent: (job.progress && job.progress[job.progress.length - 1]) || null,
      error: job.error,
      summary: job.result
        ? {
            packageType: job.result.packageType,
            score: job.result.scorecard && job.result.scorecard.score,
            passed: job.result.scorecard && job.result.scorecard.passed,
            totalViolations:
              job.result.scorecard && job.result.scorecard.totalViolations,
            complete: job.result.complete,
            incompleteReason: job.result.incompleteReason,
          }
        : null,
    };
  }

  /**
   * Subscribe to a job's event stream. Replays buffered progress (loaded
   * lazily from store if not in cache), then either delivers a terminal
   * event immediately (and unsubscribes) or attaches as a live subscriber.
   *
   * Returns an unsubscribe function. Returns null if the job doesn't exist.
   */
  async subscribe(id, onEvent) {
    const hot = await this.get(id);
    if (!hot) return null;

    // Replay backlog.
    for (const ev of hot.progress) {
      try { onEvent(ev); } catch (_) { /* keep going */ }
    }

    if (hot.status === 'done') {
      try { onEvent({ stage: '__done__', summary: this._snapshot(hot).summary }); } catch (_) {}
      return () => {};
    }
    if (hot.status === 'error') {
      try { onEvent({ stage: '__error__', error: hot.error }); } catch (_) {}
      return () => {};
    }
    if (hot.status === 'cancelled') {
      try { onEvent({ stage: '__cancelled__' }); } catch (_) {}
      return () => {};
    }

    hot.subscribers.add(onEvent);
    return () => hot.subscribers.delete(onEvent);
  }

  _emit(hot, ev) {
    hot.progress.push(ev);
    for (const sub of hot.subscribers) {
      try { sub(ev); } catch (_) { /* ignore subscriber errors */ }
    }
    this._scheduleProgressFlush(hot);
  }

  // --------------------------------------------------------------------
  // Runner loop (bounded worker pool)
  // --------------------------------------------------------------------

  async _tick() {
    // Try to fill available worker slots from the pending queue.
    // Keep calling until no more slots available or no more pending jobs.
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      const nextId = this.queue.shift();
      if (!nextId) return;

      const hot = this.hot.get(nextId);
      if (!hot) return this._tick(); // shouldn't happen, but recursively continue

      // Mark this job as running and start execution
      this.running.add(hot.id);
      hot.status = 'running';
      hot.startedAt = Date.now();

      try {
        await this.store.updateJob(hot.id, { status: 'running', startedAt: hot.startedAt });
      } catch (err) {
        this.log({ msg: 'failed to mark running', jobId: hot.id, err: err.message });
      }

      // Launch the worker asynchronously (fire-and-forget from this microtask).
      // Each worker gets its own async execution context. Errors are caught in the worker.
      this._runWorker(hot).catch((err) => {
        // Failsafe: if _runWorker throws uncaught, log and clean up.
        this.log({ msg: 'worker crashed', jobId: hot.id, err: err && err.message });
        this.running.delete(hot.id);
        queueMicrotask(() => this._tick());
      });
    }
  }

  /**
   * Execute a single job in a worker context.
   * Called asynchronously by _tick. Handles the entire job lifecycle:
   * success, error, and cancellation. Removes itself from running set
   * when done and triggers _tick to pick up the next pending job.
   */
  async _runWorker(hot) {
    try {
      const result = await this.runner(hot, (ev) => {
        if (hot.status === 'cancelled') return; // user moved on
        this._emit(hot, ev);
      });

      if (hot.status === 'cancelled') {
        // already terminal (user cancelled while this worker was running)
      } else {
        hot.result = result;
        hot.status = 'done';
        hot.finishedAt = Date.now();
        // Drain pending progress before persisting result so the row is
        // self-consistent on disk.
        if (hot.flushTimer) { clearTimeout(hot.flushTimer); hot.flushTimer = null; }
        await this._flushProgress(hot).catch(() => {});
        await this.store.updateJob(hot.id, {
          status: 'done',
          finishedAt: hot.finishedAt,
          result,
          progress: hot.progress,
        }).catch((err) => {
          this.log({ msg: 'failed to persist done', jobId: hot.id, err: err.message });
        });
        const terminal = { stage: '__done__', summary: this._snapshot(hot).summary };
        for (const sub of hot.subscribers) {
          try { sub(terminal); } catch (_) {}
        }
        hot.subscribers.clear();
      }
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      if (hot.status === 'cancelled' || isAbort) {
        // Either cancel() already flipped the row, or audit() detected the
        // abort before cancel() finished its async work. Either way the
        // user wanted this gone — make sure the DB reflects 'cancelled'
        // and don't clobber it with 'error'.
        if (hot.status !== 'cancelled') {
          hot.status = 'cancelled';
          hot.finishedAt = Date.now();
          hot.error = 'Cancelled by user';
          if (hot.flushTimer) { clearTimeout(hot.flushTimer); hot.flushTimer = null; }
          await this._flushProgress(hot).catch(() => {});
          await this.store.updateJob(hot.id, {
            status: 'cancelled',
            finishedAt: hot.finishedAt,
            error: hot.error,
            progress: hot.progress,
          }).catch((err2) => {
            this.log({ msg: 'failed to persist cancel-from-abort', jobId: hot.id, err: err2.message });
          });
          const terminal = { stage: '__cancelled__' };
          for (const sub of hot.subscribers) {
            try { sub(terminal); } catch (_) {}
          }
          hot.subscribers.clear();
        }
      } else {
        hot.error = err && err.message ? err.message : String(err);
        hot.status = 'error';
        hot.finishedAt = Date.now();
        if (hot.flushTimer) { clearTimeout(hot.flushTimer); hot.flushTimer = null; }
        await this._flushProgress(hot).catch(() => {});
        await this.store.updateJob(hot.id, {
          status: 'error',
          finishedAt: hot.finishedAt,
          error: hot.error,
          progress: hot.progress,
        }).catch((err2) => {
          this.log({ msg: 'failed to persist error', jobId: hot.id, err: err2.message });
        });
        const terminal = { stage: '__error__', error: hot.error };
        for (const sub of hot.subscribers) {
          try { sub(terminal); } catch (_) {}
        }
        hot.subscribers.clear();
      }
    } finally {
      // Worker finished. Remove from running set and try to schedule the next job.
      this.running.delete(hot.id);
      queueMicrotask(() => this._tick());
    }
  }

  /**
   * Real cancel (Phase 6). Aborts the AbortController synchronously, then
   * marks status='cancelled' in memory + DB, notifies subscribers. The
   * runner sees signal.aborted at its next checkpoint and rejects with an
   * AbortError; the catch block already special-cases that.
   */
  async cancel(id) {
    const hot = await this.get(id);
    if (!hot) return false;
    if (['done', 'error', 'cancelled'].includes(hot.status)) return false;

    // Abort first — synchronous, immediate. The runner's next checkpoint
    // throws AbortError; the dynamic runner closes Playwright eagerly.
    try { hot.controller.abort(); } catch (_) {}

    hot.status = 'cancelled';
    hot.finishedAt = Date.now();
    hot.error = 'Cancelled by user';

    if (hot.flushTimer) { clearTimeout(hot.flushTimer); hot.flushTimer = null; }
    await this._flushProgress(hot).catch(() => {});
    await this.store.updateJob(hot.id, {
      status: 'cancelled',
      finishedAt: hot.finishedAt,
      error: hot.error,
      progress: hot.progress,
    }).catch((err) => {
      this.log({ msg: 'failed to persist cancel', jobId: hot.id, err: err.message });
    });

    const terminal = { stage: '__cancelled__' };
    for (const sub of hot.subscribers) {
      try { sub(terminal); } catch (_) {}
    }
    hot.subscribers.clear();
    return true;
  }
}

module.exports = { JobManager, PROGRESS_FLUSH_MS };

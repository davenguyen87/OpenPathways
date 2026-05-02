/**
 * In-memory job lifecycle for audit runs.
 *
 * No persistence — restart the server, jobs are gone. That is intentional
 * for v1 (see PLAN.md). Each job:
 *
 *   {
 *     id, status, options, uploadPath,
 *     progress: [event, ...],   // append-only buffer for SSE replay
 *     result, error,
 *     createdAt, startedAt, finishedAt,
 *     subscribers: Set<onEvent>,
 *     controller: AbortController,
 *   }
 *
 * Status transitions: pending → running → done | error | cancelled.
 *
 * Concurrency: serialized via a FIFO queue. One job runs at a time. PLAN.md
 * lists this as the deliberate default, easy to lift later if needed.
 *
 * Cancellation (Phase 6 — real, not best-effort)
 * ----------------------------------------------
 * Each job carries an AbortController. The runner reads `job.signal` and
 * threads it into `audit()` from `../../src`, which checks the signal at
 * coarse boundaries and closes the Playwright browser eagerly when it
 * fires. cancel() aborts the controller synchronously before flipping
 * status, and the catch block treats err.name === 'AbortError' as a
 * cancellation (race-safe). This replaces the prior /web option-(b) cancel
 * — the upgrade comes for free because the abort plumbing lives in /src.
 */

const crypto = require('crypto');
const fs = require('fs').promises;

const CLEANUP_DELAY_MS = 10 * 60 * 1000; // 10 minutes after completion

class JobManager {
  constructor({ runner } = {}) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {string[]} FIFO of pending job IDs awaiting their turn */
    this.queue = [];
    this.activeId = null;
    /** Function that actually runs a job: (job, emit) => Promise<result> */
    this.runner = runner;
  }

  setRunner(runner) {
    this.runner = runner;
  }

  create({ uploadPath, options, originalName }) {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const job = {
      id,
      status: 'pending',
      options,
      uploadPath,
      originalName: originalName || null,
      progress: [],
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      subscribers: new Set(),
      cleanupTimer: null,
      controller,
      get signal() { return controller.signal; },
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    queueMicrotask(() => this._tick());
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    // Most recent first — the recent-audits panel reads this directly.
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this._snapshot(j));
  }

  /** Public summary (omits subscribers, cleanupTimer). */
  snapshot(id) {
    const job = this.jobs.get(id);
    return job ? this._snapshot(job) : null;
  }

  _snapshot(job) {
    return {
      id: job.id,
      status: job.status,
      options: job.options,
      // Original filename from the upload (sanitized below). Falls back to
      // the on-disk leaf if absent. The full server path is never exposed.
      originalName: job.originalName
        || (job.uploadPath ? job.uploadPath.split(/[\\/]/).pop() : null),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progressCount: job.progress.length,
      lastEvent: job.progress[job.progress.length - 1] || null,
      error: job.error,
      // Only expose lightweight result fields here. Full payload lives in
      // job.result and is delivered via the report endpoints.
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
   * Subscribe to a job's event stream. Returns an unsubscribe function.
   *
   * The new subscriber is immediately replayed any buffered progress events.
   * If the job is already terminal, the terminal event is emitted and the
   * subscriber is unsubscribed by the caller (the SSE handler closes the
   * stream after a 'done' or 'error').
   */
  subscribe(id, onEvent) {
    const job = this.jobs.get(id);
    if (!job) return null;

    // Replay backlog first.
    for (const ev of job.progress) {
      try { onEvent(ev); } catch (_) { /* subscriber bug — keep going */ }
    }

    // If already terminal, deliver the terminal event and don't keep a ref.
    if (job.status === 'done') {
      try { onEvent({ stage: '__done__', summary: this._snapshot(job).summary }); } catch (_) {}
      return () => {};
    }
    if (job.status === 'error') {
      try { onEvent({ stage: '__error__', error: job.error }); } catch (_) {}
      return () => {};
    }
    if (job.status === 'cancelled') {
      try { onEvent({ stage: '__cancelled__' }); } catch (_) {}
      return () => {};
    }

    job.subscribers.add(onEvent);
    return () => job.subscribers.delete(onEvent);
  }

  _emit(job, ev) {
    job.progress.push(ev);
    for (const sub of job.subscribers) {
      try { sub(ev); } catch (_) { /* ignore subscriber errors */ }
    }
  }

  async _tick() {
    if (this.activeId) return; // already running
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job) return this._tick();

    this.activeId = job.id;
    job.status = 'running';
    job.startedAt = Date.now();

    try {
      const result = await this.runner(job, (ev) => {
        // Drop progress events that arrive after a cancel — the SSE stream
        // is already closed and the user has moved on.
        if (job.status === 'cancelled') return;
        this._emit(job, ev);
      });
      // If the user cancelled while audit() was still running, the result is
      // discarded — the job stays in 'cancelled' state.
      if (job.status === 'cancelled') {
        // already terminal; nothing to do
      } else {
        job.result = result;
        job.status = 'done';
        job.finishedAt = Date.now();
        const terminal = { stage: '__done__', summary: this._snapshot(job).summary };
        for (const sub of job.subscribers) {
          try { sub(terminal); } catch (_) {}
        }
        job.subscribers.clear();
      }
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      if (job.status === 'cancelled') {
        // already terminal — cancel() flipped state before the abort
        // propagated. Nothing to do.
      } else if (isAbort) {
        // Abort fired but cancel()'s status flip hasn't happened yet (or
        // the signal was aborted by some other path). Mark cancelled now
        // so we don't accidentally surface the AbortError as 'error'.
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        job.error = 'Cancelled by user';
        const terminal = { stage: '__cancelled__' };
        for (const sub of job.subscribers) {
          try { sub(terminal); } catch (_) {}
        }
        job.subscribers.clear();
      } else {
        job.error = err && err.message ? err.message : String(err);
        job.status = 'error';
        job.finishedAt = Date.now();
        const terminal = { stage: '__error__', error: job.error };
        for (const sub of job.subscribers) {
          try { sub(terminal); } catch (_) {}
        }
        job.subscribers.clear();
      }
    } finally {
      this.activeId = null;
      this._scheduleCleanup(job);
      // Run the next queued job, if any.
      queueMicrotask(() => this._tick());
    }
  }

  /**
   * Real cancel (Phase 6). Aborts the controller synchronously so audit()
   * picks up the cancel at its next checkpoint (or sooner — the dynamic
   * runner closes Playwright eagerly on the abort). Then flips status,
   * notifies subscribers, schedules cleanup. Net effect: stop within ~1
   * second even mid-Playwright.
   *
   * Returns true if cancelled, false if the job is already terminal.
   */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      return false;
    }
    // Abort first — synchronous, immediate.
    try { job.controller.abort(); } catch (_) {}
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.error = 'Cancelled by user';
    const terminal = { stage: '__cancelled__' };
    for (const sub of job.subscribers) {
      try { sub(terminal); } catch (_) {}
    }
    job.subscribers.clear();
    this._scheduleCleanup(job);
    return true;
  }

  _scheduleCleanup(job) {
    if (job.cleanupTimer) return;
    job.cleanupTimer = setTimeout(async () => {
      try {
        if (job.uploadPath) {
          await fs.unlink(job.uploadPath).catch(() => {});
        }
      } finally {
        this.jobs.delete(job.id);
      }
    }, CLEANUP_DELAY_MS);
    job.cleanupTimer.unref();
  }
}

module.exports = { JobManager, CLEANUP_DELAY_MS };

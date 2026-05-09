/**
 * Rebuild job routes (Phase 12).
 *
 *   POST /api/jobs/:id/rebuild       Trigger a rebuild from a completed audit.
 *   GET  /api/rebuilds/:id           Snapshot.
 *   GET  /api/rebuilds/:id/events    Server-Sent Events stream.
 *
 * Relationship to the audit router:
 *   - Rebuild jobs share the same jobs table and JobManager as audit jobs.
 *     They are differentiated by `kind='rebuild'` and `parent_job_id`.
 *   - The parent audit job must be terminal (status='done') and owned by the
 *     same user. The rebuild job copies the parent's `upload_path` so the
 *     worker has the original .zip to operate on.
 *   - In hosted mode: requireAuth on every route; csrfProtect on POST.
 *
 * Worker contract:
 *   - When the worker dequeues a 'rebuild' job it calls:
 *       rebuild(uploadPath, auditResults, { mode, ... })
 *     from src/rebuild/index.js. The audit results are loaded from the parent
 *     job's result_json in the store.
 *   - For full-tier rebuilds that use the checkpoint gate, `result.staging`
 *     is true and the UI surfaces a "Promote" action instead of a download
 *     link. The staging path is persisted in `result_json`.
 */

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const quotas = require('../lib/quotas');
const { resolveLlmConfig } = require('../lib/llm-key-resolver');

const VALID_MODES = new Set(['safe', 'assisted', 'full']);

/**
 * @param {object} deps
 * @param {object} deps.jobs          - JobManager instance.
 * @param {object} [deps.config]      - { isHosted, mode } from lib/mode.validate().
 * @param {function} [deps.requireAuth] - middleware that 401s when req.user missing.
 * @param {function} [deps.csrfProtect] - csrf-csrf doubleCsrfProtection.
 * @param {object} [deps.store]       - SqliteStore | PostgresStore.
 * @param {object} [deps.queue]       - queue adapter (for pg-boss enqueueRebuild).
 */
function createRebuildRouter({ jobs, config, requireAuth, csrfProtect, store, queue }) {
  if (!jobs) throw new Error('createRebuildRouter: jobs (JobManager) is required');
  const isHosted = !!(config && config.isHosted);
  const authDisabled = !requireAuth;

  const ownerFilter = (req) => {
    if (!isHosted || authDisabled) return undefined;
    return { userId: req.user.id };
  };

  const auth = isHosted && requireAuth ? [requireAuth] : [];
  const csrf = isHosted && csrfProtect ? [csrfProtect] : [];

  // Rate limiters — only active in hosted mode. Mirror the express-rate-limit
  // pattern from routes/auth.js. In local mode the arrays stay empty.
  // POST /api/jobs/:id/rebuild — 10 rebuild triggers per user per minute.
  const rebuildLimiter = isHosted ? [rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user && req.user.id) || req.ip,
    message: { error: 'Too many rebuild requests. Try again in a minute.' },
  })] : [];

  const router = express.Router();

  // ------------------------------------------------------------------
  // POST /api/jobs/:id/rebuild
  //
  // Body: { mode: 'safe'|'assisted'|'full', noCheckpoint?: boolean }
  //
  // 1. Load parent audit job — must be done + owned by caller.
  // 2. Validate mode.
  // 3. Enforce rebuild quota.
  // 4. Create a rebuild job (kind='rebuild', parent_job_id=:id, same uploadPath).
  // 5. Enqueue to runRebuild queue (or in-process _tick).
  // Returns 202 { jobId }.
  // ------------------------------------------------------------------
  router.post('/jobs/:id/rebuild', ...rebuildLimiter, ...auth, ...csrf, express.json(), async (req, res) => {
    const parentId = req.params.id;

    // --- Load parent job (ownership check included) ---
    let parentHot;
    try {
      parentHot = await jobs.get(parentId, ownerFilter(req));
    } catch (err) {
      return res.status(500).json({ error: `Lookup failed: ${err.message}` });
    }
    if (!parentHot) {
      return res.status(404).json({ error: 'Parent audit job not found' });
    }
    if (parentHot.status !== 'done') {
      return res.status(409).json({
        error: `Parent job is not complete (status: ${parentHot.status}). Run the audit to completion before rebuilding.`,
      });
    }

    // --- Validate mode ---
    // When mode is explicitly provided, validate it. When absent (undefined /
    // null), default to 'safe'. An explicitly provided empty string is rejected
    // so clients don't silently get the default.
    const rawMode = req.body && req.body.mode;
    const modeProvided = rawMode !== undefined && rawMode !== null;
    const mode = modeProvided ? String(rawMode).trim() : 'safe';
    if (modeProvided && !VALID_MODES.has(mode)) {
      return res.status(400).json({
        error: `Invalid rebuild mode '${mode}'. Must be one of: safe, assisted, full.`,
      });
    }
    const noCheckpoint = !!(req.body && req.body.noCheckpoint);

    // --- Rebuild quota (hosted mode only) ---
    const userId = req.user ? req.user.id : null;
    if (isHosted && store) {
      try {
        await quotas.assertRebuildAllowed(store, userId || '__no_user__');
      } catch (err) {
        return res.status(429).json({
          error: err.message,
          code: err.code || 'QUOTA_REBUILD_CONCURRENT',
          limit: err.limit,
          current: err.current,
        });
      }
    }

    // --- Resolve LLM config for this user ---
    // Persist the provider/model (but NOT the API key — that is re-resolved at
    // worker dispatch time by reading from the store again). Store llmUserId so
    // the worker knows whose key to look up.
    let resolvedLlmProvider = null;
    let resolvedLlmModel = null;
    if (store) {
      try {
        const resolvedLlm = await resolveLlmConfig(store, userId);
        if (resolvedLlm) {
          resolvedLlmProvider = resolvedLlm.provider;
          resolvedLlmModel = resolvedLlm.model;
        }
      } catch (_) {
        // Non-fatal: LLM features just won't activate for this job.
      }
    }

    // --- Create rebuild job ---
    let hot;
    try {
      const id = crypto.randomUUID();
      const createdAt = Date.now();

      // Persist directly through the store so we can supply the extra columns
      // (kind, parentJobId, mode) that JobManager.create() doesn't expose yet.
      // Then load it into the hot cache so the JobManager can run it via _tick.
      await store.createJob({
        id,
        status: 'pending',
        options: {
          mode,
          noCheckpoint,
          // Resolved provider/model (no key — re-resolved at worker dispatch).
          // llmUserId lets the worker look up the right workspace key at runtime.
          llmProvider: resolvedLlmProvider,
          llmKeyFromEnv: null,   // intentionally blank — set by worker via resolveLlmConfig
          llmModel: resolvedLlmModel,
          llmUserId: userId || null,
        },
        originalName: parentHot.originalName
          ? `${parentHot.originalName.replace(/\.zip$/i, '')}.rebuilt.zip`
          : 'rebuilt.zip',
        uploadPath: parentHot.uploadPath,
        createdAt,
        batchId: null,
        userId: userId || null,
        uploadBytes: null,
        kind: 'rebuild',
        parentJobId: parentId,
        mode,
      });

      // Hydrate into the hot cache so subscribe() / get() work without a
      // round-trip through the store on the immediate SSE poll.
      const row = await store.getJob(id);
      hot = jobs._newHot(row);
      jobs.hot.set(id, hot);

      // Enqueue: in-process mode → push to _tick; pg-boss → enqueueRebuild().
      if (queue && typeof queue.enqueueRebuild === 'function') {
        await queue.enqueueRebuild(id);
      } else {
        // In-process: push onto the JobManager's internal queue so _tick picks
        // it up. The runner set on jobs must handle rebuild jobs (see worker/).
        jobs.queue.push(id);
        queueMicrotask(() => jobs._tick());
      }
    } catch (err) {
      return res.status(500).json({ error: `Failed to create rebuild job: ${err.message}` });
    }

    res.status(202).json({ jobId: hot.id });
  });

  // ------------------------------------------------------------------
  // GET /api/rebuilds/:id — snapshot
  // ------------------------------------------------------------------
  router.get('/rebuilds/:id', ...auth, async (req, res) => {
    try {
      const snap = await jobs.snapshot(req.params.id, ownerFilter(req));
      if (!snap) return res.status(404).json({ error: 'Rebuild job not found' });
      // Verify it's actually a rebuild job when we have kind information.
      const hot = await jobs.get(req.params.id, ownerFilter(req));
      if (hot && hot.kind && hot.kind !== 'rebuild') {
        return res.status(404).json({ error: 'Job is not a rebuild job' });
      }
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: `Failed to fetch rebuild job: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/rebuilds/:id/events — SSE stream (mirrors audit SSE handler)
  // ------------------------------------------------------------------
  router.get('/rebuilds/:id/events', ...auth, async (req, res) => {
    let hot;
    try {
      hot = await jobs.get(req.params.id, ownerFilter(req));
    } catch (err) {
      return res.status(500).json({ error: `Lookup failed: ${err.message}` });
    }
    if (!hot) return res.status(404).json({ error: 'Rebuild job not found' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const writeEvent = (eventName, payload) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let closed = false;
    let unsubscribe = null;
    const closeStream = () => {
      if (closed) return;
      closed = true;
      try { unsubscribe && unsubscribe(); } catch (_) {}
      try { res.end(); } catch (_) {}
    };

    unsubscribe = await jobs.subscribe(req.params.id, (ev) => {
      if (ev && ev.stage === '__done__') {
        writeEvent('done', ev.summary || {});
        closeStream();
      } else if (ev && ev.stage === '__error__') {
        writeEvent('error', { error: ev.error });
        closeStream();
      } else if (ev && ev.stage === '__cancelled__') {
        writeEvent('cancelled', {});
        closeStream();
      } else {
        writeEvent('progress', ev);
      }
    });

    if (!unsubscribe) {
      try { res.status(404).end(); } catch (_) {}
      return;
    }

    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(': heartbeat\n\n');
    }, 15000);
    heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      closeStream();
    });
  });

  return { router };
}

module.exports = { createRebuildRouter };

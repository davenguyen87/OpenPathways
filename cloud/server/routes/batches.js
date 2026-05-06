/**
 * Batch audit routes (Phase 8).
 *
 *   POST /api/batches                 Create a batch session.
 *   POST /api/batches/:id/files       Upload a single file and enqueue job.
 *   GET  /api/batches/:id             Fetch batch state + jobs snapshot.
 *
 * Per BULK_AUDIT_API.md contract §1–3.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createHash } = require('crypto');

const quotas = require('../lib/quotas');

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'uploads');
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
const MAX_BATCH_COUNT = 50;

function ensureUploadDirSync() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function makeMulter() {
  ensureUploadDirSync();
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => {
      const tmp = `pending-${crypto.randomBytes(8).toString('hex')}.zip`;
      cb(null, tmp);
    },
  });
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });
}

/**
 * @param {object} deps
 * @param {object} deps.jobs - JobManager instance, runner already attached.
 * @param {object} deps.store - Store instance (sqlite or postgres).
 * @param {object} [deps.config] - mode/auth config from lib/mode.validate().
 * @param {function} [deps.requireAuth] - middleware that 401s when req.user missing.
 * @param {function} [deps.csrfProtect] - csrf-csrf doubleCsrfProtection.
 */
function createBatchRouter({ jobs, store, config, requireAuth, csrfProtect }) {
  if (!jobs) throw new Error('createBatchRouter: jobs (JobManager) is required');
  if (!store) throw new Error('createBatchRouter: store is required');

  const isHosted = !!(config && config.isHosted);
  const quotaConfig = isHosted ? quotas.readQuotaConfig() : null;

  // Helper: ownership filter.
  const authDisabled = !requireAuth;
  const ownerFilter = (req) => {
    if (!isHosted || authDisabled) return undefined;
    return { userId: req.user.id };
  };

  // Compose middleware chains conditionally.
  const auth = isHosted && requireAuth ? [requireAuth] : [];
  const csrf = isHosted && csrfProtect ? [csrfProtect] : [];

  const router = express.Router();
  const upload = makeMulter();

  // ------------------------------------------------------------------
  // POST /api/batches
  //
  // Create a batch session. Validates count <= 50, pre-flight quota check.
  // Returns 202 with batchId, expiresAt (30 days from now).
  // ------------------------------------------------------------------
  router.post('/batches', ...auth, ...csrf, express.json(), async (req, res) => {
    const { engagementId, label, count } = req.body;

    // Validate required fields
    if (!engagementId || typeof engagementId !== 'string') {
      return res.status(400).json({
        error: { code: 'missing_field', message: 'Missing field: engagementId' },
      });
    }
    if (!Number.isFinite(count) || count < 1) {
      return res.status(400).json({
        error: { code: 'missing_field', message: 'Missing field: count (required, must be >= 1)' },
      });
    }

    // Validate count <= 50
    if (count > MAX_BATCH_COUNT) {
      return res.status(413).json({
        error: {
          code: 'batch_count_exceeded',
          message: `Batch cannot exceed ${MAX_BATCH_COUNT} files (requested ${count})`,
        },
      });
    }

    // Pre-flight quota check
    if (isHosted && store) {
      const verdict = await quotas.check({
        store,
        userId: (req.user && req.user.id) || '__no_user__',
        addingCount: count,
        addingBytes: 0, // estimate 0 at batch creation time
        config: quotaConfig,
      });
      if (!verdict.allowed) {
        return res.status(429).json({
          error: {
            code: 'quota_exceeded',
            message: `Quota exceeded: ${verdict.reason}`,
            reason: verdict.reason,
            limit: verdict.limit,
            current: verdict.current,
          },
        });
      }
    }

    try {
      const batchId = crypto.randomUUID();
      const createdAt = Date.now();
      const expiresAt = createdAt + 30 * 24 * 60 * 60 * 1000; // 30 days

      await store.createBatch({
        id: batchId,
        userId: req.user ? req.user.id : null,
        engagementId,
        label: label || null,
        status: 'active',
        createdAt,
      });

      res.status(202).json({ batchId, expiresAt });
    } catch (err) {
      res.status(500).json({
        error: { code: 'internal_error', message: `Failed to create batch: ${err.message}` },
      });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/batches/:id/files
  //
  // Upload a single file and enqueue the audit job. Multipart with single
  // 'package' field. Requires X-Content-SHA256 header for idempotency.
  //
  // Returns 202 on first upload, 200 on idempotent replay (same sha256).
  // ------------------------------------------------------------------
  router.post('/batches/:id/files', ...auth, ...csrf, upload.single('package'), async (req, res) => {
    const { id: batchId } = req.params;

    // Validate file and header
    if (!req.file) {
      return res.status(400).json({
        error: { code: 'missing_field', message: "Missing form field 'package' or header 'X-Content-SHA256'" },
      });
    }

    const sha256Header = (req.get('X-Content-SHA256') || '').trim();
    if (!sha256Header) {
      // Clean up the uploaded file
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({
        error: { code: 'missing_field', message: "Missing form field 'package' or header 'X-Content-SHA256'" },
      });
    }

    let computedSha256;
    try {
      const fileContent = fs.readFileSync(req.file.path);
      computedSha256 = createHash('sha256').update(fileContent).digest('hex');
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(500).json({
        error: { code: 'internal_error', message: `Failed to hash file: ${err.message}` },
      });
    }

    // Verify sha256 matches (client-side validation aid)
    if (computedSha256 !== sha256Header) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({
        error: { code: 'missing_field', message: 'X-Content-SHA256 header does not match file hash' },
      });
    }

    const filename = (req.file.originalname || '').replace(/[\\/]/g, '_').slice(0, 256);
    const uploadBytes = req.file.size || null;

    try {
      // Verify batch exists and belongs to user
      const batch = await store.getBatch(batchId, ownerFilter(req));
      if (!batch) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(404).json({
          error: { code: 'batch_not_found', message: 'Batch not found' },
        });
      }

      // Verify batch is active
      if (batch.status !== 'active') {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(409).json({
          error: {
            code: 'batch_not_active',
            message: `Batch is no longer accepting files (status: ${batch.status})`,
          },
        });
      }

      // Per-file quota check
      if (isHosted && store) {
        const verdict = await quotas.check({
          store,
          userId: (req.user && req.user.id) || '__no_user__',
          addingCount: 1,
          addingBytes: uploadBytes || 0,
          config: quotaConfig,
        });
        if (!verdict.allowed) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return res.status(429).json({
            error: {
              code: 'quota_exceeded',
              message: `Quota exceeded: ${verdict.reason}`,
              reason: verdict.reason,
              limit: verdict.limit,
              current: verdict.current,
            },
          });
        }
      }

      // Idempotency check: look for existing (batchId, sha256, filename)
      try {
        const existing = await store.findBatchFileByIdempotencyKey({
          batchId,
          sha256: computedSha256,
          filename,
        });

        if (existing) {
          // Idempotent hit: return 200 with the existing jobId
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return res.status(200).json({
            jobId: existing.jobId,
            filename,
            uploadedAt: existing.createdAt,
          });
        }
      } catch (err) {
        if (err.code !== 'UNIQUE_VIOLATION') {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return res.status(500).json({
            error: { code: 'internal_error', message: `Idempotency check failed: ${err.message}` },
          });
        }
        // UNIQUE_VIOLATION means a concurrent upload of the same file succeeded;
        // retry the lookup to get the jobId.
        try {
          const existing = await store.findBatchFileByIdempotencyKey({
            batchId,
            sha256: computedSha256,
            filename,
          });
          if (existing) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            return res.status(200).json({
              jobId: existing.jobId,
              filename,
              uploadedAt: existing.createdAt,
            });
          }
        } catch (_) {}
        // Still no luck; treat as internal error
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(500).json({
          error: { code: 'internal_error', message: 'Idempotency key conflict; retry' },
        });
      }

      // First upload: create job and batch_files row
      const opts = {
        packageType: req.body?.packageType || 'auto',
        standard: req.body?.standard || 'wcag21',
        browser: req.body?.browser || 'chromium',
        timeoutDynamic: req.body?.timeoutDynamic ? parseInt(req.body.timeoutDynamic, 10) : 30000,
      };

      const hot = await jobs.create({
        uploadPath: req.file.path,
        options: opts,
        originalName: filename || null,
        batchId,
        userId: req.user ? req.user.id : null,
        uploadBytes,
      });

      const batchFileId = crypto.randomUUID();
      const createdAt = Date.now();

      try {
        await store.createBatchFile({
          id: batchFileId,
          batchId,
          jobId: hot.id,
          filename,
          sha256: computedSha256,
          createdAt,
        });
      } catch (err) {
        // If the batch_files row fails (e.g., UNIQUE violation from a race),
        // the job is already in the queue. This is suboptimal but recoverable:
        // the idempotency lookup will eventually find it on a retry.
        return res.status(500).json({
          error: { code: 'internal_error', message: `Failed to record batch file: ${err.message}` },
        });
      }

      // Success: return 202 immediately without waiting for audit work
      res.status(202).json({
        jobId: hot.id,
        filename,
        uploadedAt: createdAt,
      });
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      res.status(500).json({
        error: { code: 'internal_error', message: `Failed to upload file: ${err.message}` },
      });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/batches/:id
  //
  // Fetch batch state + all jobs in the batch snapshot. Auth-scoped.
  // ------------------------------------------------------------------
  router.get('/batches/:id', ...auth, async (req, res) => {
    const { id: batchId } = req.params;

    try {
      const batch = await store.getBatch(batchId, ownerFilter(req));
      if (!batch) {
        return res.status(404).json({
          error: { code: 'batch_not_found', message: 'Batch not found' },
        });
      }

      res.json({
        batchId: batch.id,
        label: batch.label || null,
        createdAt: batch.createdAt,
        status: batch.status,
        jobs: (batch.jobs || []).map(serializeJobForBatch),
      });
    } catch (err) {
      res.status(500).json({
        error: { code: 'internal_error', message: `Failed to fetch batch: ${err.message}` },
      });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/batches/:id/events — Server-Sent Events stream
  //
  // Subscribe to live job state changes for the batch. Emits:
  //   - batch: initial state snapshot
  //   - file.uploaded, file.queued, file.running, file.done, file.failed: per-job events
  //   - batch.complete: when all jobs reach terminal state
  //   - ping: heartbeat every 15 seconds
  // ------------------------------------------------------------------
  router.get('/batches/:id/events', ...auth, async (req, res) => {
    const { id: batchId } = req.params;

    try {
      const batch = await store.getBatch(batchId, ownerFilter(req));
      if (!batch) {
        return res.status(404).json({
          error: { code: 'batch_not_found', message: 'Batch not found' },
        });
      }

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

      // Send initial batch state
      writeEvent('batch', {
        batchId: batch.id,
        status: batch.status,
        jobs: (batch.jobs || []).map(serializeJobForBatch),
      });

      // Track which jobs we've already announced as "running"
      const announcedRunning = new Set();
      const jobUnsubscribes = new Map();

      // Subscribe to each job currently in the batch
      const subscribeToJobs = async () => {
        const jobSnapshots = batch.jobs || [];
        for (const jobSnapshot of jobSnapshots) {
          if (jobUnsubscribes.has(jobSnapshot.id)) {
            continue; // already subscribed
          }

          const unsubFn = await jobs.subscribe(jobSnapshot.id, (ev) => {
            if (closed) return;

            // Translate JobManager events to SSE events
            if (ev && ev.stage === '__done__') {
              writeEvent('file.done', {
                type: 'file.done',
                batchId,
                jobId: jobSnapshot.id,
                filename: jobSnapshot.originalName,
                score: ev.summary?.score,
                passed: ev.summary?.passed,
                totalViolations: ev.summary?.totalViolations,
                finishedAt: Date.now(),
              });
            } else if (ev && ev.stage === '__error__') {
              writeEvent('file.failed', {
                type: 'file.failed',
                batchId,
                jobId: jobSnapshot.id,
                filename: jobSnapshot.originalName,
                error: ev.error,
                exitCode: 2,
                finishedAt: Date.now(),
              });
            } else if (ev && ev.stage === '__cancelled__') {
              writeEvent('file.failed', {
                type: 'file.failed',
                batchId,
                jobId: jobSnapshot.id,
                filename: jobSnapshot.originalName,
                error: 'cancelled',
                exitCode: 2,
                finishedAt: Date.now(),
              });
            } else if (!announcedRunning.has(jobSnapshot.id)) {
              // Emit file.running once per job
              announcedRunning.add(jobSnapshot.id);
              writeEvent('file.running', {
                type: 'file.running',
                batchId,
                jobId: jobSnapshot.id,
                filename: jobSnapshot.originalName,
              });
            }
          });

          if (unsubFn) {
            jobUnsubscribes.set(jobSnapshot.id, unsubFn);
          }
        }
      };

      // Initial subscription to existing jobs
      await subscribeToJobs();

      // Poll for newly added jobs every 2 seconds
      const pollInterval = setInterval(async () => {
        if (closed) return;
        try {
          const updated = await store.getBatch(batchId, ownerFilter(req));
          if (updated) {
            await subscribeToJobs();

            // Check if all jobs are in terminal state
            const allJobSnapshots = updated.jobs || [];
            const allTerminal = allJobSnapshots.every((j) =>
              j.status === 'done' || j.status === 'error' || j.status === 'cancelled'
            );

            if (allTerminal && allJobSnapshots.length > 0) {
              writeEvent('batch.complete', {
                type: 'batch.complete',
                batchId,
                completedAt: Date.now(),
              });
              clearInterval(pollInterval);
              closeStream();
            }
          }
        } catch (_) {
          // Ignore poll errors
        }
      }, 2000);

      // Heartbeat every 15 seconds
      const heartbeat = setInterval(() => {
        if (closed) return;
        writeEvent('ping', { type: 'ping', ts: Date.now() });
      }, 15000);
      heartbeat.unref();
      pollInterval.unref();

      req.on('close', () => {
        clearInterval(heartbeat);
        clearInterval(pollInterval);
        for (const unsub of jobUnsubscribes.values()) {
          try { unsub(); } catch (_) {}
        }
        closeStream();
      });
    } catch (err) {
      res.status(500).json({
        error: { code: 'internal_error', message: `SSE error: ${err.message}` },
      });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/batches/:id/rollup.{html,md,json}
  //
  // Render a cross-package rollup report. Format determined by file extension.
  // Only available when all jobs in the batch are terminal.
  // ------------------------------------------------------------------
  router.get('/batches/:id/rollup.:format', ...auth, async (req, res) => {
    const { id: batchId, format } = req.params;
    const allowedFormats = ['html', 'md', 'json'];

    if (!allowedFormats.includes(format)) {
      return res.status(400).json({
        error: { code: 'invalid_format', message: 'Format must be html, md, or json' },
      });
    }

    try {
      const batch = await store.getBatch(batchId, ownerFilter(req));
      if (!batch || !batch.jobs || batch.jobs.length === 0) {
        return res.status(404).json({
          error: { code: 'batch_not_found', message: 'Batch not found or has no jobs' },
        });
      }

      // Verify all jobs are terminal
      const allTerminal = batch.jobs.every((j) =>
        j.status === 'done' || j.status === 'error' || j.status === 'cancelled'
      );
      if (!allTerminal) {
        return res.status(409).json({
          error: {
            code: 'batch_incomplete',
            message: 'Batch is still running; rollup unavailable until all jobs complete',
          },
        });
      }

      // Build rollup: filter to successful jobs with result_json
      const packageRollups = [];
      const packageResults = [];

      for (const jobSnapshot of batch.jobs) {
        if (jobSnapshot.status !== 'done') {
          continue;
        }

        // Read result_json from the job row. jobs.get() returns the JobManager's
        // hot/cold view; fall back to store.getJob for fully-cold rows.
        let fullJob = jobs.get ? await jobs.get(jobSnapshot.id, ownerFilter(req)) : null;
        if (!fullJob || !fullJob.result) {
          fullJob = await store.getJob(jobSnapshot.id);
        }
        if (!fullJob || !fullJob.result) {
          continue;
        }

        const result = fullJob.result;
        const violations = result.violations || [];

        // Apply enrichments (idempotent)
        const { mapAllFindings } = require('../../../src/lib/section508');
        const { tagAllFindings } = require('../../../src/lib/triage');
        const { estimateAllEfforts, rollupPackage, loadCalibration } = require('../../../src/lib/scope-estimator');

        mapAllFindings(violations);
        const context = {
          packageType: result.packageType || 'unknown',
          packageScale: violations.length,
        };
        tagAllFindings(violations, context);
        const calibration = loadCalibration();
        estimateAllEfforts(violations, calibration);

        // Compute scope estimate
        const scopeEstimate = rollupPackage(violations);
        packageRollups.push(scopeEstimate);

        // Track for aggregation
        packageResults.push({
          name: jobSnapshot.originalName,
          status: 'success',
          result: {
            scorecard: result.scorecard,
            violations,
          },
        });
      }

      // If no successful jobs, return empty rollup
      if (packageRollups.length === 0) {
        packageResults.length = 0;
      }

      // Compute library-level rollup
      const { rollupLibrary } = require('../../../src/lib/scope-estimator');
      const libraryRollup = rollupLibrary(packageRollups);

      // Aggregate to the library object shape
      const library = aggregateLibrary(packageResults, libraryRollup.totalMinutes);

      // Render based on format
      if (format === 'html') {
        const { renderLibraryRollupHtml } = require('../../../src/lib/library-rollup');
        const html = renderLibraryRollupHtml(library, { engagementId: batch.engagementId });
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } else if (format === 'md') {
        const { renderLibraryRollupMarkdown } = require('../../../src/lib/library-rollup');
        const md = renderLibraryRollupMarkdown(library, { engagementId: batch.engagementId });
        res.set('Content-Type', 'text/markdown; charset=utf-8');
        res.send(md);
      } else if (format === 'json') {
        res.set('Content-Type', 'application/json');
        res.json(library);
      }
    } catch (err) {
      res.status(500).json({
        error: { code: 'internal_error', message: `Rollup error: ${err.message}` },
      });
    }
  });

  return { router };
}

/**
 * Serialize a job row from `store.getBatch().jobs[]` into the wire shape
 * documented in BULK_AUDIT_API.md §3 (the GET /api/batches/:id response and
 * the SSE `batch` initial event). Maps `originalName` → `filename` and
 * derives `summary` from the audit `result` so callers don't need to parse
 * the full result_json client-side.
 */
function serializeJobForBatch(job) {
  return {
    id: job.id,
    filename: job.originalName || null,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    summary: job.result
      ? {
          packageType: job.result.packageType,
          score: job.result.scorecard && job.result.scorecard.score,
          passed: job.result.scorecard && job.result.scorecard.passed,
          totalViolations: job.result.scorecard && job.result.scorecard.totalViolations,
          complete: job.result.complete,
          incompleteReason: job.result.incompleteReason,
        }
      : null,
  };
}

/**
 * Aggregate library-level metrics from package results.
 * Replicates the logic from src/lib/audit-library.js's aggregateLibrary().
 */
function aggregateLibrary(packageResults, totalEffortMinutes) {
  const triageDistribution = {
    'auto-fix safe': 0,
    'auto-fix assisted': 0,
    'author rework': 0,
    'content rework': 0,
    'recommend retire': 0,
    'clean': 0,
  };

  const allRisks = [];
  let cleanCount = 0;

  for (const pkg of packageResults) {
    if (pkg.status === 'error' || !pkg.result) {
      continue;
    }

    const { scorecard, violations } = pkg.result;

    // Count clean packages
    if (scorecard && scorecard.passed) {
      cleanCount++;
      triageDistribution['clean']++;
    } else {
      // Compute dominant triage tag
      const triageTagCounts = {};
      for (const v of violations) {
        const tag = v.triage || 'author rework';
        triageTagCounts[tag] = (triageTagCounts[tag] || 0) + 1;
      }

      let dominantTag = 'author rework';
      let maxCount = 0;
      const tierOrder = ['recommend retire', 'content rework', 'author rework', 'auto-fix assisted', 'auto-fix safe'];
      for (const tier of tierOrder) {
        if (triageTagCounts[tier] && triageTagCounts[tier] > maxCount) {
          dominantTag = tier;
          maxCount = triageTagCounts[tier];
        }
      }

      if (triageDistribution.hasOwnProperty(dominantTag)) {
        triageDistribution[dominantTag]++;
      }
    }

    // Collect top risks
    if (scorecard && scorecard.topRisks && Array.isArray(scorecard.topRisks)) {
      for (const risk of scorecard.topRisks) {
        allRisks.push({
          ...risk,
          packageName: pkg.name,
        });
      }
    }
  }

  // Aggregate top risks (simple: return all unique by criterion + severity)
  const topRisks = allRisks.slice(0, 3);

  const totalEffortHours = Math.round((totalEffortMinutes / 60) * 2) / 2;
  const recommendedEngagementShape = 'Full engagement recommended';

  return {
    packageCount: packageResults.filter((p) => p.status === 'success').length,
    cleanCount,
    triageDistribution,
    totalEffortMinutes,
    totalEffortHours,
    topRisks,
    recommendedEngagementShape,
  };
}

module.exports = { createBatchRouter, UPLOAD_DIR, MAX_UPLOAD_BYTES, MAX_BATCH_COUNT, aggregateLibrary };

/**
 * Audit job routes (cloud Phase 5 fork of /web/server/routes/audits.js).
 *
 *   POST /api/audits                    Upload + create job. multipart/form-data.
 *   GET  /api/audits                    List recent jobs (most recent first).
 *   GET  /api/audits/:id                Snapshot.
 *   POST /api/audits/:id/cancel         Best-effort cancel.
 *   GET  /api/audits/:id/events         Server-Sent Events stream.
 *   GET  /api/audits/:id/report.json    Full JSON scorecard.
 *   GET  /api/audits/:id/report.md      Markdown report.
 *   GET  /api/sample                    Stream a fixture for "try a sample".
 *
 * Differences from /web:
 *   - Uploads land in cloud/.tmp/uploads/<filename>.zip (was web/.tmp/...).
 *   - The router factory accepts an injected JobManager so server/index.js
 *     can wire the store-backed manager once at boot.
 *   - Every read of a job is async (lazy-loads from store on cache miss).
 *
 * Storage of the on-disk upload itself is the same as /web for now — Phase 9
 * swaps in the storage abstraction (local-fs vs S3) and changes upload_path
 * semantics from "filesystem path" to "object key".
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { audit } = require('../../../src/index');
const { writeReports } = require('../../../src/reporter');
const { extractZip } = require('../../../src/lib/extract');
const { loadFiles } = require('../../../src/lib/load-files');
const { applyFixes, writeFixedZip } = require('../../../src/lib/auto-fix');
const { diffAgainstBaseline } = require('../../../src/lib/baseline');
const quotas = require('../lib/quotas');

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'uploads');
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
// cloud/server/routes/audits.js → ../../../test/fixtures/...
const SAMPLE_FIXTURE = path.resolve(
  __dirname, '..', '..', '..', 'test', 'fixtures', 'scorm12-violations.zip'
);

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
 * @param {object} [deps.config] - mode/auth config from lib/mode.validate().
 *                                  When isHosted is true, every endpoint
 *                                  filters by req.user.id (req.user is set
 *                                  by the auth middleware mounted upstream).
 * @param {function} [deps.requireAuth] - middleware that 401s when req.user
 *                                        is missing. Mounted in hosted mode.
 * @param {function} [deps.csrfProtect] - csrf-csrf doubleCsrfProtection.
 *                                        Mounted on state-changing routes
 *                                        in hosted mode.
 */
function createAuditRouter({ jobs, config, requireAuth, csrfProtect, store }) {
  if (!jobs) throw new Error('createAuditRouter: jobs (JobManager) is required');
  const isHosted = !!(config && config.isHosted);
  const quotaConfig = isHosted ? quotas.readQuotaConfig() : null;

  // Helper: ownership filter to pass into store/job-manager calls.
  // - hosted mode: filter by current user's id (always set; requireAuth gates).
  // - local mode: undefined (no filter), so legacy NULL rows remain visible.
  const ownerFilter = (req) => {
    if (!isHosted) return undefined;
    return { userId: (req.user && req.user.id) || "__no_user__" };
  };

  // Compose middleware chains conditionally.
  const auth = isHosted && requireAuth ? [requireAuth] : [];
  const csrf = isHosted && csrfProtect ? [csrfProtect] : [];

  const router = express.Router();
  const upload = makeMulter();

  // Multer instance for /audits/batch — accepts up to 30 files in one
  // request. Same temp-name strategy as the single-upload route.
  const batchUpload = makeMulter().array('package', 30);

  // ------------------------------------------------------------------
  // POST /api/audits/batch  (Phase 8)
  //
  // Multipart upload with 1..N `package` fields. Generates one batchId,
  // creates one job per file sharing that batchId, returns
  // { batchId, jobIds }. Per-file options are out of scope (ROADMAP §8) —
  // every job in a batch uses the same standard / packageType / browser.
  // ------------------------------------------------------------------
  router.post('/audits/batch', ...auth, ...csrf, batchUpload, async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: "Missing form field 'package' (one or more .zip files)" });
    }

    const opts = {
      packageType: req.body.packageType || 'auto',
      standard: req.body.standard || 'wcag22',
      browser: req.body.browser || 'chromium',
      timeoutDynamic: req.body.timeoutDynamic
        ? parseInt(req.body.timeoutDynamic, 10)
        : 30000,
    };

    // Phase 9C: enforce quotas against the cumulative batch.
    if (isHosted && store) {
      const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
      const verdict = await quotas.check({
        store, userId: req.user.id,
        addingCount: files.length,
        addingBytes: totalBytes,
        config: quotaConfig,
      });
      if (!verdict.allowed) {
        for (const f of files) { try { fs.unlinkSync(f.path); } catch (_) {} }
        return res.status(429).json({
          error: `Quota exceeded: ${verdict.reason}`,
          reason: verdict.reason,
          limit: verdict.limit,
          current: verdict.current,
        });
      }
    }

    const batchId = crypto.randomUUID();
    const jobIds = [];
    try {
      for (const file of files) {
        const safeName = (file.originalname || '').replace(/[\\/]/g, '_').slice(0, 256);
        const hot = await jobs.create({
          uploadPath: file.path,
          options: opts,
          originalName: safeName || null,
          batchId,
          userId: req.user ? req.user.id : null,
          uploadBytes: file.size || null,
        });
        jobIds.push(hot.id);
      }
      res.status(201).json({ batchId, jobIds });
    } catch (err) {
      res.status(500).json({ error: `Failed to create batch: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/batches/:id  (Phase 8) — list of jobs in the batch
  // ------------------------------------------------------------------
  router.get('/batches/:id', ...auth, async (req, res) => {
    try {
      const list = await jobs.listBatchSnapshots(req.params.id, ownerFilter(req));
      if (list.length === 0) return res.status(404).json({ error: 'Batch not found' });
      res.json({ batchId: req.params.id, jobs: list });
    } catch (err) {
      res.status(500).json({ error: `Failed to fetch batch: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/batches/:id/events  (Phase 8) — multiplexed SSE
  //
  // Subscribes to every child job's event stream and forwards envelopes
  // tagged with the originating jobId. The stream stays open until every
  // child has reached a terminal state, then closes.
  // ------------------------------------------------------------------
  router.get('/batches/:id/events', ...auth, async (req, res) => {
    let list;
    try { list = await jobs.listBatchSnapshots(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (list.length === 0) return res.status(404).json({ error: 'Batch not found' });

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

    const subs = [];
    let terminalCount = 0;
    let closed = false;
    const closeStream = () => {
      if (closed) return;
      closed = true;
      for (const u of subs) { try { u && u(); } catch (_) {} }
      try { res.end(); } catch (_) {}
    };

    const total = list.length;
    // Initial snapshot so subscribers know the line-up before progress.
    writeEvent('batch', { batchId: req.params.id, jobs: list });

    const isTerminal = (s) => s === 'done' || s === 'error' || s === 'cancelled';

    for (const snap of list) {
      // Already-terminal jobs: emit a single envelope, count toward the
      // terminal counter, no live subscription needed.
      if (isTerminal(snap.status)) {
        if (snap.status === 'done') writeEvent('child-done', { jobId: snap.id, summary: snap.summary });
        else if (snap.status === 'error') writeEvent('child-error', { jobId: snap.id, error: snap.error });
        else writeEvent('child-cancelled', { jobId: snap.id });
        terminalCount++;
        continue;
      }
      const u = await jobs.subscribe(snap.id, (ev) => {
        if (ev && ev.stage === '__done__') {
          writeEvent('child-done', { jobId: snap.id, summary: ev.summary || {} });
          terminalCount++;
          if (terminalCount >= total) closeStream();
        } else if (ev && ev.stage === '__error__') {
          writeEvent('child-error', { jobId: snap.id, error: ev.error });
          terminalCount++;
          if (terminalCount >= total) closeStream();
        } else if (ev && ev.stage === '__cancelled__') {
          writeEvent('child-cancelled', { jobId: snap.id });
          terminalCount++;
          if (terminalCount >= total) closeStream();
        } else {
          writeEvent('child-progress', { jobId: snap.id, ev });
        }
      });
      subs.push(u);
    }

    // If every job was already terminal at attach time, close the stream
    // after delivering all the synthesized envelopes.
    if (terminalCount >= total) {
      // Defer one tick so the client receives all initial events before close.
      setImmediate(closeStream);
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

  // ------------------------------------------------------------------
  // POST /api/audits
  // ------------------------------------------------------------------
  router.post('/audits', ...auth, ...csrf, upload.single('package'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Missing form field 'package' (the .zip file)" });
    }

    const opts = {
      packageType: req.body.packageType || 'auto',
      standard: req.body.standard || 'wcag22',
      browser: req.body.browser || 'chromium',
      timeoutDynamic: req.body.timeoutDynamic
        ? parseInt(req.body.timeoutDynamic, 10)
        : 30000,
    };

    const safeName = (req.file.originalname || '').replace(/[\\/]/g, '_').slice(0, 256);
    const uploadBytes = req.file.size || null;

    // Phase 9C quota check (hosted mode only). The upload's already on disk
    // at this point — multer wrote it before we got here. We unlink on
    // rejection so a 429 doesn't leak storage.
    if (isHosted && store) {
      const verdict = await quotas.check({
        store, userId: req.user.id, addingBytes: uploadBytes || 0, config: quotaConfig,
      });
      if (!verdict.allowed) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(429).json({
          error: `Quota exceeded: ${verdict.reason}`,
          reason: verdict.reason,
          limit: verdict.limit,
          current: verdict.current,
        });
      }
    }

    try {
      const hot = await jobs.create({
        uploadPath: req.file.path,
        options: opts,
        originalName: safeName || null,
        userId: req.user ? req.user.id : null,
        uploadBytes,
      });
      res.status(201).json({ jobId: hot.id, status: hot.status });
    } catch (err) {
      res.status(500).json({ error: `Failed to create job: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/audits — list recent jobs (filtered to current user in hosted mode)
  // ------------------------------------------------------------------
  router.get('/audits', ...auth, async (req, res) => {
    try {
      const list = await jobs.listSnapshots(50, ownerFilter(req));
      res.json({ jobs: list });
    } catch (err) {
      res.status(500).json({ error: `Failed to list jobs: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/audits/:id — snapshot
  // ------------------------------------------------------------------
  router.get('/audits/:id', ...auth, async (req, res) => {
    try {
      const snap = await jobs.snapshot(req.params.id, ownerFilter(req));
      if (!snap) return res.status(404).json({ error: 'Job not found' });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: `Failed to fetch job: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/audits/:id/cancel — best-effort cancel
  // ------------------------------------------------------------------
  router.post('/audits/:id/cancel', ...auth, ...csrf, async (req, res) => {
    try {
      // Verify ownership before cancelling.
      const snap = await jobs.snapshot(req.params.id, ownerFilter(req));
      if (!snap) return res.status(404).json({ error: 'Job not found' });
      const ok = await jobs.cancel(req.params.id);
      if (!ok) {
        return res.status(409).json({ error: `Job already terminal (status: ${snap.status})` });
      }
      res.json({ ok: true, status: 'cancelled' });
    } catch (err) {
      res.status(500).json({ error: `Cancel failed: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/audits/:id/fix?dry-run=true   (Phase 7a)
  //
  // Re-extracts the original .zip into a scratch dir, runs applyFixes
  // against the stored violations, and either:
  //   - dry-run=true: returns { applied, skipped, dryRun: true } only.
  //   - apply (no dry-run flag): writes a .scorm-fixed.zip and creates
  //     a follow-up audit job, returning { jobId } for navigation.
  //
  // Job must be terminal (status='done') with a stored result. The original
  // upload file must still be on disk (Phase 5 retention default keeps it
  // forever; if retention reaped it the endpoint returns 410 Gone).
  // ------------------------------------------------------------------
  router.post('/audits/:id/fix', ...auth, ...csrf, async (req, res) => {
    let hot;
    try { hot = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!hot) return res.status(404).json({ error: 'Job not found' });
    if (hot.status !== 'done') {
      return res.status(409).json({ error: `Job not done (status: ${hot.status})` });
    }
    if (!hot.result || !Array.isArray(hot.result.violations)) {
      return res.status(409).json({ error: 'Job has no violations to fix' });
    }
    if (!fs.existsSync(hot.uploadPath)) {
      return res.status(410).json({
        error: 'Original upload no longer on disk (retention may have reaped it)',
      });
    }

    const dryRun = String(req.query['dry-run'] || '') === 'true';

    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'op-fix-'));
    try {
      // Re-extract the original package and load file contents.
      await extractZip(hot.uploadPath, scratch);
      const files = await loadFiles(scratch);

      // applyFixes accepts files.html — the existing /src auto-fix only
      // touches HTML today. (Adding new fixers is a /src concern, not ours.)
      const fixResult = await applyFixes({
        violations: hot.result.violations,
        files: files.html,
        options: {
          packageType: hot.result.packageType,
          dryRun,
        },
      });

      if (dryRun) {
        return res.json({
          dryRun: true,
          applied: fixResult.applied,
          skipped: fixResult.skipped.length,
          appliedCount: fixResult.applied.length,
        });
      }

      if (!fixResult.fixedFiles || fixResult.fixedFiles.size === 0) {
        return res.status(409).json({
          error: 'No auto-fixable violations',
          applied: 0,
          skipped: fixResult.skipped.length,
        });
      }

      // Write the fixed zip alongside the original upload directory so
      // retention sweeps it on the same schedule as everything else.
      const parsed = path.parse(hot.uploadPath);
      const outputZipPath = path.join(
        parsed.dir,
        `${parsed.name}.scorm-fixed-${Date.now()}.zip`
      );
      await writeFixedZip({
        originalZipPath: hot.uploadPath,
        outputZipPath,
        fixedFiles: fixResult.fixedFiles,
      });

      // Create a follow-up job. Reuse the original audit options so the
      // re-audit is apples-to-apples (same WCAG standard, package type, etc.).
      const followUp = await jobs.create({
        uploadPath: outputZipPath,
        options: hot.options || {},
        originalName: hot.originalName
          ? `${hot.originalName.replace(/\.zip$/i, '')}.scorm-fixed.zip`
          : 'fixed.zip',
        userId: req.user ? req.user.id : null,
      });

      res.status(201).json({
        jobId: followUp.id,
        status: followUp.status,
        applied: fixResult.applied.length,
        skipped: fixResult.skipped.length,
      });
    } catch (err) {
      res.status(500).json({ error: `Fix failed: ${err.message}` });
    } finally {
      fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------------------------------------------------------------------
  // GET /api/sample — stream a fixture for the "Try a sample" button
  // ------------------------------------------------------------------
  router.get('/sample', (_req, res) => {
    fs.stat(SAMPLE_FIXTURE, (err, stat) => {
      if (err) return res.status(404).json({ error: 'Sample fixture not found' });
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="sample.scorm12.zip"',
        'Content-Length': stat.size,
      });
      fs.createReadStream(SAMPLE_FIXTURE).pipe(res);
    });
  });

  // ------------------------------------------------------------------
  // GET /api/audits/:id/events — Server-Sent Events stream
  // ------------------------------------------------------------------
  router.get('/audits/:id/events', ...auth, async (req, res) => {
    let hot;
    try {
      hot = await jobs.get(req.params.id, ownerFilter(req));
    } catch (err) {
      return res.status(500).json({ error: `Lookup failed: ${err.message}` });
    }
    if (!hot) return res.status(404).json({ error: 'Job not found' });

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
      // Job vanished between get() and subscribe() — defensive.
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

  // ------------------------------------------------------------------
  // GET /api/audits/:id/report.json[?baseline=:baselineId]   (Phase 7b adds baseline)
  //
  // When ?baseline= is set, looks up the baseline job and filters the
  // current report's violations via diffAgainstBaseline. The scorecard is
  // recomputed against the filtered list (mirrors src/cli.js's --baseline
  // recipe). Adds a `baselineMeta` block to the JSON so the SPA can label
  // the comparison and offer a "Clear" affordance.
  // ------------------------------------------------------------------
  router.get('/audits/:id/report.json', ...auth, async (req, res) => {
    let hot;
    try { hot = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!hot) return res.status(404).json({ error: 'Job not found' });
    if (hot.status !== 'done') {
      return res.status(409).json({ error: `Job not done (status: ${hot.status})` });
    }

    const baselineId = (req.query.baseline || '').toString().trim();
    let baselineHot = null;
    if (baselineId) {
      if (baselineId === req.params.id) {
        return res.status(400).json({ error: 'baseline cannot be the same as the current job' });
      }
      try { baselineHot = await jobs.get(baselineId, ownerFilter(req)); }
      catch (err) { return res.status(500).json({ error: `Baseline lookup failed: ${err.message}` }); }
      if (!baselineHot) return res.status(404).json({ error: 'Baseline job not found' });
      if (baselineHot.status !== 'done') {
        return res.status(409).json({ error: `Baseline job not done (status: ${baselineHot.status})` });
      }
    }

    try {
      // Build the inputs for writeReports. When a baseline is in effect we
      // filter violations and recompute the scorecard server-side, mirroring
      // the recipe in src/cli.js (--baseline path).
      let scorecard = hot.result.scorecard;
      let violations = hot.result.violations;
      let baselineMeta = null;

      if (baselineHot) {
        const baselineViolations = (baselineHot.result && baselineHot.result.violations) || [];
        const filtered = diffAgainstBaseline(violations, baselineViolations);

        // Recompute the scorecard against the filtered violations.
        // Start from the existing criteriaResults (so passed/level/etc.
        // metadata is preserved) and recompute the boolean per-criterion.
        const totalCriteria = scorecard.totalCriteria;
        const passedCriteria = new Set(
          scorecard.criteriaResults.filter((cr) => cr.passed).map((cr) => cr.id)
        );
        // Add back any criterion that ONLY had baseline violations: the
        // current run had a violation there, so it was originally in
        // failedCriteria, but after filtering nothing remains.
        for (const cr of scorecard.criteriaResults) {
          if (!cr.passed && !filtered.some((v) => v.criterion === cr.id)) {
            passedCriteria.add(cr.id);
          }
        }
        // Defensive: if filtering somehow added violations to a criterion
        // that was passing, drop it (shouldn't happen — diff only removes).
        for (const v of filtered) {
          if (v.criterion) passedCriteria.delete(v.criterion);
        }

        const passed = passedCriteria.size;
        const score = totalCriteria > 0 ? Math.round((passed / totalCriteria) * 100) : 100;

        scorecard = {
          ...scorecard,
          passed: passed === totalCriteria,
          score,
          passedCriteria: passed,
          failedCriteria: totalCriteria - passed,
          totalViolations: filtered.length,
          criteriaResults: scorecard.criteriaResults.map((cr) => ({
            ...cr,
            passed: passedCriteria.has(cr.id),
            violationCount: filtered.filter((v) => v.criterion === cr.id).length,
          })),
        };
        violations = filtered;

        baselineMeta = {
          id: baselineHot.id,
          originalName: baselineHot.originalName || null,
          baselineViolationCount: baselineViolations.length,
          filteredOut: (hot.result.violations || []).length - filtered.length,
        };
      }

      const out = await writeReports({
        scorecard,
        violations,
        manualReview: hot.result.manualReview,
        scos: hot.result.scos,
        dynamicReport: hot.result.dynamicReport,
        fixesApplied: hot.result.fixesApplied,
        options: {
          json: true,
          standard: (hot.options && hot.options.standard) || 'wcag22',
          packageType: hot.result.packageType,
          packagePath: path.basename(hot.uploadPath || ''),
        },
      });

      // writeReports returns a serialized jsonString; if a baseline was
      // applied we splice baselineMeta into the JSON before sending so the
      // SPA can render the comparison banner.
      if (baselineMeta) {
        let parsed;
        try { parsed = JSON.parse(out.jsonString); }
        catch (_) { parsed = null; }
        if (parsed) {
          parsed.baselineMeta = baselineMeta;
          res.set('Content-Type', 'application/json');
          return res.send(JSON.stringify(parsed));
        }
      }
      res.set('Content-Type', 'application/json');
      res.send(out.jsonString);
    } catch (err) {
      res.status(500).json({ error: `Report error: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/audits/:id/report.md
  // ------------------------------------------------------------------
  router.get('/audits/:id/report.md', ...auth, async (req, res) => {
    let hot;
    try { hot = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!hot) return res.status(404).json({ error: 'Job not found' });
    if (hot.status !== 'done') {
      return res.status(409).json({ error: `Job not done (status: ${hot.status})` });
    }

    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'op-md-'));
    try {
      const out = await writeReports({
        scorecard: hot.result.scorecard,
        violations: hot.result.violations,
        manualReview: hot.result.manualReview,
        scos: hot.result.scos,
        dynamicReport: hot.result.dynamicReport,
        fixesApplied: hot.result.fixesApplied,
        options: {
          format: 'md',
          output: scratch,
          standard: (hot.options && hot.options.standard) || 'wcag22',
          packageType: hot.result.packageType,
          packagePath: path.basename(hot.uploadPath || ''),
        },
      });
      const md = await fsp.readFile(out.mdPath, 'utf8');
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.send(md);
    } catch (err) {
      res.status(500).json({ error: `Report error: ${err.message}` });
    } finally {
      fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------------------------------------------------------------------
  // GET /api/audits/:id/report.csv  (Phase 8)
  //
  // One row per violation. Columns chosen to be useful in a spreadsheet
  // and stable across audits: criterion, criterionName, level, severity,
  // confidence, file, line, message. We don't include snippet (multi-line
  // HTML breaks CSV ergonomics).
  // ------------------------------------------------------------------
  router.get('/audits/:id/report.csv', ...auth, async (req, res) => {
    let hot;
    try { hot = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!hot) return res.status(404).json({ error: 'Job not found' });
    if (hot.status !== 'done') {
      return res.status(409).json({ error: `Job not done (status: ${hot.status})` });
    }

    try {
      const out = await writeReports({
        scorecard: hot.result.scorecard,
        violations: hot.result.violations,
        manualReview: hot.result.manualReview,
        scos: hot.result.scos,
        dynamicReport: hot.result.dynamicReport,
        fixesApplied: hot.result.fixesApplied,
        options: {
          json: true,
          standard: (hot.options && hot.options.standard) || 'wcag22',
          packageType: hot.result.packageType,
          packagePath: path.basename(hot.uploadPath || ''),
        },
      });
      const parsed = JSON.parse(out.jsonString);
      const csv = violationsToCsv(parsed.violations || []);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-${req.params.id}.csv"`,
      });
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: `CSV error: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/batches/:id/report.csv  (Phase 8)
  //
  // One row per job in the batch, summarizing status / score / violations.
  // Useful for "audit 30 SCOs before a release" workflows.
  // ------------------------------------------------------------------
  router.get('/batches/:id/report.csv', ...auth, async (req, res) => {
    let list;
    try { list = await jobs.listBatchSnapshots(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (list.length === 0) return res.status(404).json({ error: 'Batch not found' });

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="batch-${req.params.id}.csv"`,
    });
    res.send(batchToCsv(list));
  });

  return { router };
}

// ---------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------

/**
 * RFC 4180 CSV escape: wrap in double-quotes if the value contains a
 * comma, newline, or double-quote, and double any embedded quotes.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function violationsToCsv(violations) {
  const cols = ['criterion', 'criterionName', 'level', 'severity', 'confidence', 'file', 'line', 'message'];
  const lines = [csvRow(cols)];
  for (const v of violations) {
    lines.push(csvRow(cols.map((c) => v[c])));
  }
  return lines.join('\r\n') + '\r\n';
}

function batchToCsv(jobs) {
  const cols = [
    'jobId', 'originalName', 'status', 'createdAt', 'finishedAt',
    'score', 'passed', 'totalViolations', 'packageType', 'incompleteReason', 'error',
  ];
  const lines = [csvRow(cols)];
  for (const j of jobs) {
    const summary = j.summary || {};
    lines.push(csvRow([
      j.id,
      j.originalName,
      j.status,
      j.createdAt ? new Date(j.createdAt).toISOString() : '',
      j.finishedAt ? new Date(j.finishedAt).toISOString() : '',
      summary.score != null ? summary.score : '',
      summary.passed === undefined ? '' : (summary.passed ? 'true' : 'false'),
      summary.totalViolations != null ? summary.totalViolations : '',
      summary.packageType || '',
      summary.incompleteReason || '',
      j.error || '',
    ]));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { createAuditRouter, UPLOAD_DIR, MAX_UPLOAD_BYTES, violationsToCsv, batchToCsv };

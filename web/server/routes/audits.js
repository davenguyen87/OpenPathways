/**
 * Audit job routes.
 *
 *   POST /api/audits                    Upload + create job. multipart/form-data.
 *   GET  /api/audits/:id                Snapshot (status + summary).
 *   GET  /api/audits/:id/events         Server-Sent Events stream.
 *   GET  /api/audits/:id/report.json    Full JSON scorecard.
 *   GET  /api/audits/:id/report.md      Markdown report.
 *
 * Storage: uploads land in web/.tmp/uploads/<jobId>.zip and are cleaned up
 * 10 minutes after the job finishes (see job-manager.js).
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
const { JobManager } = require('../job-manager');

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'uploads');
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
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
    // We don't have the jobId yet at upload time (created post-receive), so
    // generate a temporary name and rename later. multer needs the file on
    // disk before our handler runs.
    filename: (_req, _file, cb) => {
      const tmp = `pending-${crypto.randomBytes(8).toString('hex')}.zip`;
      cb(null, tmp);
    },
  });
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });
}

function createAuditRouter() {
  const router = express.Router();
  const upload = makeMulter();

  // The runner the JobManager calls when it's a job's turn. Wires the
  // onProgress hook through to the manager's emitter.
  const jobs = new JobManager();
  jobs.setRunner(async (job, emit) => {
    return audit(job.uploadPath, {
      ...job.options,
      packagePath: job.uploadPath,
      onProgress: (ev) => emit(ev),
      // Phase 6: lets cancel() actually stop a mid-Playwright audit.
      signal: job.signal,
    });
  });

  // ------------------------------------------------------------------
  // POST /api/audits
  // ------------------------------------------------------------------
  router.post('/audits', upload.single('package'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Missing form field 'package' (the .zip file)" });
    }

    // Pull optional audit options from multipart text fields.
    const opts = {
      packageType: req.body.packageType || 'auto',
      standard: req.body.standard || 'wcag22',
      browser: req.body.browser || 'chromium',
      timeoutDynamic: req.body.timeoutDynamic
        ? parseInt(req.body.timeoutDynamic, 10)
        : 30000,
    };

    // Use multer's temp path directly as the job's uploadPath. The path is
    // already unique per request and stable on disk; renaming to <jobId>.zip
    // would require sequencing the rename ahead of jobs.create() — which
    // already queues the job for execution. Cleanup uses job.uploadPath so
    // either name works. Sanitize originalname (strip directory tricks);
    // it's only ever displayed back to the user, never written to disk.
    const safeName = (req.file.originalname || '').replace(/[\\/]/g, '_').slice(0, 256);
    const job = jobs.create({
      uploadPath: req.file.path,
      options: opts,
      originalName: safeName || null,
    });
    res.status(201).json({ jobId: job.id, status: job.status });
  });

  // ------------------------------------------------------------------
  // GET /api/audits — list (handy for debugging; cheap)
  // ------------------------------------------------------------------
  router.get('/audits', (_req, res) => {
    res.json({ jobs: jobs.list() });
  });

  // ------------------------------------------------------------------
  // GET /api/audits/:id — snapshot
  // ------------------------------------------------------------------
  router.get('/audits/:id', (req, res) => {
    const snap = jobs.snapshot(req.params.id);
    if (!snap) return res.status(404).json({ error: 'Job not found' });
    res.json(snap);
  });

  // ------------------------------------------------------------------
  // POST /api/audits/:id/cancel — best-effort cancel (option b in PLAN.md)
  // Server marks job cancelled and closes SSE; the underlying audit() keeps
  // running to completion in the background and the result is discarded.
  // ------------------------------------------------------------------
  router.post('/audits/:id/cancel', (req, res) => {
    const ok = jobs.cancel(req.params.id);
    if (!ok) {
      const snap = jobs.snapshot(req.params.id);
      if (!snap) return res.status(404).json({ error: 'Job not found' });
      return res.status(409).json({ error: `Job already terminal (status: ${snap.status})` });
    }
    res.json({ ok: true, status: 'cancelled' });
  });

  // ------------------------------------------------------------------
  // GET /api/sample — stream a fixture so the frontend can offer a
  // "Try a sample" button without bundling the file. Returns the
  // SCORM 1.2 violations fixture (intentionally non-clean so the user
  // sees the result UI populated).
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
  router.get('/audits/:id/events', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

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
    const closeStream = () => {
      if (closed) return;
      closed = true;
      try { unsubscribe && unsubscribe(); } catch (_) {}
      try { res.end(); } catch (_) {}
    };

    const unsubscribe = jobs.subscribe(req.params.id, (ev) => {
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

    // Heartbeat keeps proxies/browsers from timing the connection out.
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
  // GET /api/audits/:id/report.json
  // ------------------------------------------------------------------
  router.get('/audits/:id/report.json', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done') {
      return res.status(409).json({ error: `Job not done (status: ${job.status})` });
    }

    try {
      const out = await writeReports({
        scorecard: job.result.scorecard,
        violations: job.result.violations,
        manualReview: job.result.manualReview,
        scos: job.result.scos,
        dynamicReport: job.result.dynamicReport,
        fixesApplied: job.result.fixesApplied,
        options: {
          json: true,
          standard: (job.options && job.options.standard) || 'wcag22',
          packageType: job.result.packageType,
          packagePath: path.basename(job.uploadPath || ''),
        },
      });
      res.set('Content-Type', 'application/json');
      res.send(out.jsonString);
    } catch (err) {
      res.status(500).json({ error: `Report error: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/audits/:id/report.md
  // ------------------------------------------------------------------
  router.get('/audits/:id/report.md', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done') {
      return res.status(409).json({ error: `Job not done (status: ${job.status})` });
    }

    // Reporter writes to disk in non-JSON mode. Use a per-request scratch
    // dir so concurrent requests don't trample each other.
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'op-md-'));
    try {
      const out = await writeReports({
        scorecard: job.result.scorecard,
        violations: job.result.violations,
        manualReview: job.result.manualReview,
        scos: job.result.scos,
        dynamicReport: job.result.dynamicReport,
        fixesApplied: job.result.fixesApplied,
        options: {
          format: 'md',
          output: scratch,
          standard: (job.options && job.options.standard) || 'wcag22',
          packageType: job.result.packageType,
          packagePath: path.basename(job.uploadPath || ''),
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

  return { router, jobs };
}

module.exports = { createAuditRouter, UPLOAD_DIR, MAX_UPLOAD_BYTES };

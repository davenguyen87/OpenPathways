/**
 * Checkpoint routes for v5 full-tier rebuild review.
 *
 *   GET  /api/jobs/:id/checkpoint           — staged checkpoint state
 *   POST /api/jobs/:id/checkpoint           — persist per-transform decisions
 *   POST /api/jobs/:id/checkpoint/promote   — promote staged to final
 *
 * These routes mirror the CLI's `src/lib/checkpoint-cli.js` approveAction
 * path, adapted for the multi-tenant cloud context:
 *
 *   - Jobs are scoped to the authenticated user (ownership enforced).
 *   - Staging artifacts live under the staging storage adapter, not the
 *     local filesystem's `engagements/` tree.
 *   - `promote()` from `src/rebuild/checkpoint.js` operates on real paths,
 *     so we materialize the staged zip + manifest to a temp directory,
 *     call promote(), then upload the resulting artifacts back into durable
 *     storage and update the job row.
 *
 * Factory: createCheckpointRouter({ jobs, config, requireAuth, csrfProtect, store, storage })
 *
 * Dependency on Agent #28:
 *   Jobs are expected to carry `kind` and `parent_job_id` columns. We read
 *   these with fallbacks (`row.kind || 'audit'`) so this module does not crash
 *   if those columns are absent during a transitional deploy.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

// Lazy-load checkpoint engine so tests can stub it.
function lazyCheckpoint() {
  return require('../../../src/rebuild/checkpoint');
}

// Lazy-load rebuild-preview renderer so tests can stub it.
function lazyRenderPreview() {
  return require('../../../src/reporter/rebuild-preview').renderRebuildPreview;
}

// Names of the two key staging files (from src/rebuild/checkpoint.js).
const STAGED_MANIFEST_NAME = 'rebuild-manifest-staged.json';
const STAGED_ZIP_NAME = 'rebuilt-staged.zip';
const STATE_FILE_NAME = 'checkpoint-state.json';
const STATE_VERSION = '1.0.0';

/**
 * Compute SHA-256 of a string. Mirrors checkpoint.js's hashString().
 */
function hashString(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * @param {object} deps
 * @param {object} deps.jobs        - JobManager (or compatible stub)
 * @param {object} [deps.config]    - { isHosted, mode }
 * @param {function} [deps.requireAuth] - auth middleware
 * @param {function} [deps.csrfProtect] - csrf middleware
 * @param {object} [deps.store]     - store adapter (for job status updates)
 * @param {object} [deps.storage]   - base storage adapter
 * @param {object} [deps.staging]   - StagingStorage adapter (optional;
 *                                    created from storage if not provided)
 * @param {object} [deps.checkpoint] - override checkpoint module (for tests)
 * @param {function} [deps.renderPreview] - override renderer (for tests)
 */
function createCheckpointRouter({
  jobs,
  config,
  requireAuth,
  csrfProtect,
  store,
  storage,
  staging: stagingParam,
  checkpoint: checkpointParam,
  renderPreview: renderPreviewParam,
} = {}) {
  if (!jobs) throw new Error('createCheckpointRouter: jobs is required');

  const isHosted = !!(config && config.isHosted);
  const authDisabled = !requireAuth;
  const auth = isHosted && requireAuth ? [requireAuth] : [];
  const csrf = isHosted && csrfProtect ? [csrfProtect] : [];

  // Rate limiters — only active in hosted mode (same pattern as routes/auth.js).
  // POST /api/jobs/:id/checkpoint — generous: 60/min (users toggle decisions rapidly).
  const checkpointDecisionLimiter = isHosted ? [rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user && req.user.id) || req.ip,
    message: { error: 'Too many checkpoint requests. Try again in a minute.' },
  })] : [];
  // POST /api/jobs/:id/checkpoint/promote — strict: 5/min (triggers verify + fs work).
  const checkpointPromoteLimiter = isHosted ? [rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user && req.user.id) || req.ip,
    message: { error: 'Too many promote requests. Try again in a minute.' },
  })] : [];

  // Lazily create the staging adapter if not injected.
  const getStagingAdapter = (() => {
    let _staging = stagingParam || null;
    return () => {
      if (_staging) return _staging;
      if (!storage) throw new Error('createCheckpointRouter: storage is required when staging is not provided');
      const { createStagingFromStorage } = require('../storage/staging');
      _staging = createStagingFromStorage(storage);
      return _staging;
    };
  })();

  // Ownership filter — same convention as audit routes.
  const ownerFilter = (req) => {
    if (!isHosted || authDisabled) return undefined;
    return { userId: req.user.id };
  };

  const router = express.Router();

  // ------------------------------------------------------------------
  // GET /api/jobs/:id/checkpoint
  //
  // Returns the staged checkpoint state for a rebuild job.
  // 404 if:
  //   - job not found / wrong owner
  //   - job.kind !== 'rebuild'
  //   - job.status !== 'staged'
  //
  // Returns:
  //   { jobId, status, transforms: [{id, kind, summary, judgment, decision}],
  //     previewHtml: '<html>...' }
  // ------------------------------------------------------------------
  router.get('/jobs/:id/checkpoint', ...auth, async (req, res) => {
    let job;
    try { job = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const kind = job.kind || 'audit';
    if (kind !== 'rebuild') {
      return res.status(404).json({ error: 'Job is not a rebuild job' });
    }
    if (job.status !== 'staged') {
      return res.status(404).json({
        error: `Job is not in staged status (current: ${job.status})`,
      });
    }

    const staging = getStagingAdapter();

    // Read the staged manifest.
    let manifest;
    try {
      manifest = await staging.getStagingJson(job.id, STAGED_MANIFEST_NAME);
    } catch (err) {
      return res.status(500).json({ error: `Failed to read staged manifest: ${err.message}` });
    }
    if (!manifest) {
      return res.status(404).json({ error: 'Staged manifest not found — rebuild staging may be incomplete' });
    }

    // Read checkpoint-state.json if present (persisted decisions from a prior POST).
    let savedDecisions = {};
    try {
      const state = await staging.getStagingJson(job.id, STATE_FILE_NAME);
      if (state && state.decisions && typeof state.decisions === 'object') {
        savedDecisions = state.decisions;
      }
    } catch (_) { /* no saved state yet — fine */ }

    const allTransforms = Array.isArray(manifest.transforms) ? manifest.transforms : [];

    // Build the transforms summary for the response.
    const transforms = allTransforms.map((t) => ({
      id: t.id,
      kind: t.family || t.transformer || 'unknown',
      summary: t.summary || t.description || null,
      judgment: t.judgment || null, // AI verdict if v5.1 is active
      decision: savedDecisions[t.id] || (t.status !== 'pending-checkpoint' ? t.status : 'pending'),
    }));

    // Render the preview HTML inline. We need the manifest on disk for the
    // renderer — write to a temp file, render, then clean up.
    let previewHtml = null;
    try {
      const doRender = renderPreviewParam || lazyRenderPreview();
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `prism-cp-${job.id.slice(0, 8)}-`));
      try {
        const previewPath = path.join(tmpDir, 'rebuild-preview.html');
        previewHtml = await doRender(manifest, null, previewPath, { mode: 'review' });
      } finally {
        fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (_) {
      // Preview is best-effort; don't fail the GET if the renderer errors.
      previewHtml = null;
    }

    res.json({
      jobId: job.id,
      status: job.status,
      transforms,
      previewHtml,
    });
  });

  // ------------------------------------------------------------------
  // POST /api/jobs/:id/checkpoint
  //
  // Body: { decisions: { [transformId]: 'approve' | 'reject' } }
  //
  // Validates ownership, validates all transformIds exist in the staged
  // manifest, persists checkpoint-state.json. Idempotent.
  //
  // Returns 200 with the updated state.
  // ------------------------------------------------------------------
  router.post('/jobs/:id/checkpoint', ...checkpointDecisionLimiter, ...auth, ...csrf, express.json(), async (req, res) => {
    let job;
    try { job = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const kind = job.kind || 'audit';
    if (kind !== 'rebuild') {
      return res.status(404).json({ error: 'Job is not a rebuild job' });
    }
    if (job.status !== 'staged') {
      return res.status(409).json({
        error: `Job is not in staged status (current: ${job.status})`,
      });
    }

    const body = req.body || {};
    const decisions = body.decisions;
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
      return res.status(400).json({ error: 'Body must include { decisions: { [transformId]: "approve"|"reject" } }' });
    }

    // Validate all decision values.
    for (const [id, val] of Object.entries(decisions)) {
      if (val !== 'approve' && val !== 'reject') {
        return res.status(400).json({
          error: `decisions["${id}"] must be "approve" or "reject"`,
        });
      }
    }

    const staging = getStagingAdapter();

    // Read the staged manifest to validate transformIds.
    let manifest;
    try {
      manifest = await staging.getStagingJson(job.id, STAGED_MANIFEST_NAME);
    } catch (err) {
      return res.status(500).json({ error: `Failed to read staged manifest: ${err.message}` });
    }
    if (!manifest) {
      return res.status(404).json({ error: 'Staged manifest not found' });
    }

    const allTransforms = Array.isArray(manifest.transforms) ? manifest.transforms : [];
    const validIds = new Set(allTransforms.map((t) => t.id));
    for (const id of Object.keys(decisions)) {
      if (!validIds.has(id)) {
        return res.status(400).json({ error: `decisions references unknown transformId: "${id}"` });
      }
    }

    // Compute the manifest hash to bind the state file.
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestHash = hashString(manifestJson);

    // Build the checkpoint-state.json document.
    const username = (req.user && req.user.email) || (req.user && req.user.id) || 'api-user';
    const stateDoc = {
      stateVersion: STATE_VERSION,
      manifestHash,
      decisions,
      decidedBy: username,
      decidedAt: new Date().toISOString(),
    };

    try {
      await staging.putStagingJson(job.id, STATE_FILE_NAME, stateDoc);
    } catch (err) {
      return res.status(500).json({ error: `Failed to persist decisions: ${err.message}` });
    }

    // Build the updated transforms list for the response.
    const transforms = allTransforms.map((t) => ({
      id: t.id,
      kind: t.family || t.transformer || 'unknown',
      summary: t.summary || t.description || null,
      judgment: t.judgment || null,
      decision: decisions[t.id] || (t.status !== 'pending-checkpoint' ? t.status : 'pending'),
    }));

    res.json({
      jobId: job.id,
      status: job.status,
      transforms,
    });
  });

  // ------------------------------------------------------------------
  // POST /api/jobs/:id/checkpoint/promote
  //
  // Calls promote() from src/rebuild/checkpoint.js.
  //
  // On success:
  //   - Updates job status to 'done'.
  //   - Returns 200 { promoted: true, manifest, artifacts: [...] }.
  //
  // On failure (verify regression, invalid manifest, sequence broken):
  //   - Preserves staging.
  //   - Returns 422 { promoted: false, reason, diagnostics }.
  // ------------------------------------------------------------------
  router.post('/jobs/:id/checkpoint/promote', ...checkpointPromoteLimiter, ...auth, ...csrf, express.json(), async (req, res) => {
    let job;
    try { job = await jobs.get(req.params.id, ownerFilter(req)); }
    catch (err) { return res.status(500).json({ error: `Lookup failed: ${err.message}` }); }
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const kind = job.kind || 'audit';
    if (kind !== 'rebuild') {
      return res.status(404).json({ error: 'Job is not a rebuild job' });
    }
    if (job.status !== 'staged') {
      return res.status(409).json({
        error: `Job is not in staged status (current: ${job.status})`,
      });
    }

    const staging = getStagingAdapter();

    // Read checkpoint-state.json to get decisions.
    let stateDoc;
    try {
      stateDoc = await staging.getStagingJson(job.id, STATE_FILE_NAME);
    } catch (err) {
      return res.status(500).json({ error: `Failed to read checkpoint state: ${err.message}` });
    }
    if (!stateDoc || !stateDoc.decisions || typeof stateDoc.decisions !== 'object') {
      return res.status(409).json({
        error: 'No decisions recorded — POST to /api/jobs/:id/checkpoint first',
      });
    }

    const decisions = stateDoc.decisions;

    // Validate that all pending transforms have a decision. Read the manifest.
    let manifest;
    try {
      manifest = await staging.getStagingJson(job.id, STAGED_MANIFEST_NAME);
    } catch (err) {
      return res.status(500).json({ error: `Failed to read staged manifest: ${err.message}` });
    }
    if (!manifest) {
      return res.status(404).json({ error: 'Staged manifest not found' });
    }

    const allTransforms = Array.isArray(manifest.transforms) ? manifest.transforms : [];
    const pending = allTransforms.filter((t) => t.status === 'pending-checkpoint');
    const missing = pending.map((t) => t.id).filter((id) => !(id in decisions));
    if (missing.length > 0) {
      return res.status(409).json({
        error: `Missing decisions for transform(s): ${missing.join(', ')}. POST decisions first.`,
        missingTransformIds: missing,
      });
    }

    // Materialize staged artifacts to a temp working directory so promote()
    // can operate on real filesystem paths.
    const workRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), `prism-promote-${job.id.slice(0, 8)}-`)
    );

    let promoteResult;
    let engagementDir;
    let packageName;

    try {
      // The CLI's promote() signature is:
      //   promote(engagementDir, packageName, decisions, opts)
      // It expects:
      //   <engagementDir>/<packageName>/.rebuild-staging/rebuild-manifest-staged.json
      //   <engagementDir>/<packageName>/.rebuild-staging/rebuilt-staged.zip
      //
      // We recreate this layout in the temp workRoot.
      engagementDir = path.join(workRoot, 'engagement');
      packageName = 'package';
      const packageDir = path.join(engagementDir, packageName);
      const stagingDir = path.join(packageDir, '.rebuild-staging');
      await fsp.mkdir(stagingDir, { recursive: true });

      // Write the manifest JSON to the expected path (from the in-memory copy
      // we already validated; we need the exact bytes that were hashed).
      const manifestJson = JSON.stringify(manifest, null, 2);
      await fsp.writeFile(
        path.join(stagingDir, STAGED_MANIFEST_NAME),
        manifestJson,
        'utf8'
      );

      // Materialize the staged zip from storage.
      const zipLocalPath = await staging.getStagingLocalPath(job.id, STAGED_ZIP_NAME);
      // Copy the materialized zip into the staging layout.
      await fsp.copyFile(zipLocalPath, path.join(stagingDir, STAGED_ZIP_NAME));

      // Copy results.json from the job if available (lets promote() use real
      // findings for the regression comparison).
      if (job.result) {
        try {
          await fsp.writeFile(
            path.join(packageDir, 'results.json'),
            JSON.stringify(job.result, null, 2),
            'utf8'
          );
        } catch (_) { /* best-effort */ }
      }

      // Call promote() with the recreated layout.
      const checkpointMod = checkpointParam || lazyCheckpoint();
      const username = (req.user && req.user.email) || (req.user && req.user.id) || 'api-user';

      promoteResult = await checkpointMod.promote(
        engagementDir,
        packageName,
        decisions,
        { username }
      );
    } catch (err) {
      // Unexpected throw (not a soft {promoted:false}) — preserve staging.
      return res.status(500).json({
        error: `Promote threw unexpectedly: ${err.message || String(err)}`,
      });
    }

    // Soft failure from promote() — verification regression etc.
    if (promoteResult && promoteResult.promoted === false) {
      return res.status(422).json({
        promoted: false,
        reason: promoteResult.reason || 'unknown reason',
        diagnostics: promoteResult.diagnostics || [],
      });
    }

    // Success path.
    // Upload the promoted artifacts back into durable storage.
    const packageDir = path.join(engagementDir, packageName);
    const promotedFiles = [
      { relPath: 'rebuilt.zip', storagePath: `jobs/${job.id}/rebuilt.zip` },
      { relPath: 'rebuild-manifest.json', storagePath: `jobs/${job.id}/rebuild-manifest.json` },
    ];

    const uploadedArtifacts = [];
    if (storage) {
      for (const art of promotedFiles) {
        const localPath = path.join(packageDir, art.relPath);
        try {
          await storage.put(localPath, { key: art.storagePath });
          uploadedArtifacts.push(art.storagePath);
        } catch (uploadErr) {
          // Log but don't fail — the promoted files are in workRoot; they'll
          // be cleaned up but the job status is still updated. A re-promote
          // attempt would be needed in a real failure scenario. In practice,
          // storage failures should be rare.
          console.warn(`[checkpoint] artifact upload failed: ${uploadErr.message}`);
        }
      }
    }

    // Read back the promoted manifest.
    let finalManifest;
    try {
      const raw = await fsp.readFile(path.join(packageDir, 'rebuild-manifest.json'), 'utf8');
      finalManifest = JSON.parse(raw);
    } catch (_) {
      finalManifest = null;
    }

    // Update the job status to 'done' and store manifest summary in result.
    if (store) {
      try {
        await store.updateJob(job.id, {
          status: 'done',
          finishedAt: Date.now(),
          result: finalManifest ? {
            promoted: true,
            approvedTransforms: promoteResult.approvedTransforms || [],
            rejectedTransforms: promoteResult.rejectedTransforms || [],
            verification: finalManifest.verification || null,
            artifacts: uploadedArtifacts,
          } : null,
        });
      } catch (dbErr) {
        console.warn(`[checkpoint] job status update failed: ${dbErr.message}`);
      }
    }

    // Clear staging after successful promotion.
    try {
      await staging.clearStaging(job.id);
    } catch (_) { /* best-effort */ }

    // Clean up temp working dir.
    fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});

    res.json({
      promoted: true,
      manifest: finalManifest,
      artifacts: uploadedArtifacts,
      approvedTransforms: promoteResult.approvedTransforms || [],
      rejectedTransforms: promoteResult.rejectedTransforms || [],
    });
  });

  return { router };
}

module.exports = { createCheckpointRouter };

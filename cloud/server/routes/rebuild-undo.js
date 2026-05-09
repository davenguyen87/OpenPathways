/**
 * Rebuild-undo route (Phase 12).
 *
 *   POST /api/jobs/:id/undo
 *
 * Reverse a single patch or transform from a completed rebuild job without
 * re-running the full rebuild orchestrator. Calls `src/rebuild/undo.js`
 * which re-packs the zip, updates the manifest, and re-renders diff/summary.
 *
 * Body: { patchId?: string, transformId?: string }
 * Exactly one of patchId / transformId is required (400 otherwise).
 *
 * Preconditions:
 *   - Job must exist and be owned by the requesting user (hosted mode).
 *   - job.kind === 'rebuild' (400 if not; fallback: row.kind field added by Agent #28).
 *   - job.status === 'done' (staged full-tier rebuilds in status='staged' must
 *     be reversed via the checkpoint endpoint, not undo).
 *
 * Response 200: { undone: true, kind: 'patch'|'transform', id, updatedManifest, diffHtml }
 * Response 422: { undone: false, reason }
 *
 * Writes an auth_audit_log row on every invocation (hosted mode) via
 * store.logAuthEvent({ userId, eventType: 'rebuild_undo', ... }).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

// Lazy default — tests can override via deps.undo.
function defaultUndo() {
  return require('../../../src/rebuild/undo').undo;
}

/**
 * @param {object} deps
 * @param {object} deps.jobs       - JobManager instance
 * @param {object} [deps.config]   - { isHosted, mode } from lib/mode.validate()
 * @param {function} [deps.requireAuth] - middleware that 401s when req.user is missing (hosted)
 * @param {function} [deps.csrfProtect] - csrf-csrf doubleCsrfProtection (hosted)
 * @param {object} [deps.store]    - store adapter (for audit log)
 * @param {object} [deps.storage]  - storage adapter (unused here; reserved for future)
 * @param {function} [deps._undo]  - injectable undo function (for tests; defaults to src/rebuild/undo)
 * @returns {{ router: import('express').Router }}
 */
function createRebuildUndoRouter({ jobs, config, requireAuth, csrfProtect, store, storage, _undo }) {
  if (!jobs) throw new Error('createRebuildUndoRouter: jobs (JobManager) is required');

  // Resolve the undo function: injected (tests) or lazy-loaded from src.
  const undoFn = _undo || defaultUndo();

  const isHosted = !!(config && config.isHosted);
  const authDisabled = !requireAuth;

  // Ownership filter — mirrors the pattern in audits.js.
  const ownerFilter = (req) => {
    if (!isHosted || authDisabled) return undefined;
    return { userId: req.user.id };
  };

  // Compose middleware chains conditionally (same pattern as audits.js).
  const auth = isHosted && requireAuth ? [requireAuth] : [];
  const csrf = isHosted && csrfProtect ? [csrfProtect] : [];

  // Rate limiter — only active in hosted mode (same pattern as routes/auth.js).
  // POST /api/jobs/:id/undo — moderate: 10/min per user.
  const undoLimiter = isHosted ? [rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user && req.user.id) || req.ip,
    message: { error: 'Too many undo requests. Try again in a minute.' },
  })] : [];

  const router = express.Router();
  router.use(express.json());

  // ------------------------------------------------------------------
  // POST /api/jobs/:id/undo
  // ------------------------------------------------------------------
  router.post('/jobs/:id/undo', ...undoLimiter, ...auth, ...csrf, async (req, res) => {
    const { patchId, transformId } = req.body || {};

    // ── Validate body ──────────────────────────────────────────────
    const hasPatch = typeof patchId === 'string' && patchId.trim() !== '';
    const hasTransform = typeof transformId === 'string' && transformId.trim() !== '';

    if (!hasPatch && !hasTransform) {
      return res.status(400).json({
        error: 'Exactly one of patchId or transformId is required',
      });
    }
    if (hasPatch && hasTransform) {
      return res.status(400).json({
        error: 'Provide either patchId or transformId, not both',
      });
    }

    // ── Load job (with ownership filter) ──────────────────────────
    let hot;
    try {
      hot = await jobs.get(req.params.id, ownerFilter(req));
    } catch (err) {
      return res.status(500).json({ error: `Lookup failed: ${err.message}` });
    }
    if (!hot) return res.status(404).json({ error: 'Job not found' });

    // ── Verify job kind ───────────────────────────────────────────
    // Agent #28 adds `kind` to the job row; read with fallback.
    if (hot.kind !== 'rebuild') {
      return res.status(404).json({ error: 'Job is not a rebuild job' });
    }

    // ── Verify job status ─────────────────────────────────────────
    // Only completed (promoted) rebuilds can be undone. Staged full-tier
    // rebuilds (status='staged') should be rejected via the checkpoint
    // endpoint instead.
    if (hot.status !== 'done') {
      return res.status(404).json({
        error: `Rebuild job is not done (status: ${hot.status}). Only completed rebuilds can be undone.`,
      });
    }

    // ── Resolve package path from the job ─────────────────────────
    // The job row should carry rebuiltPackagePath or we fall back to
    // options.outputDir / packageDir conventions (matching Agent #28's
    // rebuild job schema). Use options.packageDir if set; otherwise
    // derive from options.outputDir + packageName.
    const packageDir = hot.options && (hot.options.packageDir || hot.options.outputDir);
    if (!packageDir) {
      return res.status(422).json({
        undone: false,
        reason: 'Rebuild job has no packageDir; cannot locate rebuild-manifest.json',
      });
    }

    // ── Build undo ids shape ───────────────────────────────────────
    const ids = hasPatch
      ? { patches: [patchId.trim()], transforms: [] }
      : { patches: [], transforms: [transformId.trim()] };

    const kind = hasPatch ? 'patch' : 'transform';
    const targetId = hasPatch ? patchId.trim() : transformId.trim();

    // ── Invoke the undo engine ────────────────────────────────────
    // undo(engagementDir, packageName, ids, opts) — but cloud callers
    // already have the resolved packageDir. We synthesise the two args
    // so undo builds: path.join(engagementDir, packageName) === packageDir.
    const engagementDir = path.dirname(packageDir);
    const packageName = path.basename(packageDir);

    let undoResult;
    try {
      undoResult = await undoFn(engagementDir, packageName, ids, {
        username: (req.user && req.user.id) || 'cloud-api',
      });
    } catch (err) {
      // Discriminate: "not found in manifest" → 422; everything else → 500.
      const msg = err.message || String(err);
      const is422 =
        msg.includes('not found in manifest') ||
        msg.includes('not in "applied" status') ||
        msg.includes('belongs to transform') ||
        msg.includes('at least one patch id or transform id');

      if (is422) {
        // Write audit log even on expected failures.
        await _logAuditEvent(store, {
          userId: req.user ? req.user.id : null,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          jobId: req.params.id,
          kind,
          targetId,
          success: false,
          reason: msg,
        });
        return res.status(422).json({ undone: false, reason: msg });
      }

      return res.status(500).json({ error: `Undo failed: ${msg}` });
    }

    // ── Read rendered diff HTML (best-effort) ─────────────────────
    let diffHtml = null;
    const diffPath = path.join(packageDir, 'rebuild-diff.html');
    try {
      diffHtml = fs.readFileSync(diffPath, 'utf8');
    } catch (_) {
      // Non-fatal — the manifest update succeeded.
    }

    // ── Write audit log entry ─────────────────────────────────────
    await _logAuditEvent(store, {
      userId: req.user ? req.user.id : null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      jobId: req.params.id,
      kind,
      targetId,
      success: true,
      reason: null,
    });

    return res.status(200).json({
      undone: true,
      kind,
      id: targetId,
      updatedManifest: undoResult.manifest,
      diffHtml,
    });
  });

  return { router };
}

/**
 * Writes a row to auth_audit_log. No-ops gracefully when store is absent
 * or when logAuthEvent is not implemented (e.g., stub stores in tests).
 *
 * @param {object|null} store
 * @param {object} opts
 */
async function _logAuditEvent(store, { userId, ip, userAgent, jobId, kind, targetId, success, reason }) {
  if (!store || typeof store.logAuthEvent !== 'function') return;
  try {
    await store.logAuthEvent({
      userId: userId || null,
      eventType: 'rebuild_undo',
      ip: ip || null,
      userAgent: userAgent || null,
      occurredAt: Date.now(),
      details: { jobId, kind, targetId, success, reason: reason || null },
    });
  } catch (_) {
    // Audit-log failure must never surface to the caller.
  }
}

module.exports = { createRebuildUndoRouter };

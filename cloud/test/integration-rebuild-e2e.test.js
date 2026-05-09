/**
 * End-to-end integration tests for the Phase 12 rebuild / checkpoint / undo flow.
 *
 * These tests exercise the full audit→rebuild→promote→undo pipeline through the
 * HTTP layer, using:
 *   - A real in-memory SQLite store (fresh per test).
 *   - A mock JobManager that wraps the store (mirrors routes-rebuilds.test.js).
 *   - In-memory staging adapter (mirrors routes-checkpoints.test.js).
 *   - Stub checkpoint.promote() and undo() functions so no filesystem or
 *     Playwright work is required.
 *
 * Test coverage:
 *   Test 1 — safe rebuild end-to-end
 *   Test 2 — full rebuild → checkpoint → promote
 *   Test 3 — promote-failure rollback (422 preserves staging for retry)
 *   Test 4 — undo a patch from a completed safe rebuild
 *
 * All tests run in <30s total because no real audit or rebuild engine is invoked.
 * Job statuses are advanced synchronously through the store — the test controls
 * timing instead of waiting for an async worker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { createRebuildRouter } from '../server/routes/rebuilds.js';
import { createCheckpointRouter } from '../server/routes/checkpoints.js';
import { createRebuildUndoRouter } from '../server/routes/rebuild-undo.js';
import { SqliteStore } from '../server/store/sqlite.js';

// ---------------------------------------------------------------------------
// In-memory staging adapter (matches routes-checkpoints.test.js shape)
// ---------------------------------------------------------------------------

class MemStagingStorage {
  constructor() { this._store = new Map(); }
  driver() { return 'mem-staging'; }
  _key(jobId, relPath) { return `${jobId}::${relPath}`; }
  async putStaging(jobId, relPath, input) {
    const key = this._key(jobId, relPath);
    if (typeof input === 'string') {
      this._store.set(key, Buffer.from(input));
    } else if (Buffer.isBuffer(input)) {
      this._store.set(key, input);
    } else if (input && typeof input.read === 'function') {
      const chunks = [];
      await new Promise((res, rej) => {
        input.on('data', (c) => chunks.push(c));
        input.on('end', res);
        input.on('error', rej);
      });
      this._store.set(key, Buffer.concat(chunks));
    } else {
      this._store.set(key, Buffer.from(JSON.stringify(input)));
    }
    return key;
  }
  async getStaging(jobId, relPath) {
    const key = this._key(jobId, relPath);
    const buf = this._store.get(key);
    if (!buf) throw new Error(`Not found: ${key}`);
    const { Readable } = await import('stream');
    return Readable.from([buf]);
  }
  async getStagingLocalPath(jobId, relPath) {
    const os_ = await import('os');
    const path_ = await import('path');
    const fsp_ = (await import('fs')).promises;
    const key = this._key(jobId, relPath);
    const buf = this._store.get(key);
    if (!buf) throw new Error(`Not found: ${key}`);
    const tmp = path_.default.join(os_.default.tmpdir(), `mem-staging-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp_.writeFile(tmp, buf);
    return tmp;
  }
  async listStaging(jobId) {
    const prefix = `${jobId}::`;
    return [...this._store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
  async clearStaging(jobId) {
    const prefix = `${jobId}::`;
    for (const key of [...this._store.keys()]) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }
  async existsStaging(jobId, relPath) {
    return this._store.has(this._key(jobId, relPath));
  }
  async putStagingJson(jobId, relPath, value) {
    const json = JSON.stringify(value, null, 2);
    const { Readable } = await import('stream');
    const stream = Readable.from([Buffer.from(json)]);
    return this.putStaging(jobId, relPath, stream);
  }
  async getStagingJson(jobId, relPath) {
    try {
      const stream = await this.getStaging(jobId, relPath);
      const chunks = [];
      await new Promise((res, rej) => {
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', res);
        stream.on('error', rej);
      });
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) { return null; }
  }
}

// ---------------------------------------------------------------------------
// Mock JobManager factory (mirrors routes-rebuilds.test.js)
// ---------------------------------------------------------------------------

function makeMockJobs(store) {
  const hotCache = new Map();

  return {
    hot: hotCache,
    queue: [],
    _tick: vi.fn(),
    _newHot: vi.fn((row) => ({
      id: row.id,
      status: row.status,
      options: row.options || {},
      originalName: row.originalName,
      uploadPath: row.uploadPath,
      createdAt: row.createdAt,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      progress: [],
      batchId: null,
      userId: row.userId || null,
      kind: row.kind || 'rebuild',
      parentJobId: row.parentJobId || null,
      mode: row.mode || null,
      subscribers: new Set(),
      flushTimer: null,
      progressDirty: false,
      controller: new AbortController(),
      get signal() { return this.controller.signal; },
    })),
    get: vi.fn(async (id, filter) => {
      // Always re-read from store so status changes made directly via
      // store.updateJob() are visible to the router.
      const row = await store.getJob(id, filter);
      if (!row) return null;
      if (hotCache.has(id)) {
        // Merge latest status from the store into the cached hot object.
        const cached = hotCache.get(id);
        cached.status = row.status;
        cached.result = row.result;
        cached.finishedAt = row.finishedAt;
        return cached;
      }
      const hot = {
        id: row.id,
        status: row.status,
        options: row.options || {},
        originalName: row.originalName,
        uploadPath: row.uploadPath,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        error: row.error,
        result: row.result,
        progress: row.progress || [],
        batchId: row.batchId || null,
        userId: row.userId || null,
        kind: row.kind || 'audit',
        parentJobId: row.parentJobId || null,
        mode: row.mode || null,
        subscribers: new Set(),
        flushTimer: null,
        progressDirty: false,
        controller: new AbortController(),
        get signal() { return this.controller.signal; },
      };
      hotCache.set(id, hot);
      return hot;
    }),
    snapshot: vi.fn(async (id, filter) => {
      const row = await store.getJob(id, filter);
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        options: row.options || {},
        originalName: row.originalName,
        kind: row.kind || 'audit',
        parentJobId: row.parentJobId || null,
        mode: row.mode || null,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        error: row.error,
        summary: row.result ? {
          packageType: row.result.packageType,
          score: row.result.scorecard && row.result.scorecard.score,
          passed: row.result.scorecard && row.result.scorecard.passed,
          totalViolations: row.result.scorecard && row.result.scorecard.totalViolations,
          complete: row.result.complete,
        } : null,
      };
    }),
    subscribe: vi.fn(async (id, onEvent) => {
      const row = await store.getJob(id);
      if (!row) return null;
      if (row.status === 'done') {
        try { onEvent({ stage: '__done__', summary: {} }); } catch (_) {}
        return () => {};
      }
      return () => {};
    }),
    listSnapshots: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: crypto.randomUUID(), status: 'pending' })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a completed audit job into the store and return its id.
 */
async function insertDoneAuditJob(store, tmpDir, overrides = {}) {
  const id = crypto.randomUUID();
  await store.createJob({
    id,
    status: 'done',
    options: { standard: 'wcag21' },
    originalName: 'test-package.zip',
    uploadPath: path.join(tmpDir, 'test-package.zip'),
    createdAt: Date.now() - 5000,
    batchId: null,
    userId: null,
    uploadBytes: null,
    kind: 'audit',
    parentJobId: null,
    mode: null,
  });
  store.db.prepare(
    `UPDATE jobs SET result_json = ?, finished_at = ? WHERE id = ?`
  ).run(
    JSON.stringify({
      violations: [],
      scorecard: { score: 100, passed: true, totalViolations: 0 },
      packageType: 'scorm12',
      complete: true,
      ...overrides.result,
    }),
    Date.now(),
    id,
  );
  return id;
}

/**
 * Build a minimal v2 rebuild manifest with pending-checkpoint transforms.
 */
function makeFullManifest(overrides = {}) {
  return {
    schemaVersion: '2.0.0',
    packageName: 'test.zip',
    standard: 'wcag21',
    transforms: [
      {
        id: 'transform-0001',
        transformer: 'landmark-insertion',
        family: 'landmark',
        status: 'pending-checkpoint',
        summary: 'Inserted landmark region',
        judgment: null,
        patchIds: [],
        scope: { manifestEdited: false },
      },
      {
        id: 'transform-0002',
        transformer: 'widget-replacement-tabs',
        family: 'widget',
        status: 'pending-checkpoint',
        summary: 'Replaced tab widget',
        judgment: { verdict: 'AI-CONFIRMED' },
        patchIds: [],
        scope: { manifestEdited: false },
      },
    ],
    patches: [
      { id: 'patch-0001', status: 'applied', fixer: 'add-alt-text', file: 'index.html' },
    ],
    verification: { before: { violations: 5, criteriaFailed: 3 }, after: null },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build an Express app wired with all three Phase 12 routers.
 */
function buildApp({ jobs, store, staging, checkpointMod = null, undoFn = null, renderPreview = null }) {
  const app = express();
  app.use(express.json());

  const opts = {
    jobs,
    config: { isHosted: false, mode: 'local' },
    requireAuth: null,
    csrfProtect: null,
    store,
    queue: null,
  };

  const { router: rebuildRouter } = createRebuildRouter(opts);
  app.use('/api', rebuildRouter);

  const { router: checkpointRouter } = createCheckpointRouter({
    ...opts,
    storage: null,
    staging,
    checkpoint: checkpointMod,
    renderPreview: renderPreview || (() => Promise.resolve('<html>preview</html>')),
  });
  app.use('/api', checkpointRouter);

  const mockStore = {
    ...store,
    updateJob: vi.fn(async (...args) => store.updateJob(...args)),
    logAuthEvent: vi.fn(async () => {}),
  };

  const { router: undoRouter } = createRebuildUndoRouter({
    ...opts,
    store: mockStore,
    storage: null,
    _undo: undoFn,
  });
  app.use('/api', undoRouter);

  return { app, mockStore };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let store;
let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-e2e-'));
  await fs.writeFile(path.join(tmpDir, 'test-package.zip'), 'fake zip content');

  const dbPath = path.join(tmpDir, 'test.sqlite');
  store = new SqliteStore({ path: dbPath });
  await store.init();
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Test 1 — Safe rebuild end-to-end
// ===========================================================================

describe('Test 1: safe rebuild end-to-end', () => {
  it('POST rebuild → status pending → manually mark done → GET snapshot has schema 1.0.0', async () => {
    const jobs = makeMockJobs(store);
    const staging = new MemStagingStorage();
    const { app } = buildApp({ jobs, store, staging });

    // --- Step 1: create a completed audit job ---
    const auditId = await insertDoneAuditJob(store, tmpDir);

    // --- Step 2: POST /api/jobs/:id/rebuild with mode='safe' ---
    const rebuildResp = await request(app)
      .post(`/api/jobs/${auditId}/rebuild`)
      .send({ mode: 'safe' });

    expect(rebuildResp.status).toBe(202);
    expect(rebuildResp.body).toHaveProperty('jobId');
    const rebuildJobId = rebuildResp.body.jobId;

    // Verify rebuild job exists in the store.
    const rebuildRow = await store.getJob(rebuildJobId);
    expect(rebuildRow).toBeTruthy();
    expect(rebuildRow.kind).toBe('rebuild');
    expect(rebuildRow.parentJobId).toBe(auditId);
    expect(rebuildRow.mode).toBe('safe');
    expect(rebuildRow.status).toBe('pending');

    // Verify the rebuild job inherited the parent's uploadPath.
    const parentRow = await store.getJob(auditId);
    expect(rebuildRow.uploadPath).toBe(parentRow.uploadPath);

    // --- Step 3: Simulate the worker completing the rebuild ---
    // In a real deployment the worker would call src/rebuild/index.js.
    // Here we advance the status directly through the store.
    const safeManifest = {
      schemaVersion: '1.0.0',
      packageName: 'test-package.zip',
      standard: 'wcag21',
      patches: [{ id: 'patch-0001', status: 'applied', fixer: 'add-alt-text', file: 'index.html' }],
      transforms: [],
      verification: { before: { violations: 3 }, after: { violations: 0 } },
      createdAt: new Date().toISOString(),
    };
    await store.updateJob(rebuildJobId, {
      status: 'done',
      finishedAt: Date.now(),
      result: {
        manifest: safeManifest,
        rebuiltZipPath: path.join(tmpDir, 'rebuilt.zip'),
        complete: true,
      },
    });

    // --- Step 4: GET the rebuild job snapshot ---
    const snapResp = await request(app).get(`/api/rebuilds/${rebuildJobId}`);
    expect(snapResp.status).toBe(200);
    expect(snapResp.body.status).toBe('done');

    // --- Step 5: Assert manifest schema is 1.0.0 (safe tier) ---
    const row = await store.getJob(rebuildJobId);
    expect(row.result).toBeTruthy();
    expect(row.result.manifest.schemaVersion).toBe('1.0.0');
    expect(Array.isArray(row.result.manifest.patches)).toBe(true);
    expect(row.result.manifest.patches.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Test 2 — Full rebuild → checkpoint → promote
// ===========================================================================

describe('Test 2: full rebuild → checkpoint → promote', () => {
  it('creates a staged rebuild, records decisions, promotes successfully', async () => {
    const jobs = makeMockJobs(store);
    const staging = new MemStagingStorage();

    // Stub promote() to return a successful result.
    const fullManifest = makeFullManifest();
    const checkpointMod = {
      promote: vi.fn().mockResolvedValue({
        promoted: true,
        approvedTransforms: ['transform-0001', 'transform-0002'],
        rejectedTransforms: [],
        verificationAfter: { before: { violations: 5 }, after: { violations: 0 }, resolved: 5, introduced: 0 },
      }),
    };

    const { app } = buildApp({ jobs, store, staging, checkpointMod });

    // --- Step 1: create a completed audit job ---
    const auditId = await insertDoneAuditJob(store, tmpDir);

    // --- Step 2: POST /api/jobs/:id/rebuild with mode='full' ---
    const rebuildResp = await request(app)
      .post(`/api/jobs/${auditId}/rebuild`)
      .send({ mode: 'full', noCheckpoint: false });

    expect(rebuildResp.status).toBe(202);
    const rebuildJobId = rebuildResp.body.jobId;

    // --- Step 3: Simulate the worker completing to 'staged' status ---
    // Full-tier with checkpoint gate lands in status='staged', not 'done'.
    await store.updateJob(rebuildJobId, {
      status: 'staged',
      result: null, // no final result yet — awaiting checkpoint decision
    });

    // Pre-populate staging with the rebuild artifacts.
    await staging.putStagingJson(rebuildJobId, 'rebuild-manifest-staged.json', fullManifest);
    // Dummy staged zip so getStagingLocalPath() works.
    staging._store.set(`${rebuildJobId}::rebuilt-staged.zip`, Buffer.from('PK'));

    // --- Step 4: GET /api/jobs/:id/checkpoint — assert transforms non-empty ---
    const cpGetResp = await request(app).get(`/api/jobs/${rebuildJobId}/checkpoint`);
    expect(cpGetResp.status).toBe(200);
    expect(cpGetResp.body.jobId).toBe(rebuildJobId);
    expect(cpGetResp.body.status).toBe('staged');
    expect(Array.isArray(cpGetResp.body.transforms)).toBe(true);
    expect(cpGetResp.body.transforms.length).toBe(2);
    // Verify AI judgment surfaces correctly.
    const tabsTransform = cpGetResp.body.transforms.find((t) => t.id === 'transform-0002');
    expect(tabsTransform).toBeTruthy();
    expect(tabsTransform.judgment).toEqual({ verdict: 'AI-CONFIRMED' });

    // --- Step 5: POST decisions — approve all transforms ---
    const decisions = {
      'transform-0001': 'approve',
      'transform-0002': 'approve',
    };
    const cpPostResp = await request(app)
      .post(`/api/jobs/${rebuildJobId}/checkpoint`)
      .send({ decisions });

    expect(cpPostResp.status).toBe(200);
    expect(cpPostResp.body.jobId).toBe(rebuildJobId);
    const t1 = cpPostResp.body.transforms.find((t) => t.id === 'transform-0001');
    expect(t1.decision).toBe('approve');

    // Verify state was persisted to staging.
    const savedState = await staging.getStagingJson(rebuildJobId, 'checkpoint-state.json');
    expect(savedState).toBeTruthy();
    expect(savedState.decisions['transform-0001']).toBe('approve');
    expect(savedState.decisions['transform-0002']).toBe('approve');

    // --- Step 6: POST /checkpoint/promote ---
    const promoteResp = await request(app)
      .post(`/api/jobs/${rebuildJobId}/checkpoint/promote`);

    expect(promoteResp.status).toBe(200);
    expect(promoteResp.body.promoted).toBe(true);
    expect(checkpointMod.promote).toHaveBeenCalledOnce();

    // --- Step 7: Verify job status was updated to 'done' ---
    const finalRow = await store.getJob(rebuildJobId);
    expect(finalRow.status).toBe('done');
  });
});

// ===========================================================================
// Test 3 — Promote-failure rollback
// ===========================================================================

describe('Test 3: promote-failure rollback (422 preserves staging for retry)', () => {
  it('422 on promote failure and staging is preserved for retry', async () => {
    const jobs = makeMockJobs(store);
    const staging = new MemStagingStorage();

    // Stub promote() to return a soft verification failure.
    const checkpointMod = {
      promote: vi.fn().mockResolvedValue({
        promoted: false,
        reason: 'verification regression: 2 new finding(s) introduced after promotion',
        diagnostics: ['criterion 1.1.1 regressed'],
      }),
    };

    const { app } = buildApp({ jobs, store, staging, checkpointMod });

    // --- Step 1: create a completed audit job ---
    const auditId = await insertDoneAuditJob(store, tmpDir);

    // --- Step 2: POST rebuild with mode='full' ---
    const rebuildResp = await request(app)
      .post(`/api/jobs/${auditId}/rebuild`)
      .send({ mode: 'full', noCheckpoint: false });

    expect(rebuildResp.status).toBe(202);
    const rebuildJobId = rebuildResp.body.jobId;

    // --- Step 3: Advance job to staged ---
    const fullManifest = makeFullManifest();
    await store.updateJob(rebuildJobId, { status: 'staged', result: null });
    await staging.putStagingJson(rebuildJobId, 'rebuild-manifest-staged.json', fullManifest);
    staging._store.set(`${rebuildJobId}::rebuilt-staged.zip`, Buffer.from('PK'));

    // --- Step 4: Record complete decisions ---
    const manifestJson = JSON.stringify(fullManifest, null, 2);
    const hash = crypto.createHash('sha256').update(manifestJson).digest('hex');
    await staging.putStagingJson(rebuildJobId, 'checkpoint-state.json', {
      stateVersion: '1.0.0',
      manifestHash: hash,
      decisions: { 'transform-0001': 'approve', 'transform-0002': 'approve' },
      decidedBy: 'test-user',
      decidedAt: new Date().toISOString(),
    });

    // --- Step 5: POST promote — expect 422 ---
    const promoteResp = await request(app)
      .post(`/api/jobs/${rebuildJobId}/checkpoint/promote`);

    expect(promoteResp.status).toBe(422);
    expect(promoteResp.body.promoted).toBe(false);
    expect(promoteResp.body.reason).toMatch(/regression/i);

    // --- Step 6: Staging must still be present (not cleared on failure) ---
    const manifestStillPresent = await staging.existsStaging(rebuildJobId, 'rebuild-manifest-staged.json');
    expect(manifestStillPresent).toBe(true);
    const stateStillPresent = await staging.existsStaging(rebuildJobId, 'checkpoint-state.json');
    expect(stateStillPresent).toBe(true);

    // --- Step 7: GET /api/jobs/:id/checkpoint still returns staged state ---
    const checkpointResp = await request(app).get(`/api/jobs/${rebuildJobId}/checkpoint`);
    expect(checkpointResp.status).toBe(200);
    expect(checkpointResp.body.status).toBe('staged');
    expect(checkpointResp.body.transforms.length).toBe(2);

    // User can re-decide and retry (idempotent) — POST decisions again.
    const reDecideResp = await request(app)
      .post(`/api/jobs/${rebuildJobId}/checkpoint`)
      .send({ decisions: { 'transform-0001': 'approve', 'transform-0002': 'reject' } });
    expect(reDecideResp.status).toBe(200);
    const t2 = reDecideResp.body.transforms.find((t) => t.id === 'transform-0002');
    expect(t2.decision).toBe('reject');
  });
});

// ===========================================================================
// Test 4 — Undo a patch from a completed safe rebuild
// ===========================================================================

describe('Test 4: undo a patch from a completed safe rebuild', () => {
  it('POST /undo with a valid patchId returns 200 with undone=true', async () => {
    const jobs = makeMockJobs(store);
    const staging = new MemStagingStorage();

    // Stub the undo engine.
    const stubbedManifest = {
      schemaVersion: '1.0.0',
      patches: [{ id: 'patch-0001', status: 'reverted', fixer: 'add-alt-text', file: 'index.html' }],
      transforms: [],
      revertHistory: [{ revertedAt: new Date().toISOString(), revertedBy: 'cloud-api', patchIds: ['patch-0001'] }],
      verification: { before: { violations: 3 }, after: { violations: 2 } },
    };
    const undoFn = vi.fn().mockResolvedValue({
      manifest: stubbedManifest,
      rebuiltZipPath: path.join(tmpDir, 'rebuilt.zip'),
      reverted: ['patch-0001'],
      revertedTransforms: [],
    });

    const { app } = buildApp({ jobs, store, staging, undoFn });

    // --- Step 1: create a completed audit job ---
    const auditId = await insertDoneAuditJob(store, tmpDir);

    // --- Step 2: POST rebuild with mode='safe' ---
    const rebuildResp = await request(app)
      .post(`/api/jobs/${auditId}/rebuild`)
      .send({ mode: 'safe' });

    expect(rebuildResp.status).toBe(202);
    const rebuildJobId = rebuildResp.body.jobId;

    // Simulate the package directory that undo needs.
    const packageDir = path.join(tmpDir, 'engagement', 'package');
    await fs.mkdir(packageDir, { recursive: true });

    // --- Step 3: Simulate the rebuild completing with a manifest and packageDir ---
    // The undo router reads packageDir from hot.options (not from result).
    // We update the options column to inject the packageDir, mirroring what
    // the real worker would write when it resolves the output paths.
    store.db.prepare(`UPDATE jobs SET options = ? WHERE id = ?`).run(
      JSON.stringify({ mode: 'safe', packageDir }),
      rebuildJobId,
    );
    await store.updateJob(rebuildJobId, {
      status: 'done',
      finishedAt: Date.now(),
      result: {
        manifest: {
          schemaVersion: '1.0.0',
          patches: [{ id: 'patch-0001', status: 'applied', fixer: 'add-alt-text', file: 'index.html' }],
        },
        rebuiltZipPath: path.join(packageDir, 'rebuilt.zip'),
        complete: true,
      },
    });

    // Invalidate the hot cache so the router re-reads from the store.
    jobs.hot.clear();

    // --- Step 4: POST /api/jobs/:id/undo with patchId ---
    const undoResp = await request(app)
      .post(`/api/jobs/${rebuildJobId}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(undoResp.status).toBe(200);
    expect(undoResp.body.undone).toBe(true);
    expect(undoResp.body.kind).toBe('patch');
    expect(undoResp.body.id).toBe('patch-0001');
    expect(undoResp.body.updatedManifest).toEqual(stubbedManifest);

    // Verify the undo function was called with the correct arguments.
    expect(undoFn).toHaveBeenCalledOnce();
    const [engagementDir, packageName, ids] = undoFn.mock.calls[0];
    expect(packageName).toBe('package');
    expect(path.basename(engagementDir)).toBe('engagement');
    expect(ids).toMatchObject({ patches: ['patch-0001'], transforms: [] });
  });

  it('422 when undo engine throws "not found in manifest"', async () => {
    const jobs = makeMockJobs(store);
    const staging = new MemStagingStorage();

    const undoFn = vi.fn().mockRejectedValue(
      new Error('Patch "patch-9999" not found in manifest at "/tmp/rebuild-manifest.json".')
    );

    const { app } = buildApp({ jobs, store, staging, undoFn });

    const auditId = await insertDoneAuditJob(store, tmpDir);
    const rebuildResp = await request(app)
      .post(`/api/jobs/${auditId}/rebuild`)
      .send({ mode: 'safe' });

    const rebuildJobId = rebuildResp.body.jobId;
    const packageDir = path.join(tmpDir, 'engagement2', 'package');
    await fs.mkdir(packageDir, { recursive: true });

    // Inject packageDir into options (where the undo router reads it).
    store.db.prepare(`UPDATE jobs SET options = ? WHERE id = ?`).run(
      JSON.stringify({ mode: 'safe', packageDir }),
      rebuildJobId,
    );
    await store.updateJob(rebuildJobId, {
      status: 'done',
      finishedAt: Date.now(),
      result: { manifest: {}, complete: true },
    });
    jobs.hot.clear();

    const undoResp = await request(app)
      .post(`/api/jobs/${rebuildJobId}/undo`)
      .send({ patchId: 'patch-9999' });

    expect(undoResp.status).toBe(422);
    expect(undoResp.body.undone).toBe(false);
    expect(undoResp.body.reason).toMatch(/not found in manifest/i);
  });
});

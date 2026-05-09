/**
 * Tests for POST /api/jobs/:id/undo (Phase 12).
 *
 * The undo engine (src/rebuild/undo.js) is injected via the `_undo` dep so no
 * real filesystem or zip operations are exercised. We test:
 *
 *  - 400 when neither patchId nor transformId is provided
 *  - 400 when both patchId and transformId are provided
 *  - 404 when job is not a rebuild job (kind !== 'rebuild')
 *  - 404 when job is not in 'done' status
 *  - 200 success for patchId
 *  - 200 success for transformId
 *  - 422 when patchId is not found in manifest (undo engine throws)
 *  - 401 when auth is required in hosted mode and no user is present
 *  - audit log entry written on success and on 422
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

// createRebuildUndoRouter accepts a `_undo` dep — no need to vi.mock.
import { createRebuildUndoRouter } from '../server/routes/rebuild-undo.js';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let app;
let mockUndoFn;
let mockJobs;
let mockStore;
let tmpDir;

const REBUILD_JOB_ID = 'rebuild-job-001';
const AUDIT_JOB_ID = 'audit-job-001';
const STAGED_JOB_ID = 'staged-job-001';

// A minimal rebuild manifest returned by a successful undo call.
const STUB_MANIFEST = {
  schemaVersion: '1.0.0',
  patches: [{ id: 'patch-0001', status: 'reverted', fixer: 'add-alt-text', file: 'index.html' }],
  revertHistory: [{ revertedAt: '2026-05-08T00:00:00.000Z', revertedBy: 'cloud-api', patchIds: ['patch-0001'] }],
  verification: { before: { violations: 5 }, after: { violations: 3 }, resolved: 2, introduced: 0, remaining: 3 },
};

const STUB_UNDO_RESULT = {
  manifest: STUB_MANIFEST,
  rebuiltZipPath: '/tmp/prism-undo-test/rebuilt.zip',
  reverted: ['patch-0001'],
  revertedTransforms: [],
};

// Helper to build a stub job row.
function makeJob(overrides = {}) {
  return {
    id: REBUILD_JOB_ID,
    status: 'done',
    kind: 'rebuild',
    options: {
      packageDir: '/engagements/client-2026/compliance-101',
      outputDir: '/engagements/client-2026/compliance-101',
    },
    originalName: 'compliance-101.zip',
    uploadPath: '/uploads/compliance-101.zip',
    userId: 'user-abc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-undo-test-'));

  mockUndoFn = vi.fn().mockResolvedValue(STUB_UNDO_RESULT);

  // Stub job map: keyed by id.
  const jobMap = {
    [REBUILD_JOB_ID]: makeJob(),
    [AUDIT_JOB_ID]: makeJob({ id: AUDIT_JOB_ID, kind: 'audit' }),
    [STAGED_JOB_ID]: makeJob({ id: STAGED_JOB_ID, status: 'staged' }),
  };

  mockJobs = {
    get: vi.fn(async (id, filter) => {
      const job = jobMap[id] || null;
      if (!job) return null;
      // Hosted-mode ownership check: mimic job-manager behavior.
      if (filter && filter.userId !== undefined && job.userId !== filter.userId) {
        return null;
      }
      return job;
    }),
  };

  mockStore = {
    logAuthEvent: vi.fn(async () => {}),
  };

  // Default: local mode — no auth, no csrf.
  app = buildApp({ isHosted: false });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// App factory — builds an Express app with the undo router.
// ---------------------------------------------------------------------------

function buildApp({ isHosted = false, user = null } = {}) {
  const expressApp = express();
  expressApp.use(express.json());

  // In hosted mode inject a fake requireAuth *middleware* (not a factory)
  // that 401s unless req.user is set by the user-injection middleware below.
  const requireAuth = isHosted
    ? (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        next();
      }
    : null;

  // Inject a fake user on every request (to simulate a logged-in session).
  if (user) {
    expressApp.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }

  const { router } = createRebuildUndoRouter({
    jobs: mockJobs,
    config: { isHosted, mode: isHosted ? 'hosted' : 'local' },
    requireAuth,
    csrfProtect: null, // skip CSRF in tests
    store: mockStore,
    storage: null,
    _undo: mockUndoFn,   // injectable undo — no filesystem access
  });
  expressApp.use('/api', router);

  return expressApp;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('POST /api/jobs/:id/undo — input validation', () => {
  it('requires exactly one of patchId or transformId: 400 when neither is provided', async () => {
    const res = await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/patchId or transformId/i);
  });

  it('requires exactly one of patchId or transformId: 400 when both are provided', async () => {
    const res = await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001', transformId: 'transform-0001' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not both/i);
  });
});

describe('POST /api/jobs/:id/undo — job preconditions', () => {
  it('404s when job does not exist', async () => {
    const res = await request(app)
      .post('/api/jobs/nonexistent-job/undo')
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('404s when job is not a rebuild job (kind !== "rebuild")', async () => {
    const res = await request(app)
      .post(`/api/jobs/${AUDIT_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a rebuild job/i);
  });

  it('404s when job is not in done status (e.g. staged)', async () => {
    const res = await request(app)
      .post(`/api/jobs/${STAGED_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not done/i);
  });
});

describe('POST /api/jobs/:id/undo — successfully undoes a patch by patchId', () => {
  it('200 with undone=true, kind=patch, and manifest', async () => {
    const res = await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(200);
    expect(res.body.undone).toBe(true);
    expect(res.body.kind).toBe('patch');
    expect(res.body.id).toBe('patch-0001');
    expect(res.body.updatedManifest).toEqual(STUB_MANIFEST);
    // diffHtml may be null (no file on disk in test) — that's acceptable.
    expect('diffHtml' in res.body).toBe(true);
  });

  it('calls undo engine with patches shape', async () => {
    await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(mockUndoFn).toHaveBeenCalledOnce();
    const [engagementDir, packageName, ids] = mockUndoFn.mock.calls[0];
    // engagementDir = parent of packageDir; packageName = basename of packageDir
    expect(path.basename(engagementDir)).toBe('client-2026');
    expect(packageName).toBe('compliance-101');
    expect(ids).toMatchObject({ patches: ['patch-0001'], transforms: [] });
  });
});

describe('POST /api/jobs/:id/undo — successfully undoes a transform by transformId', () => {
  beforeEach(() => {
    mockUndoFn.mockResolvedValue({
      ...STUB_UNDO_RESULT,
      reverted: [],
      revertedTransforms: ['transform-0001'],
    });
  });

  it('200 with undone=true, kind=transform', async () => {
    const res = await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ transformId: 'transform-0001' });

    expect(res.status).toBe(200);
    expect(res.body.undone).toBe(true);
    expect(res.body.kind).toBe('transform');
    expect(res.body.id).toBe('transform-0001');
  });

  it('calls undo engine with transforms shape', async () => {
    await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ transformId: 'transform-0001' });

    expect(mockUndoFn).toHaveBeenCalledOnce();
    const [, , ids] = mockUndoFn.mock.calls[0];
    expect(ids).toMatchObject({ patches: [], transforms: ['transform-0001'] });
  });
});

describe('POST /api/jobs/:id/undo — 422s when patchId not found in manifest', () => {
  it('422 with undone=false when undo engine throws "not found in manifest"', async () => {
    mockUndoFn.mockRejectedValue(
      new Error('Patch "patch-9999" not found in manifest at "/engagements/.../rebuild-manifest.json".')
    );

    const res = await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-9999' });

    expect(res.status).toBe(422);
    expect(res.body.undone).toBe(false);
    expect(res.body.reason).toMatch(/not found in manifest/i);
  });

  it('422 when undo engine throws "not in applied status"', async () => {
    mockUndoFn.mockRejectedValue(
      new Error('Cannot undo: the following patches are not in "applied" status — patch-0001 (status: reverted)')
    );

    const res = await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(422);
    expect(res.body.undone).toBe(false);
    expect(res.body.reason).toMatch(/applied/i);
  });
});

describe('POST /api/jobs/:id/undo — requires auth in hosted mode', () => {
  it('401 when no user is authenticated in hosted mode', async () => {
    // Build hosted app with no user injected.
    const hostedApp = buildApp({ isHosted: true, user: null });

    const res = await request(hostedApp)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(401);
  });

  it('200 when user is authenticated in hosted mode and owns the job', async () => {
    const hostedApp = buildApp({ isHosted: true, user: { id: 'user-abc' } });

    const res = await request(hostedApp)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(200);
    expect(res.body.undone).toBe(true);
  });

  it('404 when authenticated user does not own the job', async () => {
    // user-xyz tries to undo a job owned by user-abc.
    const hostedApp = buildApp({ isHosted: true, user: { id: 'user-xyz' } });

    const res = await request(hostedApp)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    // ownerFilter causes jobs.get() to return null → 404.
    expect(res.status).toBe(404);
  });
});

describe('POST /api/jobs/:id/undo — writes an audit log entry', () => {
  it('writes an audit log entry on successful undo', async () => {
    await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(mockStore.logAuthEvent).toHaveBeenCalledOnce();
    const call = mockStore.logAuthEvent.mock.calls[0][0];
    expect(call.eventType).toBe('rebuild_undo');
    expect(call.details.jobId).toBe(REBUILD_JOB_ID);
    expect(call.details.kind).toBe('patch');
    expect(call.details.targetId).toBe('patch-0001');
    expect(call.details.success).toBe(true);
  });

  it('writes an audit log entry even on 422 failure', async () => {
    mockUndoFn.mockRejectedValue(
      new Error('Patch "patch-9999" not found in manifest at "/test/rebuild-manifest.json".')
    );

    await request(app)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-9999' });

    expect(mockStore.logAuthEvent).toHaveBeenCalledOnce();
    const call = mockStore.logAuthEvent.mock.calls[0][0];
    expect(call.eventType).toBe('rebuild_undo');
    expect(call.details.success).toBe(false);
    expect(call.details.reason).toMatch(/not found in manifest/i);
  });

  it('does not throw when store.logAuthEvent is unavailable', async () => {
    // Build app with a store that has no logAuthEvent method.
    const expressApp = express();
    expressApp.use(express.json());
    const { router } = createRebuildUndoRouter({
      jobs: mockJobs,
      config: { isHosted: false },
      requireAuth: null,
      csrfProtect: null,
      store: {}, // no logAuthEvent
      storage: null,
      _undo: mockUndoFn,
    });
    expressApp.use('/api', router);

    const res = await request(expressApp)
      .post(`/api/jobs/${REBUILD_JOB_ID}/undo`)
      .send({ patchId: 'patch-0001' });

    expect(res.status).toBe(200);
    expect(res.body.undone).toBe(true);
  });
});

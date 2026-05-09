/**
 * Tests for rebuild routes (Phase 12).
 *
 * Covers:
 *   POST /api/jobs/:id/rebuild  — create a rebuild job from a completed audit.
 *   GET  /api/rebuilds/:id      — snapshot.
 *   GET  /api/rebuilds/:id/events — SSE stream.
 *
 * Uses an in-memory SQLite store and a mocked JobManager (same pattern as
 * routes-batches.test.js). Does NOT exercise the rebuild engine itself — that
 * belongs in src/rebuild tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import http from 'http';
import { createRebuildRouter } from '../server/routes/rebuilds.js';
import { SqliteStore } from '../server/store/sqlite.js';

let app;
let store;
let mockJobs;
let tmpDir;

// Helper: insert a complete audit job row directly into the store.
async function createAuditJob(overrides = {}) {
  const id = crypto.randomUUID();
  const createdAt = Date.now() - 5000;
  await store.createJob({
    id,
    status: 'done',
    options: { standard: 'wcag21' },
    originalName: 'test-package.zip',
    uploadPath: path.join(tmpDir, 'test-package.zip'),
    createdAt,
    batchId: null,
    userId: null,
    uploadBytes: null,
    kind: 'audit',
    parentJobId: null,
    mode: null,
  });
  // Write a minimal result_json so the parent is "done with results".
  store.db
    .prepare(`UPDATE jobs SET result_json = ?, finished_at = ? WHERE id = ?`)
    .run(
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-rebuild-test-'));

  // Create a fake upload file so existsSync-type checks don't break.
  await fs.writeFile(path.join(tmpDir, 'test-package.zip'), 'fake zip content');

  const dbPath = path.join(tmpDir, 'test.sqlite');
  store = new SqliteStore({ path: dbPath });
  await store.init();

  // Mock JobManager. createJob in the router bypasses JobManager and writes
  // directly through the store, then calls jobs._newHot + jobs.hot.set.
  // We expose the minimal surface the router touches.
  const hotCache = new Map();

  mockJobs = {
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
      const row = await store.getJob(id, filter);
      if (!row) return null;
      if (hotCache.has(id)) return hotCache.get(id);
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
      // For terminal jobs, fire the appropriate event.
      if (row.status === 'done') {
        try { onEvent({ stage: '__done__', summary: {} }); } catch (_) {}
        return () => {};
      }
      if (row.status === 'error') {
        try { onEvent({ stage: '__error__', error: row.error }); } catch (_) {}
        return () => {};
      }
      // Pending: return a noop unsubscribe — SSE will hang until client disconnects.
      return () => {};
    }),
    listSnapshots: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: crypto.randomUUID(), status: 'pending' })),
  };

  app = express();
  // Note: createRebuildRouter mounts express.json() on the POST route itself;
  // we don't need it globally.

  const { router: rebuildRouter } = createRebuildRouter({
    jobs: mockJobs,
    config: { isHosted: false, mode: 'local' },
    requireAuth: null,
    csrfProtect: null,
    store,
    queue: null, // in-process: _tick dispatch
  });
  app.use('/api', rebuildRouter);
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:id/rebuild
// ---------------------------------------------------------------------------

describe('POST /api/jobs/:id/rebuild — creates a rebuild job from a completed audit', () => {
  it('creates a rebuild job and returns 202 with jobId', async () => {
    const parentId = await createAuditJob();

    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'safe' });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');
    expect(typeof res.body.jobId).toBe('string');

    // Verify the rebuild job exists in the store.
    const rebuildRow = await store.getJob(res.body.jobId);
    expect(rebuildRow).toBeTruthy();
    expect(rebuildRow.kind).toBe('rebuild');
    expect(rebuildRow.parentJobId).toBe(parentId);
    expect(rebuildRow.mode).toBe('safe');
    expect(rebuildRow.status).toBe('pending');
  });

  it('accepts assisted mode', async () => {
    const parentId = await createAuditJob();
    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'assisted' });
    expect(res.status).toBe(202);
    const rebuildRow = await store.getJob(res.body.jobId);
    expect(rebuildRow.mode).toBe('assisted');
  });

  it('accepts full mode', async () => {
    const parentId = await createAuditJob();
    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'full' });
    expect(res.status).toBe(202);
    const rebuildRow = await store.getJob(res.body.jobId);
    expect(rebuildRow.mode).toBe('full');
  });

  it('defaults to safe mode when mode is omitted', async () => {
    const parentId = await createAuditJob();
    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({});
    expect(res.status).toBe(202);
    const rebuildRow = await store.getJob(res.body.jobId);
    expect(rebuildRow.mode).toBe('safe');
  });

  it('copies the parent uploadPath into the rebuild job', async () => {
    const parentId = await createAuditJob();
    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'safe' });
    expect(res.status).toBe(202);
    const rebuildRow = await store.getJob(res.body.jobId);
    const parentRow = await store.getJob(parentId);
    expect(rebuildRow.uploadPath).toBe(parentRow.uploadPath);
  });
});

describe('POST /api/jobs/:id/rebuild — rejects when parent is missing', () => {
  it('returns 404 for a nonexistent parent job', async () => {
    const res = await request(app)
      .post(`/api/jobs/nonexistent-job-id/rebuild`)
      .send({ mode: 'safe' });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('POST /api/jobs/:id/rebuild — rejects when parent is not done', () => {
  it('returns 409 when parent job is still pending', async () => {
    // Create a pending audit job (no result_json)
    const id = crypto.randomUUID();
    await store.createJob({
      id,
      status: 'pending',
      options: {},
      originalName: 'test.zip',
      uploadPath: path.join(tmpDir, 'test-package.zip'),
      createdAt: Date.now(),
      batchId: null,
      userId: null,
      uploadBytes: null,
      kind: 'audit',
      parentJobId: null,
      mode: null,
    });

    const res = await request(app)
      .post(`/api/jobs/${id}/rebuild`)
      .send({ mode: 'safe' });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/not complete/i);
  });
});

describe('POST /api/jobs/:id/rebuild — rejects when mode is invalid', () => {
  it('returns 400 for unknown modes', async () => {
    const parentId = await createAuditJob();
    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'ultra' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/invalid rebuild mode/i);
  });

  it('returns 400 for empty mode string', async () => {
    const parentId = await createAuditJob();
    const res = await request(app)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid rebuild mode/i);
  });
});

describe('POST /api/jobs/:id/rebuild — enforces rebuild quota', () => {
  it('returns 429 when the user is at the rebuild concurrency cap', async () => {
    const parentId = await createAuditJob();

    // Inject a mocked store.getUserRebuildAggregate that reports the user is at cap.
    const originalFn = store.getUserRebuildAggregate.bind(store);
    store.getUserRebuildAggregate = vi.fn(async () => ({ concurrentRebuilds: 1 }));

    // Use the quotas module with QUOTA_CONCURRENT_REBUILDS=1 cap.
    const originalEnv = process.env.QUOTA_CONCURRENT_REBUILDS;
    process.env.QUOTA_CONCURRENT_REBUILDS = '1';

    // Rebuild a hosted-mode app so quota is enforced.
    const hostedApp = express();
    const { router: hostedRouter } = createRebuildRouter({
      jobs: mockJobs,
      config: { isHosted: true, mode: 'hosted' },
      requireAuth: null,   // auth disabled (no requireAuth fn) → authDisabled=true
      csrfProtect: null,
      store,
      queue: null,
    });
    hostedApp.use('/api', hostedRouter);

    const res = await request(hostedApp)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'safe' });

    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/quota/i);

    // Restore
    store.getUserRebuildAggregate = originalFn;
    if (originalEnv === undefined) {
      delete process.env.QUOTA_CONCURRENT_REBUILDS;
    } else {
      process.env.QUOTA_CONCURRENT_REBUILDS = originalEnv;
    }
  });
});

describe('POST /api/jobs/:id/rebuild — requires auth in hosted mode', () => {
  it('returns 401 when requireAuth is wired and no user is present', async () => {
    const parentId = await createAuditJob();

    // createAuditRouter receives the already-invoked middleware (see server/index.js
    // line: requireAuth: (cfg.isHosted && authEnabled) ? requireAuth() : null).
    // So we pass the actual middleware function, not a factory.
    const authMiddleware = (_req, res, _next) => {
      res.status(401).json({ error: 'Unauthorized' });
    };

    const hostedApp = express();
    const { router: hostedRouter } = createRebuildRouter({
      jobs: mockJobs,
      config: { isHosted: true, mode: 'hosted' },
      requireAuth: authMiddleware,
      csrfProtect: null,
      store,
      queue: null,
    });
    hostedApp.use('/api', hostedRouter);

    const res = await request(hostedApp)
      .post(`/api/jobs/${parentId}/rebuild`)
      .send({ mode: 'safe' });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/rebuilds/:id — snapshot
// ---------------------------------------------------------------------------

describe('GET /api/rebuilds/:id — snapshot', () => {
  it('returns snapshot for a rebuild job', async () => {
    const parentId = await createAuditJob();

    // Create a rebuild job in the store.
    const rebuildId = crypto.randomUUID();
    await store.createJob({
      id: rebuildId,
      status: 'pending',
      options: { mode: 'safe' },
      originalName: 'test-package.rebuilt.zip',
      uploadPath: path.join(tmpDir, 'test-package.zip'),
      createdAt: Date.now(),
      batchId: null,
      userId: null,
      uploadBytes: null,
      kind: 'rebuild',
      parentJobId: parentId,
      mode: 'safe',
    });

    const res = await request(app).get(`/api/rebuilds/${rebuildId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', rebuildId);
    expect(res.body.status).toBe('pending');
  });

  it('returns 404 for a nonexistent rebuild job', async () => {
    const res = await request(app).get(`/api/rebuilds/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/rebuilds/:id/events — SSE
// ---------------------------------------------------------------------------

describe('GET /api/rebuilds/:id/events — SSE stream', () => {
  async function captureSse(pathname, ms = 250) {
    return await new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        const chunks = [];
        // Use 'connection: close' so node closes the socket after the response
        // body ends — important for non-SSE (404/JSON) responses that don't
        // naturally keep-alive.
        const req = http.get(
          { hostname: '127.0.0.1', port, path: pathname, headers: { connection: 'close' } },
          (res) => {
            res.on('data', (c) => chunks.push(c.toString()));
            res.on('end', () => {
              // Non-SSE response: resolve immediately on stream end.
              clearTimeout(timer);
              server.close(() => {
                resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') });
              });
            });
            const timer = setTimeout(() => {
              req.destroy();
              server.close(() => {
                resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') });
              });
            }, ms);
          }
        );
        req.on('error', (err) => {
          if (err.code !== 'ECONNRESET') reject(err);
        });
      });
    });
  }

  it('returns 404 for a nonexistent job', async () => {
    const sse = await captureSse('/api/rebuilds/nonexistent/events', 150);
    expect(sse.status).toBe(404);
  });

  it('returns SSE headers for a pending job', async () => {
    const parentId = await createAuditJob();
    const rebuildId = crypto.randomUUID();
    await store.createJob({
      id: rebuildId,
      status: 'pending',
      options: { mode: 'safe' },
      originalName: 'test-package.rebuilt.zip',
      uploadPath: path.join(tmpDir, 'test-package.zip'),
      createdAt: Date.now(),
      batchId: null,
      userId: null,
      uploadBytes: null,
      kind: 'rebuild',
      parentJobId: parentId,
      mode: 'safe',
    });

    // Mock subscribe to simulate a live subscriber (pending job doesn't emit).
    const origSubscribe = mockJobs.subscribe;
    mockJobs.subscribe = vi.fn(async (_id, _onEvent) => () => {});

    const sse = await captureSse(`/api/rebuilds/${rebuildId}/events`, 200);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.headers['cache-control']).toContain('no-cache');

    mockJobs.subscribe = origSubscribe;
  });
});

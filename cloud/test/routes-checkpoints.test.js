/**
 * Tests for checkpoint routes (Phase 12).
 *
 * Covers:
 *   GET  /api/jobs/:id/checkpoint
 *   POST /api/jobs/:id/checkpoint
 *   POST /api/jobs/:id/checkpoint/promote
 *
 * Uses an in-memory staging adapter (no real filesystem / S3) and a
 * stub store / jobs mock so these tests run without Playwright or real
 * rebuild artifacts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createCheckpointRouter } from '../server/routes/checkpoints.js';

// ── Minimal in-memory staging adapter ────────────────────────────────────────

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
    // Write to a temp file and return its path
    const os = await import('os');
    const path = await import('path');
    const fsp = (await import('fs')).promises;
    const key = this._key(jobId, relPath);
    const buf = this._store.get(key);
    if (!buf) throw new Error(`Not found: ${key}`);
    const tmp = path.default.join(os.default.tmpdir(), `mem-staging-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.writeFile(tmp, buf);
    return tmp;
  }
  async listStaging(jobId) {
    const prefix = `${jobId}::`;
    return [...this._store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
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

// ── Helper builders ──────────────────────────────────────────────────────────

function makeManifest(transforms = []) {
  return {
    schemaVersion: '2.0.0',
    packageName: 'test.zip',
    standard: 'wcag21',
    transforms: transforms.length > 0 ? transforms : [
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
    patches: [],
    verification: { before: { violations: 5, criteriaFailed: 3, section508Failed: 1 }, after: null },
    createdAt: '2026-05-08T12:00:00Z',
  };
}

function makeJob(overrides = {}) {
  return {
    id: 'job-abc123',
    status: 'staged',
    kind: 'rebuild',
    uploadPath: '/tmp/test.zip',
    options: {},
    result: null,
    ...overrides,
  };
}

function buildApp({ job = makeJob(), manifest = makeManifest(), storeUpdates = {}, checkpointMod = null, renderPreview = null } = {}) {
  const stagingStore = new MemStagingStorage();

  // Pre-populate the staged manifest if job is in 'staged' state.
  if (job.status === 'staged' && manifest) {
    const json = JSON.stringify(manifest, null, 2);
    stagingStore._store.set(`${job.id}::rebuild-manifest-staged.json`, Buffer.from(json));
    // Also put a dummy zip so getStagingLocalPath works.
    stagingStore._store.set(`${job.id}::rebuilt-staged.zip`, Buffer.from('PK'));
  }

  const mockJobs = {
    get: vi.fn(async (id, _filter) => id === job.id ? job : null),
    listSnapshots: vi.fn(async () => [job]),
  };

  const mockStore = {
    updateJob: vi.fn(async () => {}),
    ...storeUpdates,
  };

  const app = express();
  app.use(express.json());

  const { router } = createCheckpointRouter({
    jobs: mockJobs,
    config: { isHosted: false, mode: 'local' },
    requireAuth: null,
    csrfProtect: null,
    store: mockStore,
    storage: null,
    staging: stagingStore,
    checkpoint: checkpointMod,
    renderPreview: renderPreview || (() => Promise.resolve('<html>preview</html>')),
  });
  app.use('/api', router);

  return { app, stagingStore, mockJobs, mockStore };
}

// ── GET tests ─────────────────────────────────────────────────────────────────

describe('GET /api/jobs/:id/checkpoint', () => {
  it('returns 404 when job is not found', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/jobs/nonexistent/checkpoint');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 when job is not a rebuild job', async () => {
    const { app } = buildApp({ job: makeJob({ kind: 'audit', status: 'done' }) });
    const res = await request(app).get('/api/jobs/job-abc123/checkpoint');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a rebuild/i);
  });

  it('returns 404 when job is not in staged status', async () => {
    const { app } = buildApp({ job: makeJob({ kind: 'rebuild', status: 'done' }) });
    const res = await request(app).get('/api/jobs/job-abc123/checkpoint');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not in staged/i);
  });

  it('returns 404 when job.kind is absent (defensive fallback for Agent #28 columns)', async () => {
    // kind absent — row.kind || 'audit' defaults to 'audit', so 404 expected.
    const { app } = buildApp({ job: makeJob({ kind: undefined, status: 'staged' }) });
    const res = await request(app).get('/api/jobs/job-abc123/checkpoint');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a rebuild/i);
  });

  it('returns staged state for a full-tier rebuild', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/jobs/job-abc123/checkpoint');
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('job-abc123');
    expect(res.body.status).toBe('staged');
    expect(Array.isArray(res.body.transforms)).toBe(true);
    expect(res.body.transforms).toHaveLength(2);
    expect(res.body.transforms[0].id).toBe('transform-0001');
    expect(res.body.transforms[0].decision).toBe('pending');
    expect(res.body.transforms[1].judgment).toEqual({ verdict: 'AI-CONFIRMED' });
    expect(typeof res.body.previewHtml).toBe('string');
    expect(res.body.previewHtml).toContain('<html>');
  });

  it('includes saved decisions from a prior POST', async () => {
    const { app, stagingStore } = buildApp();
    // Pre-populate decisions.
    const manifest = makeManifest();
    const manifestJson = JSON.stringify(manifest, null, 2);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(manifestJson).digest('hex');
    await stagingStore.putStagingJson('job-abc123', 'checkpoint-state.json', {
      stateVersion: '1.0.0',
      manifestHash: hash,
      decisions: { 'transform-0001': 'approve', 'transform-0002': 'reject' },
      decidedBy: 'test-user',
      decidedAt: new Date().toISOString(),
    });

    const res = await request(app).get('/api/jobs/job-abc123/checkpoint');
    expect(res.status).toBe(200);
    const t1 = res.body.transforms.find((t) => t.id === 'transform-0001');
    const t2 = res.body.transforms.find((t) => t.id === 'transform-0002');
    expect(t1.decision).toBe('approve');
    expect(t2.decision).toBe('reject');
  });
});

// ── POST decisions tests ───────────────────────────────────────────────────────

describe('POST /api/jobs/:id/checkpoint', () => {
  it('returns 404 when job is not found', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/nonexistent/checkpoint')
      .send({ decisions: { 'transform-0001': 'approve' } });
    expect(res.status).toBe(404);
  });

  it('returns 400 on invalid decisions payload (missing decisions key)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/job-abc123/checkpoint')
      .send({ bad: 'payload' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decisions/i);
  });

  it('returns 400 on invalid decision value', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/job-abc123/checkpoint')
      .send({ decisions: { 'transform-0001': 'maybe' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approve.*reject/i);
  });

  it('returns 400 when decisions reference unknown transformId', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/job-abc123/checkpoint')
      .send({ decisions: { 'transform-9999': 'approve' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown transformId/i);
  });

  it('persists decisions to staging and returns 200 with updated transforms', async () => {
    const { app, stagingStore } = buildApp();

    const res = await request(app)
      .post('/api/jobs/job-abc123/checkpoint')
      .send({ decisions: { 'transform-0001': 'approve', 'transform-0002': 'reject' } });

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('job-abc123');
    expect(Array.isArray(res.body.transforms)).toBe(true);
    const t1 = res.body.transforms.find((t) => t.id === 'transform-0001');
    const t2 = res.body.transforms.find((t) => t.id === 'transform-0002');
    expect(t1.decision).toBe('approve');
    expect(t2.decision).toBe('reject');

    // Verify checkpoint-state.json was written to staging.
    const state = await stagingStore.getStagingJson('job-abc123', 'checkpoint-state.json');
    expect(state).not.toBeNull();
    expect(state.decisions['transform-0001']).toBe('approve');
    expect(state.decisions['transform-0002']).toBe('reject');
    expect(state.stateVersion).toBe('1.0.0');
    expect(typeof state.manifestHash).toBe('string');
  });

  it('is idempotent — POSTing the same decisions twice is fine', async () => {
    const { app } = buildApp();
    const decisions = { 'transform-0001': 'approve', 'transform-0002': 'approve' };

    const r1 = await request(app)
      .post('/api/jobs/job-abc123/checkpoint')
      .send({ decisions });
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post('/api/jobs/job-abc123/checkpoint')
      .send({ decisions });
    expect(r2.status).toBe(200);
  });
});

// ── POST promote tests ─────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/checkpoint/promote', () => {
  it('returns 404 when job is not found', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/jobs/nonexistent/checkpoint/promote');
    expect(res.status).toBe(404);
  });

  it('returns 409 when no decisions have been recorded', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/jobs/job-abc123/checkpoint/promote');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no decisions/i);
  });

  it('returns 409 when decisions are missing for some pending transforms', async () => {
    const { app, stagingStore } = buildApp();

    // Save decisions for only one of the two pending transforms.
    const manifest = makeManifest();
    const manifestJson = JSON.stringify(manifest, null, 2);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(manifestJson).digest('hex');
    await stagingStore.putStagingJson('job-abc123', 'checkpoint-state.json', {
      stateVersion: '1.0.0',
      manifestHash: hash,
      decisions: { 'transform-0001': 'approve' }, // missing transform-0002
      decidedBy: 'user',
      decidedAt: new Date().toISOString(),
    });

    const res = await request(app).post('/api/jobs/job-abc123/checkpoint/promote');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/missing decisions/i);
    expect(res.body.missingTransformIds).toContain('transform-0002');
  });

  it('returns 200 with promoted:true when all decisions approve and verify passes', async () => {
    const manifest = makeManifest();
    const decisions = { 'transform-0001': 'approve', 'transform-0002': 'approve' };

    // Stub checkpoint.promote() to return success.
    const checkpointMod = {
      promote: vi.fn().mockResolvedValue({
        promoted: true,
        approvedTransforms: ['transform-0001', 'transform-0002'],
        rejectedTransforms: [],
        verificationAfter: { before: { violations: 5 }, after: { violations: 0 }, resolved: 5, introduced: 0, remaining: 0 },
      }),
    };

    const { app, stagingStore, mockStore } = buildApp({ checkpointMod });

    // Record decisions in staging so the route finds them.
    const manifestJson = JSON.stringify(manifest, null, 2);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(manifestJson).digest('hex');
    await stagingStore.putStagingJson('job-abc123', 'checkpoint-state.json', {
      stateVersion: '1.0.0',
      manifestHash: hash,
      decisions,
      decidedBy: 'user',
      decidedAt: new Date().toISOString(),
    });

    const res = await request(app).post('/api/jobs/job-abc123/checkpoint/promote');

    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(true);
    expect(checkpointMod.promote).toHaveBeenCalledOnce();

    // Verify the job status was updated to 'done'.
    expect(mockStore.updateJob).toHaveBeenCalledWith(
      'job-abc123',
      expect.objectContaining({ status: 'done' })
    );
  });

  it('returns 422 when verify fails (regression)', async () => {
    const manifest = makeManifest();
    const decisions = { 'transform-0001': 'approve', 'transform-0002': 'approve' };

    // Stub checkpoint.promote() to return soft failure.
    const checkpointMod = {
      promote: vi.fn().mockResolvedValue({
        promoted: false,
        reason: 'verification regression: 2 new finding(s) after promotion',
      }),
    };

    const { app, stagingStore } = buildApp({ checkpointMod });

    const manifestJson = JSON.stringify(manifest, null, 2);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(manifestJson).digest('hex');
    await stagingStore.putStagingJson('job-abc123', 'checkpoint-state.json', {
      stateVersion: '1.0.0',
      manifestHash: hash,
      decisions,
      decidedBy: 'user',
      decidedAt: new Date().toISOString(),
    });

    const res = await request(app).post('/api/jobs/job-abc123/checkpoint/promote');

    expect(res.status).toBe(422);
    expect(res.body.promoted).toBe(false);
    expect(res.body.reason).toMatch(/regression/i);
  });

  it('422 preserves staging for retry (staging NOT cleared on failure)', async () => {
    const manifest = makeManifest();
    const decisions = { 'transform-0001': 'approve', 'transform-0002': 'approve' };

    const checkpointMod = {
      promote: vi.fn().mockResolvedValue({
        promoted: false,
        reason: 'manifest xml: manifest xml is empty',
      }),
    };

    const { app, stagingStore } = buildApp({ checkpointMod });

    const manifestJson = JSON.stringify(manifest, null, 2);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(manifestJson).digest('hex');
    await stagingStore.putStagingJson('job-abc123', 'checkpoint-state.json', {
      stateVersion: '1.0.0',
      manifestHash: hash,
      decisions,
      decidedBy: 'user',
      decidedAt: new Date().toISOString(),
    });

    const res = await request(app).post('/api/jobs/job-abc123/checkpoint/promote');
    expect(res.status).toBe(422);

    // The staging manifest must still be there — not cleared.
    const stillThere = await stagingStore.existsStaging('job-abc123', 'rebuild-manifest-staged.json');
    expect(stillThere).toBe(true);
  });
});

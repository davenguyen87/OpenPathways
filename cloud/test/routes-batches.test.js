/**
 * Tests for batch audit routes (Phase 8).
 *
 * Covers POST /api/batches, POST /api/batches/:id/files, GET /api/batches/:id,
 * and the 410 response from the legacy POST /api/audits/batch.
 *
 * Uses an in-memory SQLite store with mocked JobManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { createBatchRouter } from '../server/routes/batches.js';
import { createAuditRouter } from '../server/routes/audits.js';
import { SqliteStore } from '../server/store/sqlite.js';

let app;
let store;
let mockJobs;
let tmpDir;

beforeEach(async () => {
  // Create a temporary directory for uploads
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-test-'));

  // Create in-memory SQLite store
  const dbPath = path.join(tmpDir, 'test.sqlite');
  store = new SqliteStore({ path: dbPath });
  await store.init();

  // Mock JobManager — must actually insert into the jobs table so the FK from
  // batch_files.job_id is satisfied. Real JobManager.create() does this via
  // store.createJob(); we replicate the persistence side-effect here.
  mockJobs = {
    create: vi.fn(async ({ uploadPath, options, originalName, batchId, userId, uploadBytes }) => {
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      await store.createJob({
        id,
        status: 'pending',
        options: options || {},
        originalName: originalName || null,
        uploadPath,
        createdAt,
        batchId: batchId || null,
        userId: userId || null,
        uploadBytes: uploadBytes || null,
      });
      return {
        id,
        status: 'pending',
        uploadPath,
        options,
        originalName,
        batchId,
        userId,
        uploadBytes,
      };
    }),
    listSnapshots: vi.fn(async () => []),
    snapshot: vi.fn(async () => null),
    subscribe: vi.fn(async () => null),
    get: vi.fn(async () => null),
  };

  // Create express app
  app = express();
  app.use(express.json());

  // Mount batch router
  const { router: batchRouter } = createBatchRouter({
    jobs: mockJobs,
    store,
    config: { isHosted: false, mode: 'local' },
    requireAuth: null,
    csrfProtect: null,
  });
  app.use('/api', batchRouter);

  // Mount audit router (for legacy 410 test)
  const { router: auditRouter } = createAuditRouter({
    jobs: mockJobs,
    config: { isHosted: false, mode: 'local' },
    requireAuth: null,
    csrfProtect: null,
    store,
  });
  app.use('/api', auditRouter);
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('POST /api/batches', () => {
  it('creates a batch with count=50 and returns 202', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({
        engagementId: 'eng_test123',
        label: 'Test batch',
        count: 50,
      });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('batchId');
    expect(res.body).toHaveProperty('expiresAt');
    expect(typeof res.body.batchId).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');

    // Verify batch exists in store
    const batch = await store.getBatch(res.body.batchId);
    expect(batch).toBeTruthy();
    expect(batch.engagementId).toBe('eng_test123');
    expect(batch.label).toBe('Test batch');
    expect(batch.status).toBe('active');
  });

  it('rejects count=51 with 413 batch_count_exceeded', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({
        engagementId: 'eng_test123',
        count: 51,
      });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('batch_count_exceeded');
    expect(res.body.error.message).toContain('50');
  });

  it('rejects missing engagementId with 400', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ count: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_field');
  });

  it('rejects missing count with 400', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ engagementId: 'eng_test' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_field');
  });
});

describe('POST /api/batches/:id/files', () => {
  let batchId;

  beforeEach(async () => {
    // Create a batch first
    const res = await request(app)
      .post('/api/batches')
      .send({ engagementId: 'eng_test', count: 50 });
    batchId = res.body.batchId;
  });

  it('uploads a file and returns 202 on first upload', async () => {
    const fileContent = Buffer.from('test zip content');
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    const res = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'test.zip');

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');
    expect(res.body.filename).toBe('test.zip');
    expect(res.body).toHaveProperty('uploadedAt');
  });

  it('returns 200 with same jobId on idempotent retry (same sha256)', async () => {
    const fileContent = Buffer.from('test zip content');
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    // First upload
    const res1 = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'test.zip');

    expect(res1.status).toBe(202);
    const jobId1 = res1.body.jobId;

    // Retry with same content
    const res2 = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'test.zip');

    expect(res2.status).toBe(200);
    expect(res2.body.jobId).toBe(jobId1);

    // Verify only one batch_files row exists
    const batchFiles = await store.findBatchFileByIdempotencyKey({
      batchId,
      sha256,
      filename: 'test.zip',
    });
    expect(batchFiles).toBeTruthy();
    expect(batchFiles.jobId).toBe(jobId1);
  });

  it('allows same filename with different sha256 (creates new job)', async () => {
    const content1 = Buffer.from('content v1');
    const sha256_1 = crypto.createHash('sha256').update(content1).digest('hex');

    const content2 = Buffer.from('content v2');
    const sha256_2 = crypto.createHash('sha256').update(content2).digest('hex');

    // First upload
    const res1 = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256_1)
      .attach('package', content1, 'module.zip');

    expect(res1.status).toBe(202);
    const jobId1 = res1.body.jobId;

    // Upload same filename, different content
    const res2 = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256_2)
      .attach('package', content2, 'module.zip');

    expect(res2.status).toBe(202);
    const jobId2 = res2.body.jobId;

    // Jobs must be different
    expect(jobId2).not.toBe(jobId1);
  });

  it('rejects missing X-Content-SHA256 header with 400', async () => {
    const res = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .attach('package', Buffer.from('content'), 'test.zip');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_field');
  });

  it('rejects missing package field with 400', async () => {
    const res = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', 'abc123');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_field');
  });

  it('returns 404 if batch not found', async () => {
    const content = Buffer.from('content');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    const res = await request(app)
      .post(`/api/batches/nonexistent/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', content, 'test.zip');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('batch_not_found');
  });

  it('returns 409 if batch not active', async () => {
    // Manually mark batch as complete
    store.db
      .prepare(`UPDATE batches SET status = 'complete' WHERE id = ?`)
      .run(batchId);

    const content = Buffer.from('content');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    const res = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', content, 'test.zip');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('batch_not_active');
  });
});

describe('GET /api/batches/:id', () => {
  let batchId;

  beforeEach(async () => {
    // Create a batch
    const res = await request(app)
      .post('/api/batches')
      .send({ engagementId: 'eng_test', label: 'My batch', count: 5 });
    batchId = res.body.batchId;
  });

  it('returns batch snapshot with correct shape', async () => {
    const res = await request(app)
      .get(`/api/batches/${batchId}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('batchId', batchId);
    expect(res.body).toHaveProperty('label', 'My batch');
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body).toHaveProperty('status', 'active');
    expect(res.body).toHaveProperty('jobs');
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it('returns 404 for nonexistent batch', async () => {
    const res = await request(app)
      .get(`/api/batches/nonexistent`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('batch_not_found');
  });

  it('includes jobs array with uploaded files', async () => {
    // Upload a file
    const fileContent = Buffer.from('test zip');
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    const uploadRes = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'module1.zip');

    expect(uploadRes.status).toBe(202);

    // Fetch batch
    const getRes = await request(app)
      .get(`/api/batches/${batchId}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.jobs.length).toBeGreaterThan(0);
    // Jobs array should contain objects with at least id
    expect(getRes.body.jobs[0]).toHaveProperty('id');
  });

  it('serializes jobs with filename + summary per contract §3', async () => {
    // Upload one file (will sit in 'pending' — summary should be null)
    const fileContent = Buffer.from('test zip pending');
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');
    await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'pending.zip');

    // Manually create a second job with a populated result so we can verify
    // summary is materialized for done jobs.
    const doneJobId = crypto.randomUUID();
    await store.createJob({
      id: doneJobId,
      status: 'done',
      options: {},
      originalName: 'done.zip',
      uploadPath: '/tmp/fake.zip',
      createdAt: Date.now(),
      batchId,
      userId: null,
      uploadBytes: null,
    });
    store.db
      .prepare(`UPDATE jobs SET result_json = ?, finished_at = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          packageType: 'scorm12',
          scorecard: { score: 87, passed: true, totalViolations: 4 },
          complete: true,
        }),
        Date.now(),
        doneJobId,
      );

    const res = await request(app).get(`/api/batches/${batchId}`);
    expect(res.status).toBe(200);

    const pending = res.body.jobs.find((j) => j.filename === 'pending.zip');
    const done = res.body.jobs.find((j) => j.filename === 'done.zip');

    // Pending job: filename mapped from originalName, summary null
    expect(pending).toBeDefined();
    expect(pending.status).toBe('pending');
    expect(pending.summary).toBeNull();

    // Done job: summary populated from result_json
    expect(done).toBeDefined();
    expect(done.status).toBe('done');
    expect(done.summary).toEqual({
      packageType: 'scorm12',
      score: 87,
      passed: true,
      totalViolations: 4,
      complete: true,
      incompleteReason: undefined,
    });
  });
});

describe('GET /api/batches/:id/events (SSE)', () => {
  let batchId;
  let jobId;

  beforeEach(async () => {
    // Create a batch
    const res = await request(app)
      .post('/api/batches')
      .send({ engagementId: 'eng_test', count: 5 });
    batchId = res.body.batchId;

    // Upload a file to get a jobId
    const fileContent = Buffer.from('test zip');
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    const uploadRes = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'module1.zip');

    jobId = uploadRes.body.jobId;
  });

  it('returns 404 if batch not found', async () => {
    const res = await request(app)
      .get(`/api/batches/nonexistent/events`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('batch_not_found');
  });

  // SSE responses are long-lived streams that don't end on their own.
  // supertest's request().get().end() never fires for these — it waits for the
  // response to terminate. We open a real http.get against a listening server,
  // collect chunks for a short window, then destroy the request.
  async function captureSse(pathname, ms = 250) {
    return await new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        const chunks = [];
        const req = http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
          res.on('data', (c) => chunks.push(c.toString()));
          setTimeout(() => {
            req.destroy();
            res.on('close', () => server.close(() => {
              resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') });
            }));
          }, ms);
        });
        req.on('error', (err) => {
          // Destroy may surface ECONNRESET; treat as expected close.
          if (err.code !== 'ECONNRESET') reject(err);
        });
      });
    });
  }

  it('sends initial batch event on connection', async () => {
    const sse = await captureSse(`/api/batches/${batchId}/events`);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.body).toContain('event: batch');
    expect(sse.body).toContain(batchId);
  });

  it('includes correct SSE headers', async () => {
    const sse = await captureSse(`/api/batches/${batchId}/events`, 100);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.headers['cache-control']).toContain('no-cache');
    expect(sse.headers['connection']).toBe('keep-alive');
  });
});

describe('GET /api/batches/:id/rollup.{format}', () => {
  let batchId;
  let jobId;

  beforeEach(async () => {
    // Create a batch
    const batchRes = await request(app)
      .post('/api/batches')
      .send({ engagementId: 'eng_test', count: 5 });
    batchId = batchRes.body.batchId;

    // Upload a file
    const fileContent = Buffer.from('test zip');
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    const uploadRes = await request(app)
      .post(`/api/batches/${batchId}/files`)
      .set('X-Content-SHA256', sha256)
      .attach('package', fileContent, 'module1.zip');

    jobId = uploadRes.body.jobId;
  });

  it('returns 404 if batch not found', async () => {
    const res = await request(app)
      .get(`/api/batches/nonexistent/rollup.html`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('batch_not_found');
  });

  it('returns 404 if batch has no jobs', async () => {
    // Create an empty batch with no files
    const batchRes = await request(app)
      .post('/api/batches')
      .send({ engagementId: 'eng_empty', count: 1 });
    const emptyBatchId = batchRes.body.batchId;

    const res = await request(app)
      .get(`/api/batches/${emptyBatchId}/rollup.html`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('batch_not_found');
  });

  it('returns 409 if batch is incomplete (jobs still running)', async () => {
    const res = await request(app)
      .get(`/api/batches/${batchId}/rollup.html`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('batch_incomplete');
  });

  it('returns 400 if format is invalid', async () => {
    const res = await request(app)
      .get(`/api/batches/${batchId}/rollup.pdf`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_format');
  });

  it('returns 200 with HTML when all jobs complete', async () => {
    // Manually mark job as done with a valid result
    const mockResult = {
      scorecard: { score: 85, passed: true, totalViolations: 0 },
      violations: [],
      packageType: 'scorm2004',
      complete: true,
    };

    store.db
      .prepare(`UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(mockResult), Date.now(), jobId);

    const res = await request(app)
      .get(`/api/batches/${batchId}/rollup.html`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<html');
  });

  it('returns 200 with Markdown when all jobs complete', async () => {
    // Mark job as done
    const mockResult = {
      scorecard: { score: 85, passed: true, totalViolations: 0 },
      violations: [],
      packageType: 'scorm2004',
      complete: true,
    };

    store.db
      .prepare(`UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(mockResult), Date.now(), jobId);

    const res = await request(app)
      .get(`/api/batches/${batchId}/rollup.md`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(typeof res.text).toBe('string');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('returns 200 with JSON when all jobs complete', async () => {
    // Mark job as done
    const mockResult = {
      scorecard: { score: 85, passed: true, totalViolations: 0 },
      violations: [],
      packageType: 'scorm2004',
      complete: true,
    };

    store.db
      .prepare(`UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(mockResult), Date.now(), jobId);

    const res = await request(app)
      .get(`/api/batches/${batchId}/rollup.json`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toHaveProperty('packageCount');
    expect(res.body).toHaveProperty('triageDistribution');
    expect(res.body).toHaveProperty('totalEffortHours');
  });

  it('includes engagementId in rollup', async () => {
    // Mark job as done
    const mockResult = {
      scorecard: { score: 85, passed: true, totalViolations: 0 },
      violations: [],
      packageType: 'scorm2004',
      complete: true,
    };

    store.db
      .prepare(`UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(mockResult), Date.now(), jobId);

    const res = await request(app)
      .get(`/api/batches/${batchId}/rollup.json`);

    expect(res.status).toBe(200);
    expect(res.body.packageCount).toBe(1);
    expect(res.body.cleanCount).toBe(1);
  });
});

describe('POST /api/audits/batch (legacy)', () => {
  it('returns 410 Gone with migration guidance', async () => {
    const res = await request(app)
      .post('/api/audits/batch')
      .attach('package', Buffer.from('content'), 'test.zip');

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('endpoint_removed');
    expect(res.body.error.message).toContain('POST /api/batches');
    expect(res.body.error.message).toContain('POST /api/batches/:id/files');
  });
});

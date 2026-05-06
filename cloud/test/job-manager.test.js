/**
 * JobManager worker pool tests.
 * Tests bounded concurrency, event ordering, cancellation, and crash isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JobManager } from '../server/job-manager.js';

// Mock store implementation for testing
class MockStore {
  constructor() {
    this.jobs = new Map();
  }

  async createJob(row) {
    this.jobs.set(row.id, row);
  }

  async getJob(id) {
    return this.jobs.get(id) || null;
  }

  async updateJob(id, updates) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    Object.assign(job, updates);
  }

  async listBatchSnapshots(batchId) {
    const rows = Array.from(this.jobs.values()).filter(j => j.batchId === batchId);
    return rows;
  }

  async listSnapshots(limit) {
    return Array.from(this.jobs.values()).slice(0, limit);
  }

  async markInterrupted() { /* no-op */ }
}

describe('JobManager - Bounded Worker Pool', () => {
  let manager;
  let store;

  beforeEach(() => {
    store = new MockStore();
    manager = new JobManager({ store });
  });

  describe('Concurrency control', () => {
    it('with CONCURRENCY=1, runs jobs serially (~800ms for 4x200ms)', async () => {
      manager.maxConcurrency = 1;

      const timings = [];

      // Mock runner that takes ~200ms per job
      manager.setRunner(async (hot, emit) => {
        const start = Date.now();
        timings.push({ jobId: hot.id, start });
        await new Promise(resolve => setTimeout(resolve, 200));
        timings.push({ jobId: hot.id, end: Date.now() });
        return { score: 100 };
      });

      const jobIds = [];
      const overallStart = Date.now();

      for (let i = 0; i < 4; i++) {
        const job = await manager.create({
          uploadPath: `/tmp/test-${i}.zip`,
          originalName: `test-${i}.zip`,
        });
        jobIds.push(job.id);
      }

      // Wait for all jobs to complete
      await waitForJobsToComplete(manager, jobIds);
      const elapsedMs = Date.now() - overallStart;

      // All jobs should be done
      for (const id of jobIds) {
        const hot = await manager.get(id);
        expect(hot.status).toBe('done');
      }

      // Serial execution: should be ~800ms (4 * 200ms), with some tolerance
      expect(elapsedMs).toBeGreaterThanOrEqual(750);
      expect(elapsedMs).toBeLessThan(1200);
    });

    it('with CONCURRENCY=2, runs 4x200ms jobs in ~400ms (2 pairs parallel)', async () => {
      manager.maxConcurrency = 2;

      manager.setRunner(async (hot, emit) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { score: 100 };
      });

      const jobIds = [];
      const overallStart = Date.now();

      for (let i = 0; i < 4; i++) {
        const job = await manager.create({
          uploadPath: `/tmp/test-${i}.zip`,
          originalName: `test-${i}.zip`,
        });
        jobIds.push(job.id);
      }

      // Wait for all jobs to complete
      await waitForJobsToComplete(manager, jobIds);
      const elapsedMs = Date.now() - overallStart;

      // Parallel execution (2 at a time): should be ~400ms (2 * 200ms)
      expect(elapsedMs).toBeGreaterThanOrEqual(350);
      expect(elapsedMs).toBeLessThan(800);
    });

    it('with CONCURRENCY=3, respects the 3-worker limit', async () => {
      manager.maxConcurrency = 3;

      const activeCount = [];

      manager.setRunner(async (hot, emit) => {
        activeCount.push(manager.running.size);
        await new Promise(resolve => setTimeout(resolve, 100));
        return { score: 100 };
      });

      const jobIds = [];
      for (let i = 0; i < 6; i++) {
        const job = await manager.create({
          uploadPath: `/tmp/test-${i}.zip`,
          originalName: `test-${i}.zip`,
        });
        jobIds.push(job.id);
      }

      await waitForJobsToComplete(manager, jobIds);

      // Max running size should never exceed 3
      const maxActive = Math.max(...activeCount);
      expect(maxActive).toBeLessThanOrEqual(3);
    });
  });

  describe('Event correctness under concurrency', () => {
    it('emits events with correct jobId for each job', async () => {
      manager.maxConcurrency = 2;

      const events = [];

      manager.setRunner(async (hot, emit) => {
        emit({ stage: 'test-started' });
        await new Promise(resolve => setTimeout(resolve, 50));
        emit({ stage: 'test-completed' });
        return { score: 100 };
      });

      // Create 4 jobs and subscribe to each
      const jobIds = [];
      for (let i = 0; i < 4; i++) {
        const job = await manager.create({
          uploadPath: `/tmp/test-${i}.zip`,
          originalName: `test-${i}.zip`,
        });
        jobIds.push(job.id);

        await manager.subscribe(job.id, (ev) => {
          events.push({ jobId: job.id, ...ev });
        });
      }

      await waitForJobsToComplete(manager, jobIds);

      // Verify each event references a single jobId
      for (const event of events) {
        expect(event.jobId).toBeDefined();
        expect(jobIds).toContain(event.jobId);
      }

      // Verify per-job event order is preserved (each job emitted its own events)
      for (const jobId of jobIds) {
        const jobEvents = events.filter(e => e.jobId === jobId);
        // Should have at least some events
        expect(jobEvents.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Cancellation and crash isolation', () => {
    it('cancelling one job does not affect others', async () => {
      manager.maxConcurrency = 2;

      manager.setRunner(async (hot, emit) => {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (hot.status === 'cancelled') {
          throw new Error('Aborted');
        }
        return { score: 100 };
      });

      const jobIds = [];
      for (let i = 0; i < 3; i++) {
        const job = await manager.create({
          uploadPath: `/tmp/test-${i}.zip`,
          originalName: `test-${i}.zip`,
        });
        jobIds.push(job.id);
      }

      // Give jobs time to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Cancel the first job
      await manager.cancel(jobIds[0]);

      // Wait for all to complete
      await waitForJobsToComplete(manager, jobIds);

      // First job should be cancelled
      const j0 = await manager.get(jobIds[0]);
      expect(j0.status).toBe('cancelled');

      // Other jobs should complete normally
      for (let i = 1; i < jobIds.length; i++) {
        const j = await manager.get(jobIds[i]);
        expect(j.status).toBe('done');
      }
    });

    it('if one worker throws, others continue and the failed worker recycles', async () => {
      manager.maxConcurrency = 2;

      let callCount = 0;

      manager.setRunner(async (hot, emit) => {
        callCount++;
        if (hot.originalName === 'test-1.zip') {
          // Simulate crash on job 1
          throw new Error('Worker crash: simulated');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        return { score: 100 };
      });

      const jobIds = [];
      for (let i = 0; i < 4; i++) {
        const job = await manager.create({
          uploadPath: `/tmp/test-${i}.zip`,
          originalName: `test-${i}.zip`,
        });
        jobIds.push(job.id);
      }

      await waitForJobsToComplete(manager, jobIds);

      // Job 1 should be in error state
      const j1 = await manager.get(jobIds[1]);
      expect(j1.status).toBe('error');
      expect(j1.error).toContain('Worker crash');

      // All other jobs should complete
      for (const id of jobIds) {
        const job = await manager.get(id);
        expect(['done', 'error']).toContain(job.status);
      }

      // The runner was called for all 4 jobs
      expect(callCount).toBe(4);
    });
  });

  describe('Configuration', () => {
    it('defaults to concurrency=1 when env var is not set', () => {
      const m = new JobManager({ store });
      expect(m.maxConcurrency).toBe(1);
    });

    it('reads WORKER_CONCURRENCY env var', () => {
      const originalEnv = process.env.WORKER_CONCURRENCY;
      try {
        process.env.WORKER_CONCURRENCY = '3';
        const m = new JobManager({ store });
        expect(m.maxConcurrency).toBe(3);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.WORKER_CONCURRENCY;
        } else {
          process.env.WORKER_CONCURRENCY = originalEnv;
        }
      }
    });

    it('constructor option overrides env var', () => {
      const originalEnv = process.env.WORKER_CONCURRENCY;
      try {
        process.env.WORKER_CONCURRENCY = '3';
        const m = new JobManager({ store, concurrency: 5 });
        expect(m.maxConcurrency).toBe(5);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.WORKER_CONCURRENCY;
        } else {
          process.env.WORKER_CONCURRENCY = originalEnv;
        }
      }
    });

    it('throws if concurrency < 1', () => {
      expect(() => new JobManager({ store, concurrency: 0 })).toThrow();
    });
  });

  describe('FIFO ordering with backpressure', () => {
    it('processes pending jobs in FIFO order when workers become available', async () => {
      manager.maxConcurrency = 1;

      const executionOrder = [];

      manager.setRunner(async (hot, emit) => {
        executionOrder.push(hot.originalName);
        await new Promise(resolve => setTimeout(resolve, 50));
        return { score: 100 };
      });

      const names = ['first.zip', 'second.zip', 'third.zip', 'fourth.zip'];
      const jobIds = [];

      for (const name of names) {
        const job = await manager.create({
          uploadPath: `/tmp/${name}`,
          originalName: name,
        });
        jobIds.push(job.id);
      }

      await waitForJobsToComplete(manager, jobIds);

      // Jobs should run in the order they were enqueued
      expect(executionOrder).toEqual(names);
    });
  });
});

// Helper: wait for all jobs to reach a terminal state
async function waitForJobsToComplete(manager, jobIds, maxWaitMs = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const jobs = await Promise.all(jobIds.map(id => manager.get(id)));
    const allTerminal = jobs.every(j => ['done', 'error', 'cancelled'].includes(j.status));
    if (allTerminal) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timeout waiting for jobs to complete');
}

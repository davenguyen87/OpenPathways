/**
 * Tests for staging-retention worker (Phase 12).
 *
 * Covers:
 *   - Expires staged rebuild jobs older than retentionDays.
 *   - Does NOT expire jobs younger than retentionDays.
 *   - Does NOT expire promoted (done/expired) jobs.
 *   - Calls clearStaging for each expired job.
 *   - Updates job status to 'expired'.
 *   - Handles missing staging adapter gracefully.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runStagingRetention } from '../server/lib/staging-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Minimal in-memory staging adapter ────────────────────────────────────────

function makeMemStaging(clearedJobs = []) {
  return {
    clearStaging: vi.fn(async (jobId) => { clearedJobs.push(jobId); }),
    _cleared: clearedJobs,
  };
}

// ── Minimal store stub ────────────────────────────────────────────────────────

function makeStore(jobs = []) {
  const rows = jobs.map((j) => ({ ...j }));

  // Simulate the sqlite db.prepare path used by the fallback.
  const dbLike = {
    prepare: vi.fn((sql) => ({
      all: vi.fn((cutoffMs) => {
        if (sql.includes("status = 'staged'")) {
          return rows.filter((r) => r.status === 'staged' && r.created_at < cutoffMs);
        }
        return [];
      }),
    })),
  };

  const updated = [];
  return {
    db: dbLike,
    updateJob: vi.fn(async (id, fields) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, fields);
      updated.push({ id, fields });
    }),
    listSnapshots: vi.fn(async () => rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      kind: r.kind || 'rebuild',
    }))),
    _rows: rows,
    _updated: updated,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runStagingRetention', () => {
  const retentionDays = 7;

  it('expires staged rebuild jobs older than retentionDays', async () => {
    const oldCreatedAt = Date.now() - (retentionDays + 1) * DAY_MS;
    const store = makeStore([
      { id: 'job-old', status: 'staged', kind: 'rebuild', created_at: oldCreatedAt },
    ]);
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toContain('job-old');
    expect(result.errors).toHaveLength(0);
    expect(staging.clearStaging).toHaveBeenCalledWith('job-old');
    expect(store.updateJob).toHaveBeenCalledWith('job-old', expect.objectContaining({ status: 'expired' }));
  });

  it('does NOT expire staged jobs younger than retentionDays', async () => {
    const recentCreatedAt = Date.now() - (retentionDays - 1) * DAY_MS;
    const store = makeStore([
      { id: 'job-new', status: 'staged', kind: 'rebuild', created_at: recentCreatedAt },
    ]);
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toHaveLength(0);
    expect(staging.clearStaging).not.toHaveBeenCalled();
    expect(store.updateJob).not.toHaveBeenCalled();
  });

  it('does NOT expire promoted (status=done) jobs', async () => {
    const oldCreatedAt = Date.now() - (retentionDays + 2) * DAY_MS;
    const store = makeStore([
      { id: 'job-done', status: 'done', kind: 'rebuild', created_at: oldCreatedAt },
    ]);
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toHaveLength(0);
    expect(staging.clearStaging).not.toHaveBeenCalled();
  });

  it('does NOT expire already-expired jobs', async () => {
    const oldCreatedAt = Date.now() - (retentionDays + 2) * DAY_MS;
    const store = makeStore([
      { id: 'job-expired', status: 'expired', kind: 'rebuild', created_at: oldCreatedAt },
    ]);
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toHaveLength(0);
    expect(staging.clearStaging).not.toHaveBeenCalled();
  });

  it('handles multiple jobs — only expires old ones', async () => {
    const oldAt = Date.now() - (retentionDays + 3) * DAY_MS;
    const newAt = Date.now() - 1 * DAY_MS;
    const store = makeStore([
      { id: 'job-old-1', status: 'staged', kind: 'rebuild', created_at: oldAt },
      { id: 'job-old-2', status: 'staged', kind: 'rebuild', created_at: oldAt },
      { id: 'job-new', status: 'staged', kind: 'rebuild', created_at: newAt },
    ]);
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toHaveLength(2);
    expect(result.expired).toContain('job-old-1');
    expect(result.expired).toContain('job-old-2');
    expect(result.expired).not.toContain('job-new');
    expect(staging.clearStaging).toHaveBeenCalledTimes(2);
  });

  it('returns empty expired list when no staged jobs exist', async () => {
    const store = makeStore([
      { id: 'job-audit', status: 'done', kind: 'audit', created_at: Date.now() - 10 * DAY_MS },
    ]);
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('continues processing remaining jobs when one clearStaging fails', async () => {
    const oldAt = Date.now() - (retentionDays + 1) * DAY_MS;
    const store = makeStore([
      { id: 'job-fail', status: 'staged', kind: 'rebuild', created_at: oldAt },
      { id: 'job-ok', status: 'staged', kind: 'rebuild', created_at: oldAt },
    ]);
    const staging = {
      clearStaging: vi.fn(async (jobId) => {
        if (jobId === 'job-fail') throw new Error('storage I/O error');
      }),
    };

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    // job-ok should still be expired; job-fail should be in errors.
    expect(result.expired).toContain('job-ok');
    expect(result.errors.some((e) => e.includes('job-fail'))).toBe(true);
  });

  it('uses listStagedOlderThan if the store exposes it', async () => {
    const oldAt = Date.now() - (retentionDays + 1) * DAY_MS;
    const jobs = [{ id: 'job-custom', status: 'staged', kind: 'rebuild', createdAt: oldAt }];
    const store = {
      listStagedOlderThan: vi.fn(async (_cutoff) => jobs),
      updateJob: vi.fn(async () => {}),
    };
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(store.listStagedOlderThan).toHaveBeenCalledOnce();
    expect(result.expired).toContain('job-custom');
  });

  it('gracefully handles store query failure', async () => {
    const store = {
      db: {
        prepare: vi.fn(() => { throw new Error('DB connection lost'); }),
      },
      updateJob: vi.fn(async () => {}),
      listSnapshots: vi.fn(async () => { throw new Error('DB connection lost'); }),
    };
    const staging = makeMemStaging();

    const result = await runStagingRetention({ store, storage: null, staging, retentionDays });

    expect(result.expired).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/DB connection lost/i);
  });

  it('works without a staging adapter (only updates job status)', async () => {
    const oldAt = Date.now() - (retentionDays + 1) * DAY_MS;
    const store = makeStore([
      { id: 'job-old', status: 'staged', kind: 'rebuild', created_at: oldAt },
    ]);

    // No staging adapter — should still update the job status.
    const result = await runStagingRetention({ store, storage: null, staging: null, retentionDays });

    expect(result.expired).toContain('job-old');
    expect(store.updateJob).toHaveBeenCalledWith('job-old', expect.objectContaining({ status: 'expired' }));
  });
});

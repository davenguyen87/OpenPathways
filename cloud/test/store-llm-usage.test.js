/**
 * Tests for workspace_llm_usage store methods (SqliteStore).
 *
 * Covers: recordLlmUsage persists rows, getLlmUsageRollup aggregates by feature,
 *         rollup respects the sinceMs time window, and cascade delete works.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import { SqliteStore } from '../server/store/sqlite.js';

let store;
let tmpDir;

async function createTestUser(s, id = crypto.randomUUID()) {
  await s.createUser({ id, email: `${id}@example.com`, createdAt: Date.now() });
  return id;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-llmusage-test-'));
  store = new SqliteStore({ path: path.join(tmpDir, 'test.sqlite') });
  await store.init();
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('recordLlmUsage', () => {
  it('persists a usage row and it shows up in getLlmUsageRollup', async () => {
    const userId = await createTestUser(store);

    await store.recordLlmUsage({
      userId,
      feature: 'narrative',
      model: 'claude-haiku-4-5',
      inputTokens: 1000,
      outputTokens: 200,
      estimatedCostUsd: 0.002,
    });

    const sinceMs = Date.now() - 10_000;
    const rollup = await store.getLlmUsageRollup(userId, sinceMs);

    expect(rollup.totalInputTokens).toBe(1000);
    expect(rollup.totalOutputTokens).toBe(200);
    expect(rollup.totalCostUsd).toBeCloseTo(0.002, 6);
    expect(rollup.byFeature['narrative']).toBeDefined();
    expect(rollup.byFeature['narrative'].tokens).toBe(1200);
    expect(rollup.byFeature['narrative'].cost).toBeCloseTo(0.002, 6);
  });

  it('assigns a unique UUID for each row (multiple inserts)', async () => {
    const userId = await createTestUser(store);

    await store.recordLlmUsage({
      userId, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001,
    });
    await store.recordLlmUsage({
      userId, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.002,
    });

    // Both rows should exist (separate UUIDs).
    const rows = store.db
      .prepare(`SELECT COUNT(*) as cnt FROM workspace_llm_usage WHERE user_id = ?`)
      .get(userId);
    expect(rows.cnt).toBe(2);
  });
});

describe('getLlmUsageRollup', () => {
  it('aggregates across multiple features', async () => {
    const userId = await createTestUser(store);
    const sinceMs = Date.now() - 5000;

    await store.recordLlmUsage({
      userId, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.001,
    });
    await store.recordLlmUsage({
      userId, feature: 'assisted', model: 'claude-haiku-4-5',
      inputTokens: 300, outputTokens: 60, estimatedCostUsd: 0.0006,
    });
    await store.recordLlmUsage({
      userId, feature: 'judgment', model: 'claude-sonnet-4-6',
      inputTokens: 200, outputTokens: 40, estimatedCostUsd: 0.003,
    });

    const rollup = await store.getLlmUsageRollup(userId, sinceMs);

    expect(rollup.totalInputTokens).toBe(1000);
    expect(rollup.totalOutputTokens).toBe(200);
    expect(rollup.totalCostUsd).toBeCloseTo(0.0046, 5);

    expect(rollup.byFeature['narrative']).toBeDefined();
    expect(rollup.byFeature['assisted']).toBeDefined();
    expect(rollup.byFeature['judgment']).toBeDefined();

    expect(rollup.byFeature['narrative'].tokens).toBe(600);
    expect(rollup.byFeature['assisted'].tokens).toBe(360);
    expect(rollup.byFeature['judgment'].tokens).toBe(240);
  });

  it('returns zeroed rollup when no rows exist', async () => {
    const userId = await createTestUser(store);
    const rollup = await store.getLlmUsageRollup(userId, Date.now() - 1000);

    expect(rollup.totalInputTokens).toBe(0);
    expect(rollup.totalOutputTokens).toBe(0);
    expect(rollup.totalCostUsd).toBe(0);
    expect(Object.keys(rollup.byFeature).length).toBe(0);
  });

  it('excludes rows older than sinceMs', async () => {
    const userId = await createTestUser(store);

    // Insert a row with occurred_at in the past by using raw SQL.
    const oldId = crypto.randomUUID();
    const oldTs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    store.db
      .prepare(
        `INSERT INTO workspace_llm_usage
           (id, user_id, feature, model, input_tokens, output_tokens, estimated_cost_usd, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(oldId, userId, 'narrative', 'claude-haiku-4-5', 9999, 999, 9.999, oldTs);

    // Recent row.
    await store.recordLlmUsage({
      userId, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.0001,
    });

    // 30-day window — should only see the recent row.
    const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const rollup = await store.getLlmUsageRollup(userId, sinceMs);

    expect(rollup.totalInputTokens).toBe(100);
    expect(rollup.totalOutputTokens).toBe(10);
  });

  it('isolates rollup by user — does not include other users rows', async () => {
    const userId1 = await createTestUser(store);
    const userId2 = await createTestUser(store);
    const sinceMs = Date.now() - 5000;

    await store.recordLlmUsage({
      userId: userId1, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.001,
    });
    await store.recordLlmUsage({
      userId: userId2, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 9999, outputTokens: 9999, estimatedCostUsd: 99.99,
    });

    const rollup1 = await store.getLlmUsageRollup(userId1, sinceMs);
    expect(rollup1.totalInputTokens).toBe(500);
    expect(rollup1.totalOutputTokens).toBe(100);
  });
});

describe('cascade delete', () => {
  it('deleting the user removes usage rows', async () => {
    const userId = await createTestUser(store);
    await store.recordLlmUsage({
      userId, feature: 'narrative', model: 'claude-haiku-4-5',
      inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.0001,
    });

    // Verify rows are present.
    const before = store.db
      .prepare(`SELECT COUNT(*) as cnt FROM workspace_llm_usage WHERE user_id = ?`)
      .get(userId);
    expect(before.cnt).toBeGreaterThan(0);

    // Delete the user — cascade should fire.
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);

    const after = store.db
      .prepare(`SELECT COUNT(*) as cnt FROM workspace_llm_usage WHERE user_id = ?`)
      .get(userId);
    expect(after.cnt).toBe(0);
  });
});

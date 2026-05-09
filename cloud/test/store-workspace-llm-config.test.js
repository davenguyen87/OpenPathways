/**
 * Tests for workspace_llm_config CRUD in SqliteStore (in-memory db).
 *
 * Uses an on-disk temp SQLite file (better-sqlite3 doesn't support ':memory:'
 * with WAL mode, and our store runs migrations on init). We clean up after
 * each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import { SqliteStore } from '../server/store/sqlite.js';

let store;
let tmpDir;

// Helper: create a user row so we can satisfy the FK from workspace_llm_config.
async function createTestUser(s, id = crypto.randomUUID()) {
  await s.createUser({ id, email: `${id}@example.com`, createdAt: Date.now() });
  return id;
}

// Sample config payload (the store doesn't do encryption — just stores the blob).
function fakeConfig(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    encryptedApiKey: 'base64fakeciphertext==',
    keyLast4: 'AbC4',
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-llmcfg-test-'));
  store = new SqliteStore({ path: path.join(tmpDir, 'test.sqlite') });
  await store.init();
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('getWorkspaceLlmConfig', () => {
  it('returns null when no row exists', async () => {
    const result = await store.getWorkspaceLlmConfig('no-such-user');
    expect(result).toBeNull();
  });
});

describe('setWorkspaceLlmConfig + getWorkspaceLlmConfig', () => {
  it('set then get round-trips the row', async () => {
    const userId = await createTestUser(store);
    const cfg = fakeConfig();
    await store.setWorkspaceLlmConfig(userId, cfg);

    const row = await store.getWorkspaceLlmConfig(userId);
    expect(row).not.toBeNull();
    expect(row.userId).toBe(userId);
    expect(row.provider).toBe('anthropic');
    expect(row.model).toBe('claude-haiku-4-5');
    expect(row.encryptedApiKey).toBe('base64fakeciphertext==');
    expect(row.keyLast4).toBe('AbC4');
    expect(typeof row.createdAt).toBe('number');
    expect(typeof row.updatedAt).toBe('number');
  });

  it('set is upsert — second set updates fields and advances updatedAt', async () => {
    const userId = await createTestUser(store);
    await store.setWorkspaceLlmConfig(userId, fakeConfig());
    const first = await store.getWorkspaceLlmConfig(userId);

    // Small delay so updated_at epoch has a chance to advance.
    await new Promise((r) => setTimeout(r, 5));

    await store.setWorkspaceLlmConfig(userId, fakeConfig({
      encryptedApiKey: 'newciphertext==',
      keyLast4: 'ZzZ9',
    }));
    const second = await store.getWorkspaceLlmConfig(userId);

    expect(second.encryptedApiKey).toBe('newciphertext==');
    expect(second.keyLast4).toBe('ZzZ9');
    // created_at must be preserved; updated_at must be >= original.
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('stores null model when model is not provided', async () => {
    const userId = await createTestUser(store);
    await store.setWorkspaceLlmConfig(userId, {
      provider: 'anthropic',
      encryptedApiKey: 'ct==',
      keyLast4: 'XxX1',
    });
    const row = await store.getWorkspaceLlmConfig(userId);
    expect(row.model).toBeNull();
  });
});

describe('deleteWorkspaceLlmConfig', () => {
  it('delete removes the row and returns true', async () => {
    const userId = await createTestUser(store);
    await store.setWorkspaceLlmConfig(userId, fakeConfig());
    const deleted = await store.deleteWorkspaceLlmConfig(userId);
    expect(deleted).toBe(true);
    const row = await store.getWorkspaceLlmConfig(userId);
    expect(row).toBeNull();
  });

  it('second delete returns false (already gone)', async () => {
    const userId = await createTestUser(store);
    await store.setWorkspaceLlmConfig(userId, fakeConfig());
    await store.deleteWorkspaceLlmConfig(userId);
    const second = await store.deleteWorkspaceLlmConfig(userId);
    expect(second).toBe(false);
  });

  it('delete on a non-existent user returns false', async () => {
    const result = await store.deleteWorkspaceLlmConfig('ghost-user-id');
    expect(result).toBe(false);
  });
});

describe('cascade delete', () => {
  it('deleting the user removes the llm config row', async () => {
    const userId = await createTestUser(store);
    await store.setWorkspaceLlmConfig(userId, fakeConfig());

    // Verify row is there.
    expect(await store.getWorkspaceLlmConfig(userId)).not.toBeNull();

    // Delete the user directly via raw SQL (the store doesn't expose deleteUser,
    // but the cascade FK should fire).
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);

    // The llm config should have cascaded away.
    const row = await store.getWorkspaceLlmConfig(userId);
    expect(row).toBeNull();
  });
});

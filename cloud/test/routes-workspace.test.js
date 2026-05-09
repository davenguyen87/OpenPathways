/**
 * Tests for workspace routes (Phase 12.5 + OpenRouter).
 *
 * Covers:
 *   GET    /api/workspace/llm-config        — read config (redacted)
 *   PUT    /api/workspace/llm-config        — store encrypted key
 *   DELETE /api/workspace/llm-config        — remove key
 *   POST   /api/workspace/llm-config/test   — test the key
 *
 * The crypto layer is exercised through the real encrypt/decrypt helpers
 * against a test DATA_ENCRYPTION_KEY. The real Anthropic API is never
 * called — getProvider is stubbed in the /test endpoint tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Stable test key ───────────────────────────────────────────────────────────

const TEST_DEK_HEX = crypto.randomBytes(32).toString('hex'); // 64 hex chars

// ── Load modules under test ───────────────────────────────────────────────────

// We need a fresh crypto module with a clean memoized key for each describe
// block that swaps env vars. For tests that just use a fixed key we can keep
// one module instance.
function loadCryptoFresh() {
  delete require.cache[require.resolve('../server/lib/crypto.js')];
  return require('../server/lib/crypto.js');
}

// Load workspace router factory (CJS from ESM test).
const { createWorkspaceRouter } = require('../server/routes/workspace.js');
const { SqliteStore } = require('../server/store/sqlite.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

let store;
let tmpDir;

async function createTestUser(id = crypto.randomUUID()) {
  await store.createUser({ id, email: `${id}@test.example`, createdAt: Date.now() });
  return id;
}

function makeApp({ userId = null, isHosted = false, requireAuth = null, csrfProtect = null } = {}) {
  // If userId is supplied we inject it as req.user so routes see an authed user.
  const app = express();
  if (userId) {
    app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  }
  const { router } = createWorkspaceRouter({
    store,
    config: { isHosted, mode: isHosted ? 'hosted' : 'local' },
    requireAuth,
    csrfProtect,
  });
  app.use('/api', router);
  return app;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-ws-test-'));
  store = new SqliteStore({ path: path.join(tmpDir, 'test.sqlite') });
  await store.init();

  // Set the test DEK before each test.
  process.env.DATA_ENCRYPTION_KEY = TEST_DEK_HEX;
  // Reset memo so crypto picks up the new env var.
  loadCryptoFresh()._resetMemo();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_ENCRYPTION_KEY;
  loadCryptoFresh()._resetMemo();
});

// ── GET /api/workspace/llm-config ─────────────────────────────────────────────

describe('GET /api/workspace/llm-config', () => {
  it('returns hasKey:false when no config exists', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app).get('/api/workspace/llm-config');
    expect(res.status).toBe(200);
    expect(res.body.hasKey).toBe(false);
    // Must not include plaintext or encrypted key fields.
    expect(res.body.encryptedApiKey).toBeUndefined();
    expect(res.body.apiKey).toBeUndefined();
  });

  it('returns redacted shape after PUT — never the plaintext or encrypted key', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    // Store a key via PUT.
    await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-api03-testkey12345' });

    const res = await request(app).get('/api/workspace/llm-config');
    expect(res.status).toBe(200);
    expect(res.body.hasKey).toBe(true);
    expect(res.body.provider).toBe('anthropic');
    expect(res.body.model).toBe('claude-haiku-4-5');
    // Last-4 of 'sk-ant-api03-testkey12345' is '2345'.
    expect(res.body.keyLast4).toBe('2345');
    // Must NEVER expose these fields.
    expect(res.body.encryptedApiKey).toBeUndefined();
    expect(res.body.apiKey).toBeUndefined();
  });
});

// ── PUT /api/workspace/llm-config ─────────────────────────────────────────────

describe('PUT /api/workspace/llm-config', () => {
  it('stores the encrypted key and last4 — GET never returns the plaintext', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const testKey = 'sk-ant-api03-validkeyabcdefgh';

    const putRes = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: testKey });
    expect(putRes.status).toBe(204);

    // Verify what's in the DB: encrypted blob should differ from the plaintext.
    const row = await store.getWorkspaceLlmConfig(userId);
    expect(row).not.toBeNull();
    expect(row.encryptedApiKey).not.toBe(testKey); // it's encrypted
    expect(row.keyLast4).toBe(testKey.slice(-4));

    // GET must not expose the encrypted blob or plaintext.
    const getRes = await request(app).get('/api/workspace/llm-config');
    expect(getRes.body.hasKey).toBe(true);
    expect(getRes.body.encryptedApiKey).toBeUndefined();
    expect(getRes.body.apiKey).toBeUndefined();
  });

  it('rejects non-anthropic provider with 400', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-openaikey12345678901' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/anthropic/i);
  });

  it('rejects a key shorter than 20 characters with 400', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'anthropic', apiKey: 'sk-short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too short|minimum/i);
  });

  it('rejects a key that does not start with sk- with 400', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'anthropic', apiKey: 'notsk-ant-api03-validkeyabcdefgh' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sk-/i);
  });
});

// ── DELETE /api/workspace/llm-config ──────────────────────────────────────────

describe('DELETE /api/workspace/llm-config', () => {
  it('removes the config and returns 204', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    // Store a key first.
    await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'anthropic', apiKey: 'sk-ant-api03-validkeyabcdefgh' });

    const delRes = await request(app).delete('/api/workspace/llm-config');
    expect(delRes.status).toBe(204);

    // Verify it's gone.
    const getRes = await request(app).get('/api/workspace/llm-config');
    expect(getRes.body.hasKey).toBe(false);
  });

  it('returns 404 when no config exists', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app).delete('/api/workspace/llm-config');
    expect(res.status).toBe(404);
  });
});

// ── Auth in hosted mode ───────────────────────────────────────────────────────

describe('requires auth in hosted mode', () => {
  it('returns 401 on GET when requireAuth middleware rejects', async () => {
    // No userId injected → req.user undefined.
    const authMiddleware = (_req, res, _next) => {
      res.status(401).json({ error: 'Unauthorized' });
    };
    const app = makeApp({ isHosted: true, requireAuth: authMiddleware });

    const res = await request(app).get('/api/workspace/llm-config');
    expect(res.status).toBe(401);
  });

  it('returns 401 on PUT when requireAuth middleware rejects', async () => {
    const authMiddleware = (_req, res, _next) => {
      res.status(401).json({ error: 'Unauthorized' });
    };
    const app = makeApp({ isHosted: true, requireAuth: authMiddleware });

    const res = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'anthropic', apiKey: 'sk-ant-api03-validkeyabcdefgh' });
    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE when requireAuth middleware rejects', async () => {
    const authMiddleware = (_req, res, _next) => {
      res.status(401).json({ error: 'Unauthorized' });
    };
    const app = makeApp({ isHosted: true, requireAuth: authMiddleware });

    const res = await request(app).delete('/api/workspace/llm-config');
    expect(res.status).toBe(401);
  });
});

// ── POST /api/workspace/llm-config/test ───────────────────────────────────────

describe('POST /api/workspace/llm-config/test', () => {
  it('calls getProvider and returns { ok: true, latencyMs } on success', async () => {
    const userId = await createTestUser();

    // Stub getProvider on the shared CJS module object. The workspace router
    // calls llmProvider.getProvider() through the same cached module, so
    // replacing the export here intercepts the call in the router.
    const llmProviderModule = require('../../src/lib/llm-provider.js');

    // Replace getProvider with a stub that returns a fake provider.
    const fakeProvider = {
      name: 'anthropic',
      model: 'claude-haiku-4-5',
      generate: vi.fn().mockResolvedValue({
        text: 'OK',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 5, outputTokens: 1 },
        latencyMs: 200,
      }),
    };
    const originalGetProvider = llmProviderModule.getProvider;
    llmProviderModule.getProvider = vi.fn().mockReturnValue(fakeProvider);

    try {
      // Store a key first.
      const appForPut = makeApp({ userId });
      await request(appForPut)
        .put('/api/workspace/llm-config')
        .send({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-api03-validkeyabcdefgh' });

      // Now test using the stored key (no apiKey in body).
      const appForTest = makeApp({ userId });
      const res = await request(appForTest)
        .post('/api/workspace/llm-config/test')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(fakeProvider.generate).toHaveBeenCalledOnce();
    } finally {
      // Restore the original.
      llmProviderModule.getProvider = originalGetProvider;
    }
  });

  it('returns { ok: false, error } when the provider throws', async () => {
    const userId = await createTestUser();
    const llmProviderModule = require('../../src/lib/llm-provider.js');

    const failingProvider = {
      name: 'anthropic',
      model: 'claude-haiku-4-5',
      generate: vi.fn().mockRejectedValue(new Error('authentication_error: invalid API key')),
    };
    const originalGetProvider = llmProviderModule.getProvider;
    llmProviderModule.getProvider = vi.fn().mockReturnValue(failingProvider);

    try {
      const appForPut = makeApp({ userId });
      await request(appForPut)
        .put('/api/workspace/llm-config')
        .send({ provider: 'anthropic', apiKey: 'sk-ant-api03-validkeyabcdefgh' });

      const appForTest = makeApp({ userId });
      const res = await request(appForTest)
        .post('/api/workspace/llm-config/test')
        .send({});

      expect(res.status).toBe(200); // route always returns 200 with ok:false
      expect(res.body.ok).toBe(false);
      expect(typeof res.body.error).toBe('string');
    } finally {
      llmProviderModule.getProvider = originalGetProvider;
    }
  });

  it('returns 400 when no key is stored and no apiKey provided in body', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app)
      .post('/api/workspace/llm-config/test')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('accepts an apiKey in the body (test before save)', async () => {
    const userId = await createTestUser();
    const llmProviderModule = require('../../src/lib/llm-provider.js');

    const fakeProvider = {
      name: 'anthropic',
      model: 'claude-haiku-4-5',
      generate: vi.fn().mockResolvedValue({ text: 'OK', model: 'claude-haiku-4-5', usage: { inputTokens: 5, outputTokens: 1 }, latencyMs: 150 }),
    };
    const originalGetProvider = llmProviderModule.getProvider;
    llmProviderModule.getProvider = vi.fn().mockReturnValue(fakeProvider);

    try {
      const app = makeApp({ userId });
      // No stored key; provide inline.
      const res = await request(app)
        .post('/api/workspace/llm-config/test')
        .send({ apiKey: 'sk-ant-api03-validkeyabcdefgh' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      llmProviderModule.getProvider = originalGetProvider;
    }
  });

  it('routes to openrouter provider when stored provider is openrouter', async () => {
    const userId = await createTestUser();
    const llmProviderModule = require('../../src/lib/llm-provider.js');

    const fakeProvider = {
      name: 'openrouter',
      model: 'anthropic/claude-haiku-4-5',
      generate: vi.fn().mockResolvedValue({
        text: 'OK',
        model: 'anthropic/claude-haiku-4-5',
        usage: { inputTokens: 5, outputTokens: 1 },
        latencyMs: 220,
      }),
    };
    const originalGetProvider = llmProviderModule.getProvider;
    llmProviderModule.getProvider = vi.fn().mockReturnValue(fakeProvider);

    try {
      // Store an openrouter key.
      const appForPut = makeApp({ userId });
      await request(appForPut)
        .put('/api/workspace/llm-config')
        .send({ provider: 'openrouter', model: 'anthropic/claude-haiku-4-5', apiKey: 'sk-or-v1-testkey12345678' });

      const appForTest = makeApp({ userId });
      const res = await request(appForTest)
        .post('/api/workspace/llm-config/test')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // getProvider must have been called with 'openrouter', not 'anthropic'.
      expect(llmProviderModule.getProvider).toHaveBeenCalledOnce();
      const callArgs = llmProviderModule.getProvider.mock.calls[0];
      expect(callArgs[0]).toBe('openrouter');
    } finally {
      llmProviderModule.getProvider = originalGetProvider;
    }
  });
});

// ── OpenRouter provider support ───────────────────────────────────────────────

describe('PUT /api/workspace/llm-config — OpenRouter provider', () => {
  it('accepts provider=openrouter with a valid sk-or-v1-... key', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const orKey = 'sk-or-v1-validopenrouterkey123456';
    const res = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'openrouter', model: 'anthropic/claude-haiku-4-5', apiKey: orKey });

    expect(res.status).toBe(204);

    // Verify stored config.
    const row = await store.getWorkspaceLlmConfig(userId);
    expect(row.provider).toBe('openrouter');
    expect(row.model).toBe('anthropic/claude-haiku-4-5');
    expect(row.keyLast4).toBe(orKey.slice(-4));
  });

  it('rejects provider=someother (whitelist check covers non-anthropic and non-openrouter)', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    const res = await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'someother', model: 'gpt-4o', apiKey: 'sk-someotherkey12345678901' });

    expect(res.status).toBe(400);
    // Error should name the accepted providers.
    expect(res.body.error).toMatch(/anthropic/i);
    expect(res.body.error).toMatch(/openrouter/i);
  });
});

describe('GET /api/workspace/llm-config — returns stored provider', () => {
  it('returns provider=openrouter in the redacted shape after PUT', async () => {
    const userId = await createTestUser();
    const app = makeApp({ userId });

    await request(app)
      .put('/api/workspace/llm-config')
      .send({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', apiKey: 'sk-or-v1-testkey9999999999' });

    const res = await request(app).get('/api/workspace/llm-config');
    expect(res.status).toBe(200);
    expect(res.body.hasKey).toBe(true);
    expect(res.body.provider).toBe('openrouter');
    expect(res.body.model).toBe('anthropic/claude-sonnet-4-6');
    // Must NEVER expose key material.
    expect(res.body.encryptedApiKey).toBeUndefined();
    expect(res.body.apiKey).toBeUndefined();
  });
});

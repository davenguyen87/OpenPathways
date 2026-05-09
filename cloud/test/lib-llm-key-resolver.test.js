/**
 * Tests for cloud/server/lib/llm-key-resolver.js
 *
 * Covers: resolveLlmConfig (workspace path + env fallback + null),
 *         injectLlmConfigForCall symmetry, and the decrypt round-trip
 *         end-to-end through the crypto module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Fresh loader so module-level state (crypto memoized DEK) doesn't leak.
function loadResolver() {
  delete require.cache[require.resolve('../server/lib/llm-key-resolver.js')];
  delete require.cache[require.resolve('../server/lib/crypto.js')];
  return require('../server/lib/llm-key-resolver.js');
}

function loadCrypto() {
  delete require.cache[require.resolve('../server/lib/crypto.js')];
  return require('../server/lib/crypto.js');
}

const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex');
const TEST_KEY_BUF = Buffer.from(TEST_KEY_HEX, 'hex');

// Encrypt an API key the same way the settings route would.
function encryptKey(plaintext) {
  const { encrypt } = loadCrypto();
  return encrypt(plaintext, TEST_KEY_BUF);
}

// Minimal store stub.
function makeStore(cfg = null) {
  return {
    async getWorkspaceLlmConfig(userId) {
      return cfg;
    },
  };
}

let savedEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.DATA_ENCRYPTION_KEY = TEST_KEY_HEX;
});

afterEach(() => {
  // Restore env
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe('resolveLlmConfig — null path', () => {
  it('returns null when userId is null and LLM_PROVIDER is not set', async () => {
    delete process.env.LLM_PROVIDER;
    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(null), null);
    expect(result).toBeNull();
  });

  it('returns null when store has no config and LLM_PROVIDER is not set', async () => {
    delete process.env.LLM_PROVIDER;
    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(null), 'user-1');
    expect(result).toBeNull();
  });
});

describe('resolveLlmConfig — workspace path', () => {
  it('returns workspace config when a stored key exists', async () => {
    const plaintext = 'sk-ant-api03-myworkspacekey';
    const encrypted = encryptKey(plaintext);
    const cfg = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      encryptedApiKey: encrypted,
      keyLast4: plaintext.slice(-4),
    };

    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(cfg), 'user-1');

    expect(result).not.toBeNull();
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.apiKey).toBe(plaintext);
  });

  it('decrypt round-trips correctly through resolveLlmConfig', async () => {
    const plaintext = 'sk-ant-secret-roundtrip-key';
    const encrypted = encryptKey(plaintext);
    const cfg = {
      provider: 'anthropic',
      model: null,
      encryptedApiKey: encrypted,
      keyLast4: plaintext.slice(-4),
    };

    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(cfg), 'user-2');

    expect(result.apiKey).toBe(plaintext);
    expect(result.model).toBeNull();
  });

  it('falls back to server env when store returns null (no workspace key)', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_MODEL = 'claude-haiku-4-5';
    process.env.MY_API_KEY = 'sk-server-wide-key';
    process.env.LLM_KEY_FROM_ENV = 'MY_API_KEY';

    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(null), 'user-3');

    expect(result).not.toBeNull();
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.apiKey).toBe('sk-server-wide-key');
  });
});

describe('resolveLlmConfig — env fallback path', () => {
  it('uses server env when userId is null', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_MODEL = 'claude-haiku-4-5';
    process.env.SERVER_LLM_KEY = 'sk-server-key-value';
    process.env.LLM_KEY_FROM_ENV = 'SERVER_LLM_KEY';

    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(null), null);

    expect(result).not.toBeNull();
    expect(result.provider).toBe('anthropic');
    expect(result.apiKey).toBe('sk-server-key-value');
  });

  it('returns apiKey as null when LLM_KEY_FROM_ENV env var is not set', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_KEY_FROM_ENV = 'NONEXISTENT_KEY_VAR';
    delete process.env.NONEXISTENT_KEY_VAR;

    const { resolveLlmConfig } = loadResolver();
    const result = await resolveLlmConfig(makeStore(null), null);

    expect(result).not.toBeNull();
    expect(result.apiKey).toBeNull();
  });
});

describe('injectLlmConfigForCall + _restore symmetry', () => {
  it('returns no-op values when resolvedConfig is null', () => {
    const { injectLlmConfigForCall } = loadResolver();
    const injected = injectLlmConfigForCall(null);

    expect(injected.llmProvider).toBeNull();
    expect(injected.llmKeyFromEnv).toBeNull();
    expect(injected.llmModel).toBeNull();
    expect(typeof injected._restore).toBe('function');
    // Calling _restore on a no-op should not throw.
    expect(() => injected._restore()).not.toThrow();
  });

  it('sets sentinel env var and cleans it up on _restore', () => {
    const { injectLlmConfigForCall, SENTINEL_ENV_VAR } = loadResolver();

    const resolvedConfig = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test-key-value',
    };

    const injected = injectLlmConfigForCall(resolvedConfig);

    // Sentinel should be set.
    expect(process.env[SENTINEL_ENV_VAR]).toBe('sk-test-key-value');
    expect(injected.llmProvider).toBe('anthropic');
    expect(injected.llmKeyFromEnv).toBe(SENTINEL_ENV_VAR);
    expect(injected.llmModel).toBe('claude-haiku-4-5');

    // After restore, sentinel should be gone.
    injected._restore();
    expect(process.env[SENTINEL_ENV_VAR]).toBeUndefined();
  });

  it('does not set sentinel when apiKey is null', () => {
    const { injectLlmConfigForCall, SENTINEL_ENV_VAR } = loadResolver();
    // Pre-set the sentinel to verify it gets cleared.
    process.env[SENTINEL_ENV_VAR] = 'stale-value';

    const resolvedConfig = {
      provider: 'anthropic',
      model: null,
      apiKey: null,
    };

    injectLlmConfigForCall(resolvedConfig);
    // With null apiKey the sentinel should be deleted, not left as stale.
    expect(process.env[SENTINEL_ENV_VAR]).toBeUndefined();
  });
});

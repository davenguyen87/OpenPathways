/**
 * Tests for cloud/server/lib/crypto.js
 *
 * Covers AES-256-GCM round-trips, auth-tag tamper detection, key derivation
 * rules, and the redactKey helper. All tests use Node's built-in crypto —
 * no external deps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// Dynamic import so we can reset module state between tests that swap env vars.
// vitest supports ESM dynamic imports; for CJS modules we use createRequire.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Pull fresh copies for each test group that needs a clean module state.
function loadCrypto() {
  // Clear require cache so _memoizedKey is reset between test suites.
  delete require.cache[require.resolve('../server/lib/crypto.js')];
  return require('../server/lib/crypto.js');
}

// A deterministic 32-byte key for most tests.
const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex'); // 64 hex chars
const TEST_KEY_BUF = Buffer.from(TEST_KEY_HEX, 'hex');

describe('encrypt / decrypt', () => {
  const { encrypt, decrypt } = loadCrypto();

  it('round-trips a string', () => {
    const plaintext = 'sk-ant-api03-supersecretkeyvalue';
    const ct = encrypt(plaintext, TEST_KEY_BUF);
    expect(typeof ct).toBe('string');
    // Ciphertext is base64: at minimum iv(12) + tag(16) + 1 byte = 29 bytes
    expect(Buffer.from(ct, 'base64').length).toBeGreaterThanOrEqual(29);
    const recovered = decrypt(ct, TEST_KEY_BUF);
    expect(recovered).toBe(plaintext);
  });

  it('produces different ciphertext each call (random IV)', () => {
    const plaintext = 'same-input';
    const ct1 = encrypt(plaintext, TEST_KEY_BUF);
    const ct2 = encrypt(plaintext, TEST_KEY_BUF);
    expect(ct1).not.toBe(ct2); // random IV means unique ciphertext per call
  });

  it('decrypt fails with a wrong key', () => {
    const plaintext = 'secret-value';
    const ct = encrypt(plaintext, TEST_KEY_BUF);
    const wrongKey = Buffer.from(crypto.randomBytes(32));
    expect(() => decrypt(ct, wrongKey)).toThrow(/authentication failed/i);
  });

  it('decrypt fails on a tampered ciphertext (bit-flip in ciphertext body)', () => {
    const ct = encrypt('original', TEST_KEY_BUF);
    const buf = Buffer.from(ct, 'base64');
    // Flip a byte in the ciphertext portion (after 28-byte header).
    buf[30] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered, TEST_KEY_BUF)).toThrow(/authentication failed/i);
  });

  it('decrypt fails on a tampered auth tag', () => {
    const ct = encrypt('original', TEST_KEY_BUF);
    const buf = Buffer.from(ct, 'base64');
    // Flip a byte inside the tag (bytes 12..27).
    buf[15] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered, TEST_KEY_BUF)).toThrow(/authentication failed/i);
  });

  it('throws if key is not a 32-byte Buffer', () => {
    expect(() => encrypt('x', Buffer.alloc(16))).toThrow(/32-byte/);
    expect(() => decrypt('abc', Buffer.alloc(16))).toThrow(/32-byte/);
  });
});

describe('deriveKey', () => {
  let deriveKey;

  beforeEach(() => {
    ({ deriveKey } = loadCrypto());
  });

  it('accepts a 64-char hex string and returns a 32-byte Buffer', () => {
    const hex = crypto.randomBytes(32).toString('hex'); // 64 chars
    const key = deriveKey(hex);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    // Same input must yield same output (deterministic for exact 32-byte input).
    expect(deriveKey(hex).equals(key)).toBe(true);
  });

  it('accepts a longer-than-32-byte hex string and derives a 32-byte key', () => {
    const hex = crypto.randomBytes(48).toString('hex'); // 96 chars → 48 raw bytes
    const key = deriveKey(hex);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    // Derived key must be distinct from the raw first 32 bytes.
    const raw32 = Buffer.from(hex.slice(0, 64), 'hex');
    expect(key.equals(raw32)).toBe(false);
  });

  it('throws on a too-short key (< 32 hex chars)', () => {
    const shortHex = 'deadbeef'; // 8 chars → 4 bytes
    expect(() => deriveKey(shortHex)).toThrow(/too short/i);
  });

  it('throws on a key that is exactly 32 hex chars (16 raw bytes, at minimum)', () => {
    // 32 hex chars = 16 raw bytes — this is the minimum accepted.
    // The spec says ">= 32 hex chars" is accepted; < 32 is rejected.
    // Exactly 32 should succeed.
    const hex = crypto.randomBytes(16).toString('hex'); // 32 chars
    expect(() => deriveKey(hex)).not.toThrow();
    const key = deriveKey(hex);
    expect(key.length).toBe(32);
  });

  it('throws on a non-hex string', () => {
    expect(() => deriveKey('not-hex-at-all!!!')).toThrow(/hex/i);
  });

  it('throws if envValue is empty', () => {
    expect(() => deriveKey('')).toThrow();
  });
});

describe('getDataEncryptionKey', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.DATA_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DATA_ENCRYPTION_KEY;
    } else {
      process.env.DATA_ENCRYPTION_KEY = originalEnv;
    }
  });

  it('returns a 32-byte Buffer when DATA_ENCRYPTION_KEY is set', () => {
    process.env.DATA_ENCRYPTION_KEY = TEST_KEY_HEX;
    const { getDataEncryptionKey, _resetMemo } = loadCrypto();
    _resetMemo();
    const key = getDataEncryptionKey();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('throws when DATA_ENCRYPTION_KEY is not set', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    const { getDataEncryptionKey, _resetMemo } = loadCrypto();
    _resetMemo();
    expect(() => getDataEncryptionKey()).toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it('memoizes — returns the same Buffer instance on repeated calls', () => {
    process.env.DATA_ENCRYPTION_KEY = TEST_KEY_HEX;
    const { getDataEncryptionKey, _resetMemo } = loadCrypto();
    _resetMemo();
    const k1 = getDataEncryptionKey();
    const k2 = getDataEncryptionKey();
    expect(k1).toBe(k2); // same reference
  });
});

describe('redactKey', () => {
  const { redactKey } = loadCrypto();

  it('returns sk-...XXXX where XXXX is the last 4 chars', () => {
    const result = redactKey('sk-ant-api03-supersecretAbC4');
    expect(result).toBe('sk-...AbC4');
  });

  it('handles a key that is exactly 4 chars', () => {
    const result = redactKey('AbC4');
    expect(result).toBe('sk-...AbC4');
  });

  it('handles short keys gracefully (< 4 chars)', () => {
    // Should not throw; returns something with last N chars
    const result = redactKey('ab');
    expect(typeof result).toBe('string');
    expect(result).toBe('sk-...ab');
  });

  it('handles an empty string gracefully', () => {
    const result = redactKey('');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-...');
  });

  it('handles a non-string input gracefully', () => {
    const result = redactKey(null);
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-...');
  });
});

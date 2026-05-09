/**
 * AES-256-GCM encryption helpers for workspace LLM keys.
 *
 * All crypto is built on Node's built-in `crypto` module — zero new deps.
 *
 * Wire format: base64( iv(12 bytes) || tag(16 bytes) || ciphertext )
 *
 * The 12-byte IV is randomly generated per encrypt call. The 16-byte
 * authentication tag (GCM default) follows immediately. The ciphertext
 * occupies the remainder. On decrypt, we split by these fixed offsets.
 *
 * Key derivation:
 *   - DATA_ENCRYPTION_KEY may be 64 hex chars (32 raw bytes) or longer.
 *   - Shorter values go through HKDF-Extract (SHA-256, no salt) to
 *     produce a 32-byte derived key. Minimum accepted raw entropy is
 *     16 bytes (32 hex chars) — anything shorter is rejected at startup.
 */

'use strict';

const crypto = require('crypto');

// Offsets within the decoded base64 buffer.
const IV_BYTES    = 12;
const TAG_BYTES   = 16;
const HEADER_BYTES = IV_BYTES + TAG_BYTES; // 28

// Memoized derived key — deriveKey is called once per process life.
let _memoizedKey = null;

/**
 * Derive a 32-byte AES key from an env value.
 *
 * Accepted forms:
 *   - 64-char hex string  → decoded as raw 32-byte key (no KDF needed)
 *   - 32–63 char hex (>= 16 raw bytes) → HKDF-Extract to 32 bytes
 *   - < 32 hex chars (< 16 raw bytes) → rejected with a clear error
 *
 * @param {string} envValue
 * @returns {Buffer} 32-byte key
 */
function deriveKey(envValue) {
  if (typeof envValue !== 'string' || !envValue) {
    throw new Error(
      'DATA_ENCRYPTION_KEY is required (64-char hex for a raw 32-byte key)'
    );
  }

  const hex = envValue.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      'DATA_ENCRYPTION_KEY must be a hex string'
    );
  }
  if (hex.length < 32) {
    // < 32 hex chars → < 16 raw bytes — not enough entropy.
    throw new Error(
      `DATA_ENCRYPTION_KEY is too short (got ${hex.length} hex chars / ${hex.length / 2} bytes; minimum is 32 hex chars / 16 bytes)`
    );
  }

  const raw = Buffer.from(hex, 'hex');

  if (raw.length === 32) {
    // Exact 32-byte key: use as-is.
    return raw;
  }

  // Longer than 32 bytes: run HKDF-Extract (SHA-256) to fold into 32 bytes.
  // hkdfSync(digest, ikm, salt, info, keylen)
  // We use an empty salt and empty info — this is purely a length-normalisation
  // step on already-secret material, not a password-based KDF.
  const derived = crypto.hkdfSync('sha256', raw, Buffer.alloc(0), Buffer.alloc(0), 32);
  return Buffer.from(derived);
}

/**
 * Read DATA_ENCRYPTION_KEY from the environment, derive, and memoize.
 *
 * @returns {Buffer} 32-byte AES key
 * @throws if the env var is missing or the value is too short.
 */
function getDataEncryptionKey() {
  if (_memoizedKey) return _memoizedKey;
  const val = process.env.DATA_ENCRYPTION_KEY;
  if (!val) {
    throw new Error(
      'DATA_ENCRYPTION_KEY environment variable is required but not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  _memoizedKey = deriveKey(val);
  return _memoizedKey;
}

/**
 * AES-256-GCM encrypt.
 *
 * @param {string} plaintext - the value to encrypt (UTF-8)
 * @param {Buffer} key - 32-byte AES key
 * @returns {string} base64-encoded iv || tag || ciphertext
 */
function encrypt(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('encrypt: key must be a 32-byte Buffer');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ctBuf = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Concatenate and base64-encode: iv || tag || ciphertext
  const out = Buffer.concat([iv, tag, ctBuf]);
  return out.toString('base64');
}

/**
 * AES-256-GCM decrypt.
 *
 * @param {string} ciphertext - base64 iv || tag || ciphertext (from encrypt())
 * @param {Buffer} key - 32-byte AES key
 * @returns {string} plaintext (UTF-8)
 * @throws on auth failure (tampered data) or wrong key
 */
function decrypt(ciphertext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('decrypt: key must be a 32-byte Buffer');
  }
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < HEADER_BYTES + 1) {
    throw new Error('decrypt: ciphertext is too short to be valid');
  }
  const iv  = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, HEADER_BYTES);
  const ct  = buf.subarray(HEADER_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    // Rethrow with a clearer message — the original message varies by Node
    // version and may leak internal details.
    throw new Error('decrypt: authentication failed — wrong key or tampered ciphertext');
  }
}

/**
 * Return a redacted version of an API key for display purposes.
 * Shows 'sk-...XXXX' where XXXX is the last 4 characters.
 * Never logs or returns the full key.
 *
 * @param {string} plaintextKey
 * @returns {string} e.g. 'sk-...AbC4'
 */
function redactKey(plaintextKey) {
  if (typeof plaintextKey !== 'string' || plaintextKey.length === 0) {
    return 'sk-...????';
  }
  const last4 = plaintextKey.slice(-4);
  return `sk-...${last4}`;
}

// Exported for testing — clears the memoized key so tests can swap env vars.
function _resetMemo() {
  _memoizedKey = null;
}

module.exports = { encrypt, decrypt, deriveKey, getDataEncryptionKey, redactKey, _resetMemo };

/**
 * Staging storage adapter.
 *
 * Wraps any base storage adapter (local-fs or s3) and prefixes every key
 * with `staging/<jobId>/`. This gives each rebuild job an isolated staging
 * namespace without requiring a separate bucket or directory.
 *
 * Methods:
 *   putStaging(jobId, relPath, stream)     → string (stored key)
 *   getStaging(jobId, relPath)             → Readable stream
 *   listStaging(jobId)                     → string[] (relative paths)
 *   clearStaging(jobId)                    → void
 *
 * All paths are relative to the job's staging prefix. A `relPath` of
 * `rebuild-manifest-staged.json` becomes the key
 * `staging/<jobId>/rebuild-manifest-staged.json`.
 *
 * The adapter never touches keys outside the `staging/` namespace; callers
 * that need the regular bucket still use the base storage directly.
 */

'use strict';

const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

class StagingStorage {
  /**
   * @param {object} opts
   * @param {object} opts.baseStorage - a LocalFsStorage or S3Storage instance
   * @param {number} [opts.retentionDays=7]
   */
  constructor({ baseStorage, retentionDays }) {
    if (!baseStorage) throw new Error('StagingStorage: baseStorage is required');
    this.base = baseStorage;
    this.retentionDays = Number.isFinite(retentionDays) ? retentionDays : 7;
  }

  driver() { return `staging(${this.base.driver()})`; }

  /**
   * Resolve the storage key for a staging file.
   * @param {string} jobId
   * @param {string} relPath - e.g. 'rebuild-manifest-staged.json'
   */
  _key(jobId, relPath) {
    if (!jobId || typeof jobId !== 'string') {
      throw new Error('StagingStorage: jobId must be a non-empty string');
    }
    if (!relPath || typeof relPath !== 'string') {
      throw new Error('StagingStorage: relPath must be a non-empty string');
    }
    // Prevent path traversal: normalize the relative path and ensure it
    // doesn't escape the staging prefix.
    const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
      throw new Error(`StagingStorage: relPath escapes staging prefix: ${relPath}`);
    }
    return `staging/${jobId}/${normalized}`;
  }

  /**
   * Store a staging artifact. `input` may be a Readable stream or a filesystem
   * path (string) — passed through to the base adapter.
   *
   * @param {string} jobId
   * @param {string} relPath
   * @param {string|import('stream').Readable} input
   * @returns {Promise<string>} the stored key
   */
  async putStaging(jobId, relPath, input) {
    const key = this._key(jobId, relPath);
    return this.base.put(input, { key });
  }

  /**
   * Retrieve a staging artifact as a Readable stream.
   *
   * @param {string} jobId
   * @param {string} relPath
   * @returns {Promise<import('stream').Readable>}
   */
  async getStaging(jobId, relPath) {
    const key = this._key(jobId, relPath);
    return this.base.get(key);
  }

  /**
   * Get a local filesystem path for a staging artifact. Necessary for
   * functions (like promote()) that need to pass a real path to other tools.
   * On S3 this downloads to a temp file; on local-fs it's the real path.
   *
   * @param {string} jobId
   * @param {string} relPath
   * @returns {Promise<string>} absolute filesystem path
   */
  async getStagingLocalPath(jobId, relPath) {
    const key = this._key(jobId, relPath);
    return this.base.getLocalPath(key);
  }

  /**
   * List all relative paths stored under `staging/<jobId>/`.
   *
   * For local-fs: walks the directory tree. For s3: uses list with prefix.
   * Returns an array of relative paths (without the `staging/<jobId>/` prefix).
   *
   * @param {string} jobId
   * @returns {Promise<string[]>}
   */
  async listStaging(jobId) {
    if (!jobId || typeof jobId !== 'string') return [];
    const prefix = `staging/${jobId}/`;

    const driver = this.base.driver ? this.base.driver() : '';

    if (driver === 'local-fs') {
      // Resolve the staging directory on local-fs.
      const baseDir = this.base.baseDir;
      const stagingDir = path.join(baseDir, 'staging', jobId);
      const results = [];
      async function walk(dir, relDir) {
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const ent of entries) {
          const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            await walk(path.join(dir, ent.name), rel);
          } else if (ent.isFile()) {
            results.push(rel);
          }
        }
      }
      await walk(stagingDir, '');
      return results;
    }

    // S3 / generic: use ListObjectsV2 via base adapter if available, otherwise
    // we can't enumerate. Return empty list and log a warning.
    if (driver === 's3' && this.base.client) {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const results = [];
      let token;
      do {
        const out = await this.base.client.send(new ListObjectsV2Command({
          Bucket: this.base.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        for (const o of (out.Contents || [])) {
          if (o.Key && o.Key.startsWith(prefix)) {
            results.push(o.Key.slice(prefix.length));
          }
        }
        token = out.IsTruncated ? out.NextContinuationToken : null;
      } while (token);
      return results;
    }

    // Fallback for adapters that don't support listing.
    return [];
  }

  /**
   * Remove all staging artifacts for a job. Idempotent — no error if nothing
   * exists.
   *
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async clearStaging(jobId) {
    if (!jobId || typeof jobId !== 'string') return;
    const driver = this.base.driver ? this.base.driver() : '';

    if (driver === 'local-fs') {
      const baseDir = this.base.baseDir;
      const stagingDir = path.join(baseDir, 'staging', jobId);
      try {
        await fsp.rm(stagingDir, { recursive: true, force: true });
      } catch (_) { /* idempotent */ }
      return;
    }

    // S3: list then delete.
    const keys = await this.listStaging(jobId);
    const prefix = `staging/${jobId}/`;
    await Promise.all(keys.map((rel) =>
      this.base.delete(prefix + rel).catch(() => {})
    ));
  }

  /**
   * Check whether a staging artifact exists.
   *
   * @param {string} jobId
   * @param {string} relPath
   * @returns {Promise<boolean>}
   */
  async existsStaging(jobId, relPath) {
    try {
      const key = this._key(jobId, relPath);
      return this.base.exists(key);
    } catch (_) {
      return false;
    }
  }

  /**
   * Write a JSON-serializable value to a staging artifact. Convenience
   * wrapper over putStaging for JSON files.
   *
   * @param {string} jobId
   * @param {string} relPath
   * @param {*} value
   * @returns {Promise<string>}
   */
  async putStagingJson(jobId, relPath, value) {
    const json = JSON.stringify(value, null, 2);
    const { Readable } = require('stream');
    const stream = Readable.from([json]);
    return this.putStaging(jobId, relPath, stream);
  }

  /**
   * Read and parse a JSON staging artifact. Returns null on miss or parse
   * error.
   *
   * @param {string} jobId
   * @param {string} relPath
   * @returns {Promise<*|null>}
   */
  async getStagingJson(jobId, relPath) {
    try {
      const stream = await this.getStaging(jobId, relPath);
      const chunks = [];
      await new Promise((resolve, reject) => {
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const raw = Buffer.concat(chunks).toString('utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Factory — wraps an existing storage adapter with the staging prefix logic.
 *
 * @param {object} baseStorage - LocalFsStorage or S3Storage
 * @param {object} [opts]
 * @param {number} [opts.retentionDays=7]
 * @returns {StagingStorage}
 */
function createStagingFromStorage(baseStorage, opts = {}) {
  return new StagingStorage({
    baseStorage,
    retentionDays: opts.retentionDays,
  });
}

module.exports = { StagingStorage, createStagingFromStorage };

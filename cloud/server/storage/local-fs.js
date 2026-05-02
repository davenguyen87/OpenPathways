/**
 * Local-filesystem storage adapter (default for Phase 9 local + hosted-on-
 * single-VPS deployments). Stores objects under cloud/.tmp/uploads/ — the
 * same disk layout Phase 5 relied on, so existing rows continue to work
 * without migration.
 *
 * Keys are filename-shaped strings (e.g., "pending-abc123.zip"). The
 * adapter joins them under its base dir; callers never construct full
 * paths themselves.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

class LocalFsStorage {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir - absolute directory to store under.
   */
  constructor({ baseDir }) {
    if (!baseDir) throw new Error('LocalFsStorage: baseDir is required');
    this.baseDir = path.resolve(baseDir);
  }

  driver() { return 'local-fs'; }

  async init() {
    await fsp.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Compute the absolute path for a key.
   *
   * Two key conventions are accepted, for compatibility with rows from
   * Phase 5 onward that stored absolute upload paths in `jobs.upload_path`:
   *
   *   1. Absolute path → used as-is. The job-manager and routes still hand
   *      us absolute paths on local-fs deployments. We don't enforce that
   *      they live under baseDir — they may not (legacy uploads, batches
   *      from earlier phases). This is local-fs only; S3's adapter has its
   *      own bare-key convention.
   *   2. Relative string → joined under baseDir. Path-traversal is rejected.
   *
   * Either way the return is an absolute filesystem path safe to fs-operate.
   */
  _resolveKey(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('LocalFsStorage: key must be a non-empty string');
    }
    if (path.isAbsolute(key)) return key;
    const full = path.resolve(this.baseDir, key);
    if (!full.startsWith(this.baseDir + path.sep) && full !== this.baseDir) {
      throw new Error(`LocalFsStorage: key escapes base dir: ${key}`);
    }
    return full;
  }

  /**
   * Place an object. `input` may be:
   *   - an absolute path (we move/copy into place if not already there);
   *   - a Readable stream (we write it to disk).
   *
   * Returns the key (caller-supplied, or generated if not provided).
   */
  async put(input, opts = {}) {
    const key = opts.key || `obj-${crypto.randomBytes(8).toString('hex')}.bin`;
    const target = this._resolveKey(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });

    if (typeof input === 'string') {
      // It's a path. If it's already at the target, no-op (the diskStorage
      // multer config writes directly into baseDir, so put() collapses to
      // a free book-keeping call).
      if (path.resolve(input) === target) return key;
      // Otherwise copy. We don't rename across mounts because Cowork
      // sessions sometimes have /tmp on a different fs.
      await fsp.copyFile(input, target);
      return key;
    }
    if (input && typeof input.pipe === 'function') {
      // Readable stream.
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(target);
        input.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        input.pipe(out);
      });
      return key;
    }
    throw new Error('LocalFsStorage.put: input must be a path or Readable stream');
  }

  /**
   * Returns a Readable stream of the object. Caller is responsible for
   * draining or destroying the stream.
   */
  async get(key) {
    const full = this._resolveKey(key);
    return fs.createReadStream(full);
  }

  /**
   * Returns an absolute path on local disk. Local-fs has nothing to do —
   * the key already points at a real file. The s3 adapter implements this
   * by downloading to a temp file.
   */
  async getLocalPath(key) {
    return this._resolveKey(key);
  }

  async exists(key) {
    try {
      await fsp.access(this._resolveKey(key), fs.constants.F_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  async delete(key) {
    try {
      await fsp.unlink(this._resolveKey(key));
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // already gone — idempotent
      throw err;
    }
  }

  /**
   * Sum of bytes + count of files under baseDir. Used by the eviction
   * worker (lands in 9C). Best-effort; not transactional.
   */
  async usage() {
    let totalBytes = 0;
    let fileCount = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          try {
            const stat = await fsp.stat(full);
            totalBytes += stat.size;
            fileCount += 1;
          } catch (_) { /* file vanished mid-walk; ignore */ }
        }
      }
    };
    await walk(this.baseDir);
    return { totalBytes, fileCount };
  }

  async close() { /* nothing to close */ }
}

module.exports = { LocalFsStorage };

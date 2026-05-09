/**
 * Storage factory.
 *
 * Returns an adapter based on STORAGE_DRIVER. Both adapters expose the
 * same surface — see ./local-fs.js for the authoritative shape.
 *
 * Local-fs default keeps the Phase 5 disk layout working unchanged. S3
 * (MinIO / R2 / AWS) is opt-in via STORAGE_DRIVER=s3 + S3_* env.
 */

const path = require('path');

function defaultBaseDir() {
  // cloud/server/storage/index.js → cloud/.tmp/uploads/
  return path.resolve(__dirname, '..', '..', '.tmp', 'uploads');
}

function createStorage(opts = {}) {
  const driver = (opts.driver || process.env.STORAGE_DRIVER || 'local-fs').toLowerCase();

  if (driver === 'local-fs') {
    const { LocalFsStorage } = require('./local-fs');
    const baseDir = opts.baseDir || process.env.LOCAL_FS_BASE_DIR || defaultBaseDir();
    return new LocalFsStorage({ baseDir });
  }

  if (driver === 's3') {
    const { S3Storage } = require('./s3');
    return new S3Storage({
      endpoint: opts.endpoint || process.env.S3_ENDPOINT,
      bucket: opts.bucket || process.env.S3_BUCKET,
      accessKey: opts.accessKey || process.env.S3_ACCESS_KEY,
      secretKey: opts.secretKey || process.env.S3_SECRET_KEY,
      region: opts.region || process.env.S3_REGION,
      forcePathStyle: opts.forcePathStyle !== false,
    });
  }

  throw new Error(`Unknown STORAGE_DRIVER: ${driver} (expected 'local-fs' or 's3')`);
}

/**
 * Convenience factory: create a StagingStorage that wraps an existing base
 * storage adapter. The staging adapter prefixes every key with
 * `staging/<jobId>/` and provides putStaging / getStaging / listStaging /
 * clearStaging helpers.
 *
 * @param {object} baseStorage - LocalFsStorage or S3Storage instance
 * @param {object} [opts]
 * @param {number} [opts.retentionDays=7]
 * @returns {StagingStorage}
 */
function createStagingFromStorage(baseStorage, opts = {}) {
  const { createStagingFromStorage: _create } = require('./staging');
  return _create(baseStorage, opts);
}

module.exports = { createStorage, createStagingFromStorage, defaultBaseDir };

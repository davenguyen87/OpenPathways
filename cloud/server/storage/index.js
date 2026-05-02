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

module.exports = { createStorage, defaultBaseDir };

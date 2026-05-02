/**
 * S3-compatible storage adapter.
 *
 * Speaks to any S3-compatible endpoint via @aws-sdk/client-s3 + a
 * configurable S3_ENDPOINT — MinIO (the Phase 10 default), Garage,
 * Cloudflare R2, AWS, etc. forcePathStyle is true so MinIO works without
 * virtual-host-style DNS.
 *
 * The adapter exposes the same interface as LocalFsStorage:
 *   init, put, get, getLocalPath, exists, delete, usage, close.
 *
 * getLocalPath downloads to a temp file (slower than local-fs's no-op).
 * Callers that already work in streams should prefer get() over
 * getLocalPath().
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  HeadObjectCommand, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

class S3Storage {
  constructor({ endpoint, bucket, accessKey, secretKey, region, forcePathStyle }) {
    if (!endpoint) throw new Error('S3Storage: endpoint is required');
    if (!bucket) throw new Error('S3Storage: bucket is required');
    if (!accessKey || !secretKey) throw new Error('S3Storage: credentials are required');
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region: region || 'us-east-1',
      forcePathStyle: forcePathStyle !== false, // MinIO requires path-style
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
  }

  driver() { return 's3'; }

  /**
   * Idempotent bucket bootstrap. We HeadBucket; on 404, CreateBucket.
   * MinIO + Garage + R2 + AWS all support both verbs identically. This
   * removes a manual MinIO-console step from the Coolify deploy path —
   * the user provisions MinIO and the app self-bootstraps its bucket.
   *
   * Errors that aren't "missing bucket" propagate (bad credentials, bad
   * endpoint, region mismatch) — the operator wants to know about those
   * at boot, not on the first upload.
   */
  async init() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      const name = err && err.name;
      const isMissing = status === 404 || name === 'NotFound' || name === 'NoSuchBucket';
      if (!isMissing) throw err;
    }
    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
  }

  async put(input, opts = {}) {
    const key = opts.key || `obj-${crypto.randomBytes(8).toString('hex')}.bin`;
    let body;
    if (typeof input === 'string') {
      body = fs.createReadStream(input);
    } else if (input && typeof input.pipe === 'function') {
      body = input;
    } else {
      throw new Error('S3Storage.put: input must be a path or Readable stream');
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
    }));
    return key;
  }

  async get(key) {
    const out = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket, Key: key,
    }));
    // out.Body is a Readable in Node.
    return out.Body;
  }

  /**
   * Materialize the object to a local temp file and return its path. The
   * caller is responsible for not assuming the file outlives the process —
   * we drop it under os.tmpdir(); on macOS/Linux this is reaped on reboot.
   */
  async getLocalPath(key) {
    const tmp = path.join(os.tmpdir(), `op-s3-${crypto.randomBytes(6).toString('hex')}-${path.basename(key)}`);
    const stream = await this.get(key);
    await pipeline(Readable.from(stream), fs.createWriteStream(tmp));
    return tmp;
  }

  async exists(key) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) return false;
      throw err;
    }
  }

  async delete(key) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // Idempotent — tolerate not-found.
      if (err && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) return;
      throw err;
    }
  }

  async usage() {
    let totalBytes = 0;
    let fileCount = 0;
    let token;
    do {
      const out = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        ContinuationToken: token,
      }));
      for (const o of out.Contents || []) {
        totalBytes += o.Size || 0;
        fileCount += 1;
      }
      token = out.IsTruncated ? out.NextContinuationToken : null;
    } while (token);
    return { totalBytes, fileCount };
  }

  async close() {
    try { this.client.destroy(); } catch (_) {}
  }
}

module.exports = { S3Storage };

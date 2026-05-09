/**
 * SQLite store adapter (default for local cloud-mode dev).
 *
 * Backed by better-sqlite3 (synchronous API; we wrap in async to keep parity
 * with the Postgres adapter so callers can `await` either one).
 *
 * Caller-facing row shape (returned from getJob, listSnapshots after the
 * adapter parses JSON columns and exposes timestamps as JS epoch numbers):
 *
 *   {
 *     id, status, options, originalName, uploadPath,
 *     createdAt, startedAt, finishedAt,
 *     error, result, progress
 *   }
 *
 * `progress` and `result` are parsed objects (or `null` when not set).
 *
 * SQL is held private to this file; callers go through the named methods.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { runMigrations } = require('./migrations/runner');

const DRIVER = 'sqlite';

class SqliteStore {
  /**
   * @param {object} opts
   * @param {string} opts.path - filesystem path to the .sqlite file. Parent
   *                             dir is created if missing.
   */
  constructor({ path: dbPath }) {
    if (!dbPath) throw new Error('SqliteStore: path is required');
    this.dbPath = dbPath;
    this.db = null;
  }

  driver() { return DRIVER; }

  async init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    // WAL mode keeps reads non-blocking against in-flight writes — matters
    // for SSE replays running while a job is still emitting progress.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    await this.migrate();
  }

  async migrate() {
    const adapter = {
      ensureMigrationsTable: () => {
        this.db
          .prepare(
            `CREATE TABLE IF NOT EXISTS _migrations (
               name TEXT PRIMARY KEY,
               applied_at INTEGER NOT NULL
             )`
          )
          .run();
      },
      appliedMigrations: () => {
        const rows = this.db.prepare(`SELECT name FROM _migrations`).all();
        return new Set(rows.map((r) => r.name));
      },
      applyMigration: (name, sql) => {
        const insert = this.db.prepare(
          `INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`
        );
        // exec() handles multi-statement SQL files; transaction wrapper makes
        // the SQL+record-insertion atomic so a half-applied file can't lie.
        const tx = this.db.transaction(() => {
          this.db.exec(sql);
          insert.run(name, Date.now());
        });
        tx();
      },
    };

    return runMigrations({ driver: DRIVER, adapter });
  }

  // --------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------

  async createJob({ id, status, options, originalName, uploadPath, createdAt, batchId, userId, uploadBytes, kind, parentJobId, mode }) {
    this.db
      .prepare(
        `INSERT INTO jobs (id, status, options, original_name, upload_path,
                           created_at, progress_json, batch_id, user_id, upload_bytes,
                           kind, parent_job_id, mode)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        status,
        JSON.stringify(options || {}),
        originalName || null,
        uploadPath,
        createdAt,
        batchId || null,
        userId || null,
        Number.isFinite(uploadBytes) ? uploadBytes : null,
        kind || 'audit',
        parentJobId || null,
        mode || null
      );
  }

  /**
   * Update mutable fields. Pass only what changed; undefined = no change.
   * `result` and `progress` are stored as JSON.
   */
  async updateJob(id, fields) {
    const sets = [];
    const vals = [];

    const setIf = (col, val, transform = (v) => v) => {
      if (val === undefined) return;
      sets.push(`${col} = ?`);
      vals.push(transform(val));
    };

    setIf('status', fields.status);
    setIf('started_at', fields.startedAt);
    setIf('finished_at', fields.finishedAt);
    setIf('error', fields.error);
    if (fields.result !== undefined) {
      sets.push('result_json = ?');
      vals.push(fields.result === null ? null : JSON.stringify(fields.result));
    }
    if (fields.progress !== undefined) {
      sets.push('progress_json = ?');
      vals.push(JSON.stringify(fields.progress || []));
    }
    if (sets.length === 0) return;

    vals.push(id);
    this.db
      .prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals);
  }

  /**
   * @param {string} id
   * @param {object} [filter] - { userId } to enforce ownership; pass undefined
   *                            to skip the check (local mode).
   * @returns null if not found OR if userId is set and doesn't match the row.
   */
  async getJob(id, filter) {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    if (!row) return null;
    if (filter && filter.userId !== undefined && row.user_id !== filter.userId) {
      return null;
    }
    return rowToJob(row);
  }

  /**
   * Most recent first, capped at `limit`. Returns the same shape as getJob.
   * `filter.userId`: if a string, only return that user's rows; if explicit
   * null, only return rows with NULL user_id (legacy / local-mode); if
   * undefined, no filter.
   */
  async listSnapshots(limit = 50, filter) {
    let rows;
    if (filter && filter.userId !== undefined) {
      if (filter.userId === null) {
        rows = this.db
          .prepare(`SELECT * FROM jobs WHERE user_id IS NULL ORDER BY created_at DESC LIMIT ?`)
          .all(limit);
      } else {
        rows = this.db
          .prepare(`SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(filter.userId, limit);
      }
    } else {
      rows = this.db
        .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    }
    return rows.map(rowToJob);
  }

  /**
   * All jobs in a given batch, ordered by createdAt asc.
   * filter.userId behaves the same way as in listSnapshots.
   */
  async listBatchSnapshots(batchId, filter) {
    if (!batchId) return [];
    let rows;
    if (filter && filter.userId !== undefined) {
      if (filter.userId === null) {
        rows = this.db
          .prepare(`SELECT * FROM jobs WHERE batch_id = ? AND user_id IS NULL ORDER BY created_at ASC`)
          .all(batchId);
      } else {
        rows = this.db
          .prepare(`SELECT * FROM jobs WHERE batch_id = ? AND user_id = ? ORDER BY created_at ASC`)
          .all(batchId, filter.userId);
      }
    } else {
      rows = this.db
        .prepare(`SELECT * FROM jobs WHERE batch_id = ? ORDER BY created_at ASC`)
        .all(batchId);
    }
    return rows.map(rowToJob);
  }

  /**
   * Cold-start recovery: any pending/running job is by definition orphaned —
   * the process that owned it is gone. Flip them to error with a stable
   * reason. Phase 9's pg-boss-backed worker will redo this with proper
   * requeue semantics.
   *
   * Returns the rows that were transitioned (so callers can log them).
   */
  async markInterrupted(reason = 'Server restarted before completion') {
    const now = Date.now();
    const select = this.db.prepare(
      `SELECT id, status FROM jobs WHERE status IN ('pending', 'running')`
    );
    const rows = select.all();
    if (rows.length === 0) return [];

    const update = this.db.prepare(
      `UPDATE jobs
         SET status = 'error',
             error = ?,
             finished_at = ?
       WHERE status IN ('pending', 'running')`
    );
    update.run(reason, now);
    return rows;
  }

  /**
   * Retention sweep. Deletes any terminal row whose finished_at is older
   * than `beforeMs`. Returns the upload paths + bytes of removed rows so
   * the caller can chase them in the storage layer.
   */
  async deleteExpired(beforeMs) {
    const select = this.db.prepare(
      `SELECT id, upload_path, upload_bytes FROM jobs
        WHERE finished_at IS NOT NULL AND finished_at < ?`
    );
    const rows = select.all(beforeMs);
    if (rows.length === 0) return [];

    const del = this.db.prepare(`DELETE FROM jobs WHERE id = ?`);
    const tx = this.db.transaction((toDelete) => {
      for (const r of toDelete) del.run(r.id);
    });
    tx(rows);
    return rows.map((r) => ({
      id: r.id,
      uploadPath: r.upload_path,
      uploadBytes: r.upload_bytes || 0,
    }));
  }

  /**
   * Phase 9C: delete the N oldest terminal rows (by finished_at ASC). Used
   * by the disk-eviction policy when usage exceeds the configured cap.
   * Returns the same shape as deleteExpired.
   */
  async deleteOldestTerminal(limit) {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const select = this.db.prepare(
      `SELECT id, upload_path, upload_bytes FROM jobs
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at ASC
        LIMIT ?`
    );
    const rows = select.all(limit);
    if (rows.length === 0) return [];
    const del = this.db.prepare(`DELETE FROM jobs WHERE id = ?`);
    const tx = this.db.transaction((toDelete) => {
      for (const r of toDelete) del.run(r.id);
    });
    tx(rows);
    return rows.map((r) => ({
      id: r.id,
      uploadPath: r.upload_path,
      uploadBytes: r.upload_bytes || 0,
    }));
  }

  /**
   * Phase 9C: aggregate counts/sums used by the per-user quota check.
   *   concurrent      — pending or running jobs the user owns.
   *   uploadsLast24h  — jobs created in the trailing 24h.
   *   storedBytes     — SUM(upload_bytes) of rows that haven't been
   *                     evicted yet (counts both active and recent
   *                     terminal — eviction prunes the rest).
   */
  async getUserJobsAggregate(userId) {
    if (!userId) {
      return { concurrent: 0, uploadsLast24h: 0, storedBytes: 0 };
    }
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const concurrent = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
          WHERE user_id = ? AND status IN ('pending', 'running')`
      )
      .get(userId).n || 0;
    const uploadsLast24h = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
          WHERE user_id = ? AND created_at > ?`
      )
      .get(userId, since).n || 0;
    const storedBytes = this.db
      .prepare(
        `SELECT COALESCE(SUM(upload_bytes), 0) AS s FROM jobs
          WHERE user_id = ?`
      )
      .get(userId).s || 0;
    return {
      concurrent: Number(concurrent),
      uploadsLast24h: Number(uploadsLast24h),
      storedBytes: Number(storedBytes),
    };
  }

  /**
   * Phase 12: count a user's in-flight rebuild jobs (pending or running).
   * Used by the rebuild quota check in lib/quotas.js.
   */
  async getUserRebuildAggregate(userId) {
    if (!userId) return { concurrentRebuilds: 0 };
    const concurrentRebuilds = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
          WHERE user_id = ? AND kind = 'rebuild' AND status IN ('pending', 'running')`
      )
      .get(userId).n || 0;
    return { concurrentRebuilds: Number(concurrentRebuilds) };
  }

  // --------------------------------------------------------------------
  // Auth (Phase 9B)
  // --------------------------------------------------------------------

  async createUser({ id, email, createdAt }) {
    this.db
      .prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .run(id, email, createdAt);
  }

  async getUserByEmail(email) {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    return row ? userRowToUser(row) : null;
  }

  async getUserById(id) {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    return row ? userRowToUser(row) : null;
  }

  async createSession({ id, userId, createdAt, expiresAt }) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
      )
      .run(id, userId, createdAt, expiresAt);
  }

  /**
   * Returns null if the session doesn't exist, is revoked, or is expired.
   * Otherwise returns { id, userId, createdAt, expiresAt }.
   */
  async getSession(id) {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (Number(row.expires_at) < Date.now()) return null;
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async revokeSession(id) {
    this.db
      .prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(Date.now(), id);
  }

  async createMagicLinkToken({ id, email, createdAt, expiresAt }) {
    this.db
      .prepare(
        `INSERT INTO magic_link_tokens (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)`
      )
      .run(id, email, createdAt, expiresAt);
  }

  /**
   * Atomic consume-once. Returns { email } if the token was valid and just
   * got consumed; null if missing, expired, or already consumed.
   */
  async consumeMagicLinkToken(id) {
    // better-sqlite3 transactions are synchronous; we wrap to keep the API
    // consistent with the postgres adapter.
    const consume = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM magic_link_tokens WHERE id = ?`).get(id);
      if (!row) return null;
      if (row.consumed_at) return null;
      if (Number(row.expires_at) < Date.now()) return null;
      this.db
        .prepare(`UPDATE magic_link_tokens SET consumed_at = ? WHERE id = ?`)
        .run(Date.now(), id);
      return { email: row.email };
    });
    return consume();
  }

  async recordLoginAttempt({ email, ip, success, attemptedAt }) {
    this.db
      .prepare(
        `INSERT INTO login_attempts (email, ip, attempted_at, success) VALUES (?, ?, ?, ?)`
      )
      .run(email || null, ip || null, attemptedAt, success ? 1 : 0);
  }

  async logAuthEvent({ userId, eventType, ip, userAgent, occurredAt, details }) {
    this.db
      .prepare(
        `INSERT INTO auth_audit_log (user_id, event_type, ip, user_agent, occurred_at, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId || null,
        eventType,
        ip || null,
        userAgent || null,
        occurredAt,
        details ? JSON.stringify(details) : null
      );
  }

  // --------------------------------------------------------------------
  // Batch operations (Phase 8)
  // --------------------------------------------------------------------

  async createBatch({ id, userId, engagementId, label, status, createdAt }) {
    this.db
      .prepare(
        `INSERT INTO batches (id, user_id, engagement_id, label, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, userId || null, engagementId, label || null, status, createdAt);
  }

  /**
   * Fetch a batch by ID with all its jobs joined in.
   * @param {string} id - batch ID
   * @param {object} [filter] - { userId } to enforce ownership; undefined = no filter.
   * @returns batch row with joined jobs array, or null if not found / doesn't match filter.
   */
  async getBatch(id, filter) {
    const row = this.db.prepare(`SELECT * FROM batches WHERE id = ?`).get(id);
    if (!row) return null;
    if (filter && filter.userId !== undefined && row.user_id !== filter.userId) {
      return null;
    }

    // Fetch all jobs in this batch
    const jobRows = this.db
      .prepare(`SELECT * FROM jobs WHERE batch_id = ? ORDER BY created_at ASC`)
      .all(id);

    return {
      id: row.id,
      userId: row.user_id || null,
      engagementId: row.engagement_id,
      label: row.label || null,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at || null,
      error: row.error || null,
      jobs: jobRows.map(rowToJob),
    };
  }

  /**
   * Create a batch_files row (the idempotency join).
   * @throws on UNIQUE violation if the (batch_id, sha256, filename) triple already exists.
   */
  async createBatchFile({ id, batchId, jobId, filename, sha256, createdAt }) {
    try {
      this.db
        .prepare(
          `INSERT INTO batch_files (id, batch_id, job_id, filename, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, batchId, jobId, filename, sha256, createdAt);

      return {
        id,
        batchId,
        jobId,
        filename,
        sha256,
        createdAt,
      };
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        const error = new Error(`UNIQUE violation for batch_files (batch_id, sha256, filename)`);
        error.code = 'UNIQUE_VIOLATION';
        throw error;
      }
      throw err;
    }
  }

  /**
   * Look up an existing batch_files row by the idempotency key.
   * @returns row { id, batchId, jobId, filename, sha256, createdAt } or null.
   */
  async findBatchFileByIdempotencyKey({ batchId, sha256, filename }) {
    const row = this.db
      .prepare(
        `SELECT * FROM batch_files
         WHERE batch_id = ? AND sha256 = ? AND filename = ?`
      )
      .get(batchId, sha256, filename);

    if (!row) return null;

    return {
      id: row.id,
      batchId: row.batch_id,
      jobId: row.job_id,
      filename: row.filename,
      sha256: row.sha256,
      createdAt: row.created_at,
    };
  }

  // --------------------------------------------------------------------
  // Workspace LLM config (Phase 12.5)
  // --------------------------------------------------------------------

  /**
   * Retrieve the workspace LLM config for a user.
   * @param {string} userId
   * @returns {{ userId, provider, model, encryptedApiKey, keyLast4, createdAt, updatedAt } | null}
   */
  async getWorkspaceLlmConfig(userId) {
    const row = this.db
      .prepare(`SELECT * FROM workspace_llm_config WHERE user_id = ?`)
      .get(userId);
    return row ? llmConfigRowToConfig(row) : null;
  }

  /**
   * Upsert the workspace LLM config for a user.
   * Uses a transactional check-then-insert-or-update to preserve created_at
   * on subsequent sets (INSERT OR REPLACE would reset it via DELETE+INSERT).
   *
   * @param {string} userId
   * @param {{ provider?: string, model?: string, encryptedApiKey: string, keyLast4: string }} config
   */
  async setWorkspaceLlmConfig(userId, { provider, model, encryptedApiKey, keyLast4 }) {
    const now = Date.now();
    const upsert = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT user_id FROM workspace_llm_config WHERE user_id = ?`)
        .get(userId);
      if (existing) {
        this.db
          .prepare(
            `UPDATE workspace_llm_config
               SET provider = ?,
                   model = ?,
                   encrypted_api_key = ?,
                   key_last4 = ?,
                   updated_at = ?
             WHERE user_id = ?`
          )
          .run(provider || 'anthropic', model || null, encryptedApiKey, keyLast4, now, userId);
      } else {
        this.db
          .prepare(
            `INSERT INTO workspace_llm_config
               (user_id, provider, model, encrypted_api_key, key_last4, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(userId, provider || 'anthropic', model || null, encryptedApiKey, keyLast4, now, now);
      }
    });
    upsert();
  }

  /**
   * Delete the workspace LLM config for a user.
   * @param {string} userId
   * @returns {boolean} true if a row was deleted, false if no row existed.
   */
  async deleteWorkspaceLlmConfig(userId) {
    const result = this.db
      .prepare(`DELETE FROM workspace_llm_config WHERE user_id = ?`)
      .run(userId);
    return result.changes > 0;
  }

  // --------------------------------------------------------------------
  // Workspace LLM usage telemetry (Phase 12.5)
  // --------------------------------------------------------------------

  /**
   * Record one LLM call's usage for a user.
   *
   * @param {{ userId, feature, model, inputTokens, outputTokens, estimatedCostUsd }} opts
   */
  async recordLlmUsage({ userId, feature, model, inputTokens, outputTokens, estimatedCostUsd }) {
    const id = require('crypto').randomUUID();
    const occurredAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspace_llm_usage
           (id, user_id, feature, model, input_tokens, output_tokens, estimated_cost_usd, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, userId, feature, model, inputTokens || 0, outputTokens || 0, estimatedCostUsd || 0, occurredAt);
  }

  /**
   * Aggregate LLM usage for a user over the last N milliseconds.
   *
   * @param {string} userId
   * @param {number} sinceMs - epoch-ms lower bound (e.g. Date.now() - 30*86400*1000)
   * @returns {{ totalInputTokens, totalOutputTokens, totalCostUsd, byFeature }}
   */
  async getLlmUsageRollup(userId, sinceMs) {
    const rows = this.db
      .prepare(
        `SELECT feature,
                SUM(input_tokens)       AS input_tokens,
                SUM(output_tokens)      AS output_tokens,
                SUM(estimated_cost_usd) AS cost_usd
           FROM workspace_llm_usage
          WHERE user_id = ? AND occurred_at >= ?
          GROUP BY feature`
      )
      .all(userId, sinceMs);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    const byFeature = {};

    for (const row of rows) {
      const inp = Number(row.input_tokens) || 0;
      const out = Number(row.output_tokens) || 0;
      const cost = Number(row.cost_usd) || 0;
      totalInputTokens += inp;
      totalOutputTokens += out;
      totalCostUsd += cost;
      byFeature[row.feature] = { tokens: inp + out, cost };
    }

    return { totalInputTokens, totalOutputTokens, totalCostUsd, byFeature };
  }

  // --------------------------------------------------------------------
  // Rate-limit hits (Phase 9C)
  // --------------------------------------------------------------------

  async rateLimitIncr({ bucket, expiresAt }) {
    // Upsert + atomic increment.
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT count FROM rate_limit_hits WHERE bucket = ?`)
        .get(bucket);
      if (existing) {
        this.db
          .prepare(`UPDATE rate_limit_hits SET count = count + 1 WHERE bucket = ?`)
          .run(bucket);
        return existing.count + 1;
      }
      this.db
        .prepare(`INSERT INTO rate_limit_hits (bucket, count, expires_at) VALUES (?, 1, ?)`)
        .run(bucket, expiresAt);
      return 1;
    });
    return tx();
  }

  async rateLimitDecr({ bucket }) {
    this.db
      .prepare(`UPDATE rate_limit_hits SET count = MAX(0, count - 1) WHERE bucket = ?`)
      .run(bucket);
  }

  async rateLimitReset({ bucket }) {
    if (bucket === null) {
      this.db.prepare(`DELETE FROM rate_limit_hits`).run();
    } else {
      this.db.prepare(`DELETE FROM rate_limit_hits WHERE bucket = ?`).run(bucket);
    }
  }

  /**
   * Lightweight liveness probe used by /api/health. Throws on failure;
   * caller catches and reports 503.
   */
  async ping() {
    this.db.prepare(`SELECT 1`).get();
  }

  async close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
      this.db = null;
    }
  }
}

function userRowToUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

// ----------------------------------------------------------------------
// Row → caller shape
// ----------------------------------------------------------------------

function rowToJob(row) {
  return {
    id: row.id,
    status: row.status,
    options: parseJson(row.options) || {},
    originalName: row.original_name,
    uploadPath: row.upload_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    result: parseJson(row.result_json),
    progress: parseJson(row.progress_json) || [],
    // batch_id may be undefined on rows from before the 0002 migration
    // applied; older callers tolerate undefined.
    batchId: row.batch_id || null,
    // Phase 9B: nullable on legacy rows pre-0003.
    userId: row.user_id || null,
    // Phase 9C: nullable on legacy rows pre-0004.
    uploadBytes: row.upload_bytes || null,
    // Phase 12: rebuild job kind + linkage. Default 'audit' for rows
    // created before 0007 migration (kind column won't be present).
    kind: row.kind || 'audit',
    parentJobId: row.parent_job_id || null,
    mode: row.mode || null,
  };
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value; // already an object (defensive)
  try { return JSON.parse(value); } catch (_) { return null; }
}

function llmConfigRowToConfig(row) {
  return {
    userId: row.user_id,
    provider: row.provider,
    model: row.model || null,
    encryptedApiKey: row.encrypted_api_key,
    keyLast4: row.key_last4,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { SqliteStore };

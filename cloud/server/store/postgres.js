/**
 * Postgres store adapter.
 *
 * Same surface as SqliteStore; same caller-facing row shape. Phase 5 builds
 * this so Phase 9's hosted-mode wire-up has nothing to catch up on, but the
 * default driver in Phase 5 is SQLite — this code path is exercised
 * end-to-end starting in Phase 9 alongside docker-compose Postgres.
 *
 * Differences from the SQLite adapter:
 *   - Placeholders are $1/$2/... not ?
 *   - JSONB columns: pg's driver auto-deserializes JSONB on read, and we
 *     pass JS objects directly on write (pg handles JSON.stringify for jsonb
 *     parameters).
 *   - Timestamps: TIMESTAMPTZ in DB. Caller-facing: epoch ms (matches sqlite).
 *     Adapter converts at the boundary in both directions.
 */

const { Pool } = require('pg');

const { runMigrations } = require('./migrations/runner');

const DRIVER = 'postgres';

class PostgresStore {
  /**
   * @param {object} opts
   * @param {string} opts.connectionString - DATABASE_URL
   */
  constructor({ connectionString }) {
    if (!connectionString) {
      throw new Error('PostgresStore: connectionString is required');
    }
    this.pool = new Pool({ connectionString });
  }

  driver() { return DRIVER; }

  async init() {
    await this.migrate();
  }

  async migrate() {
    const adapter = {
      ensureMigrationsTable: async () => {
        await this.pool.query(
          `CREATE TABLE IF NOT EXISTS _migrations (
             name TEXT PRIMARY KEY,
             applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`
        );
      },
      appliedMigrations: async () => {
        const { rows } = await this.pool.query(
          `SELECT name FROM _migrations`
        );
        return new Set(rows.map((r) => r.name));
      },
      applyMigration: async (name, sql) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            `INSERT INTO _migrations (name) VALUES ($1)`,
            [name]
          );
          await client.query('COMMIT');
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      },
    };

    return runMigrations({ driver: DRIVER, adapter });
  }

  // --------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------

  async createJob({ id, status, options, originalName, uploadPath, createdAt, batchId, userId, uploadBytes }) {
    await this.pool.query(
      `INSERT INTO jobs (id, status, options, original_name, upload_path,
                         created_at, progress_json, batch_id, user_id, upload_bytes)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, '[]'::jsonb, $7, $8, $9)`,
      [
        id,
        status,
        JSON.stringify(options || {}),
        originalName || null,
        uploadPath,
        new Date(createdAt),
        batchId || null,
        userId || null,
        Number.isFinite(uploadBytes) ? uploadBytes : null,
      ]
    );
  }

  async updateJob(id, fields) {
    const sets = [];
    const vals = [];
    let i = 1;

    const setIf = (col, val, cast = '') => {
      if (val === undefined) return;
      sets.push(`${col} = $${i}${cast}`);
      vals.push(val);
      i++;
    };

    setIf('status', fields.status);
    if (fields.startedAt !== undefined) {
      sets.push(`started_at = $${i}`);
      vals.push(fields.startedAt === null ? null : new Date(fields.startedAt));
      i++;
    }
    if (fields.finishedAt !== undefined) {
      sets.push(`finished_at = $${i}`);
      vals.push(fields.finishedAt === null ? null : new Date(fields.finishedAt));
      i++;
    }
    setIf('error', fields.error);
    if (fields.result !== undefined) {
      sets.push(`result_json = $${i}::jsonb`);
      vals.push(fields.result === null ? null : JSON.stringify(fields.result));
      i++;
    }
    if (fields.progress !== undefined) {
      sets.push(`progress_json = $${i}::jsonb`);
      vals.push(JSON.stringify(fields.progress || []));
      i++;
    }
    if (sets.length === 0) return;

    vals.push(id);
    await this.pool.query(
      `UPDATE jobs SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );
  }

  async getJob(id, filter) {
    const { rows } = await this.pool.query(
      `SELECT * FROM jobs WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    if (filter && filter.userId !== undefined && rows[0].user_id !== filter.userId) {
      return null;
    }
    return rowToJob(rows[0]);
  }

  async listSnapshots(limit = 50, filter) {
    let q, args;
    if (filter && filter.userId !== undefined) {
      if (filter.userId === null) {
        q = `SELECT * FROM jobs WHERE user_id IS NULL ORDER BY created_at DESC LIMIT $1`;
        args = [limit];
      } else {
        q = `SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`;
        args = [filter.userId, limit];
      }
    } else {
      q = `SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1`;
      args = [limit];
    }
    const { rows } = await this.pool.query(q, args);
    return rows.map(rowToJob);
  }

  async listBatchSnapshots(batchId, filter) {
    if (!batchId) return [];
    let q, args;
    if (filter && filter.userId !== undefined) {
      if (filter.userId === null) {
        q = `SELECT * FROM jobs WHERE batch_id = $1 AND user_id IS NULL ORDER BY created_at ASC`;
        args = [batchId];
      } else {
        q = `SELECT * FROM jobs WHERE batch_id = $1 AND user_id = $2 ORDER BY created_at ASC`;
        args = [batchId, filter.userId];
      }
    } else {
      q = `SELECT * FROM jobs WHERE batch_id = $1 ORDER BY created_at ASC`;
      args = [batchId];
    }
    const { rows } = await this.pool.query(q, args);
    return rows.map(rowToJob);
  }

  async markInterrupted(reason = 'Server restarted before completion') {
    const { rows } = await this.pool.query(
      `SELECT id, status FROM jobs WHERE status IN ('pending', 'running')`
    );
    if (rows.length === 0) return [];

    await this.pool.query(
      `UPDATE jobs
          SET status = 'error',
              error = $1,
              finished_at = NOW()
        WHERE status IN ('pending', 'running')`,
      [reason]
    );
    return rows;
  }

  async deleteExpired(beforeMs) {
    const { rows } = await this.pool.query(
      `SELECT id, upload_path, upload_bytes FROM jobs
        WHERE finished_at IS NOT NULL AND finished_at < $1`,
      [new Date(beforeMs)]
    );
    if (rows.length === 0) return [];

    await this.pool.query(
      `DELETE FROM jobs
        WHERE finished_at IS NOT NULL AND finished_at < $1`,
      [new Date(beforeMs)]
    );
    return rows.map((r) => ({
      id: r.id,
      uploadPath: r.upload_path,
      uploadBytes: r.upload_bytes || 0,
    }));
  }

  async deleteOldestTerminal(limit) {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const { rows } = await this.pool.query(
      `SELECT id, upload_path, upload_bytes FROM jobs
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at ASC
        LIMIT $1`,
      [limit]
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await this.pool.query(`DELETE FROM jobs WHERE id = ANY($1::text[])`, [ids]);
    return rows.map((r) => ({
      id: r.id,
      uploadPath: r.upload_path,
      uploadBytes: r.upload_bytes || 0,
    }));
  }

  async getUserJobsAggregate(userId) {
    if (!userId) return { concurrent: 0, uploadsLast24h: 0, storedBytes: 0 };
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r1 = await this.pool.query(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE user_id = $1 AND status IN ('pending', 'running')`,
      [userId]
    );
    const r2 = await this.pool.query(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE user_id = $1 AND created_at > $2`,
      [userId, since]
    );
    const r3 = await this.pool.query(
      `SELECT COALESCE(SUM(upload_bytes), 0) AS s FROM jobs
        WHERE user_id = $1`,
      [userId]
    );
    return {
      concurrent: Number(r1.rows[0].n || 0),
      uploadsLast24h: Number(r2.rows[0].n || 0),
      storedBytes: Number(r3.rows[0].s || 0),
    };
  }

  // --------------------------------------------------------------------
  // Auth (Phase 9B)
  // --------------------------------------------------------------------

  async createUser({ id, email, createdAt }) {
    await this.pool.query(
      `INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3)`,
      [id, email, new Date(createdAt)]
    );
  }

  async getUserByEmail(email) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    return rows[0] ? userRowToUser(rows[0]) : null;
  }

  async getUserById(id) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? userRowToUser(rows[0]) : null;
  }

  async createSession({ id, userId, createdAt, expiresAt }) {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, new Date(createdAt), new Date(expiresAt)]
    );
  }

  async getSession(id) {
    const { rows } = await this.pool.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    if (row.revoked_at) return null;
    if (tsToMs(row.expires_at) < Date.now()) return null;
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: tsToMs(row.created_at),
      expiresAt: tsToMs(row.expires_at),
    };
  }

  async revokeSession(id) {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
  }

  async createMagicLinkToken({ id, email, createdAt, expiresAt }) {
    await this.pool.query(
      `INSERT INTO magic_link_tokens (id, email, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, email, new Date(createdAt), new Date(expiresAt)]
    );
  }

  async consumeMagicLinkToken(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT email, expires_at, consumed_at FROM magic_link_tokens WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (rows.length === 0) { await client.query('COMMIT'); return null; }
      const row = rows[0];
      if (row.consumed_at) { await client.query('COMMIT'); return null; }
      if (tsToMs(row.expires_at) < Date.now()) { await client.query('COMMIT'); return null; }
      await client.query(
        `UPDATE magic_link_tokens SET consumed_at = NOW() WHERE id = $1`,
        [id]
      );
      await client.query('COMMIT');
      return { email: row.email };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async recordLoginAttempt({ email, ip, success, attemptedAt }) {
    await this.pool.query(
      `INSERT INTO login_attempts (email, ip, attempted_at, success) VALUES ($1, $2, $3, $4)`,
      [email || null, ip || null, new Date(attemptedAt), !!success]
    );
  }

  async logAuthEvent({ userId, eventType, ip, userAgent, occurredAt, details }) {
    await this.pool.query(
      `INSERT INTO auth_audit_log (user_id, event_type, ip, user_agent, occurred_at, details_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        userId || null,
        eventType,
        ip || null,
        userAgent || null,
        new Date(occurredAt),
        details ? JSON.stringify(details) : null,
      ]
    );
  }

  // --------------------------------------------------------------------
  // Rate-limit hits (Phase 9C)
  // --------------------------------------------------------------------

  async rateLimitIncr({ bucket, expiresAt }) {
    // Postgres atomic upsert; returns the post-increment count.
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limit_hits (bucket, count, expires_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (bucket) DO UPDATE SET count = rate_limit_hits.count + 1
       RETURNING count`,
      [bucket, new Date(expiresAt)]
    );
    return rows[0].count;
  }

  async rateLimitDecr({ bucket }) {
    await this.pool.query(
      `UPDATE rate_limit_hits SET count = GREATEST(0, count - 1) WHERE bucket = $1`,
      [bucket]
    );
  }

  async rateLimitReset({ bucket }) {
    if (bucket === null) {
      await this.pool.query(`DELETE FROM rate_limit_hits`);
    } else {
      await this.pool.query(`DELETE FROM rate_limit_hits WHERE bucket = $1`, [bucket]);
    }
  }

  async ping() {
    await this.pool.query(`SELECT 1`);
  }

  async close() {
    if (this.pool) {
      try { await this.pool.end(); } catch (_) {}
      this.pool = null;
    }
  }
}

function userRowToUser(row) {
  return { id: row.id, email: row.email, createdAt: tsToMs(row.created_at) };
}

// ----------------------------------------------------------------------
// Row → caller shape
// ----------------------------------------------------------------------

function rowToJob(row) {
  return {
    id: row.id,
    status: row.status,
    // pg auto-parses jsonb into objects; defensive parse if it's a string.
    options: normalizeJson(row.options) || {},
    originalName: row.original_name,
    uploadPath: row.upload_path,
    createdAt: tsToMs(row.created_at),
    startedAt: tsToMs(row.started_at),
    finishedAt: tsToMs(row.finished_at),
    error: row.error,
    result: normalizeJson(row.result_json),
    progress: normalizeJson(row.progress_json) || [],
    batchId: row.batch_id || null,
    userId: row.user_id || null,
    uploadBytes: row.upload_bytes != null ? Number(row.upload_bytes) : null,
  };
}

function normalizeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return null; }
  }
  return value;
}

function tsToMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { PostgresStore };

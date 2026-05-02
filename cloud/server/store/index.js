/**
 * Store factory.
 *
 * Constructs a store adapter based on env. Phase 5 default is SQLite for
 * local dev; Postgres is implemented but hosted-mode wire-up lands in
 * Phase 9.
 *
 * Env contract:
 *   DB_DRIVER=sqlite        (default)  → SQLite at SQLITE_PATH
 *   DB_DRIVER=postgres                 → Postgres at DATABASE_URL
 *   SQLITE_PATH=...         (optional) default: <repo>/cloud/.tmp/op.sqlite
 *   DATABASE_URL=...        (required when DB_DRIVER=postgres)
 *
 * Both adapters expose the same interface — see ./sqlite.js for the
 * authoritative shape; ./postgres.js mirrors it.
 */

const path = require('path');

function resolveSqlitePath(envPath) {
  if (envPath && envPath.trim()) return path.resolve(envPath.trim());
  // cloud/server/store/index.js → cloud/.tmp/op.sqlite
  return path.resolve(__dirname, '..', '..', '.tmp', 'op.sqlite');
}

/**
 * @param {object} [opts] - explicit overrides; otherwise read from process.env.
 * @param {string} [opts.driver]
 * @param {string} [opts.sqlitePath]
 * @param {string} [opts.connectionString]
 */
function createStore(opts = {}) {
  const driver = (opts.driver || process.env.DB_DRIVER || 'sqlite').toLowerCase();

  if (driver === 'sqlite') {
    const { SqliteStore } = require('./sqlite');
    const sqlitePath = resolveSqlitePath(opts.sqlitePath || process.env.SQLITE_PATH);
    return new SqliteStore({ path: sqlitePath });
  }

  if (driver === 'postgres' || driver === 'pg') {
    const { PostgresStore } = require('./postgres');
    const connectionString = opts.connectionString || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
    }
    return new PostgresStore({ connectionString });
  }

  throw new Error(`Unknown DB_DRIVER: ${driver} (expected sqlite or postgres)`);
}

module.exports = { createStore, resolveSqlitePath };

/**
 * Tiny migration runner.
 *
 * Walks `cloud/server/store/migrations/<driver>/` in sorted filename order,
 * applies any file whose name is not yet recorded in the `_migrations` table,
 * and records each successful application. Idempotent: running twice is a
 * no-op.
 *
 * Each adapter (sqlite.js, postgres.js) supplies the two callbacks this
 * runner needs:
 *   - `ensureMigrationsTable()`  — creates `_migrations(name TEXT PRIMARY KEY,
 *                                  applied_at <timestamp>)` if missing.
 *   - `appliedMigrations()`      — returns Set<string> of applied filenames.
 *   - `applyMigration(name, sql)` — runs the SQL and inserts the row in a
 *                                   single transaction. Throws on failure.
 *
 * That keeps the runner dialect-agnostic; the per-driver SQL lives in the
 * adapters.
 */

const path = require('path');
const fs = require('fs');

const MIGRATIONS_ROOT = path.resolve(__dirname);

function listMigrationFiles(driver) {
  const dir = path.join(MIGRATIONS_ROOT, driver);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, fullPath: path.join(dir, name) }));
}

async function runMigrations({ driver, adapter, log = () => {} }) {
  const files = listMigrationFiles(driver);
  if (files.length === 0) {
    log(`(no migrations found for driver=${driver})`);
    return { applied: [] };
  }

  await adapter.ensureMigrationsTable();
  const already = await adapter.appliedMigrations();

  const applied = [];
  for (const { name, fullPath } of files) {
    if (already.has(name)) continue;
    const sql = fs.readFileSync(fullPath, 'utf8');
    log(`applying migration ${name}`);
    await adapter.applyMigration(name, sql);
    applied.push(name);
  }
  return { applied };
}

module.exports = { runMigrations, listMigrationFiles };

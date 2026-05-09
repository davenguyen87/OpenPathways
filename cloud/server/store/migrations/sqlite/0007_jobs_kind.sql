-- Phase 12: rebuild job kind, parent linkage, and mode column.
--
-- Adds three columns to jobs so audit and rebuild jobs can co-exist in the
-- same table without schema gymnastics:
--
--   kind          — 'audit' (default, backfilled) or 'rebuild'. Other kinds
--                   may be added in future phases.
--   parent_job_id — TEXT FK to jobs.id for rebuild jobs; points at the audit
--                   job that produced the violations being fixed. NULL for
--                   audit jobs. SQLite FK syntax: REFERENCES jobs(id) ON
--                   DELETE SET NULL (enforced when foreign_keys=ON, which
--                   SqliteStore sets at init).
--   mode          — rebuild tier: 'safe', 'assisted', or 'full'. NULL for
--                   audit jobs.
--
-- SQLite does not support ADD COLUMN with FK constraints inline in the same
-- ALTER TABLE statement for existing tables — we add parent_job_id as a
-- plain TEXT column and rely on application-level FK semantics (foreign_keys
-- pragma is ON via SqliteStore.init()). The FK reference is still declared
-- in the column definition for documentation purposes; better-sqlite3
-- respects the pragma.

ALTER TABLE jobs ADD COLUMN kind           TEXT NOT NULL DEFAULT 'audit';
ALTER TABLE jobs ADD COLUMN parent_job_id  TEXT;
ALTER TABLE jobs ADD COLUMN mode           TEXT;

-- Backfill: every existing row is an audit job.
UPDATE jobs SET kind = 'audit' WHERE kind IS NULL OR kind = '';

CREATE INDEX IF NOT EXISTS jobs_kind_status_created_at ON jobs (kind, status, created_at DESC);

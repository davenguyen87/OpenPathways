-- Phase 12: rebuild job kind, parent linkage, and mode column.
--
-- Adds three columns to jobs so audit and rebuild jobs can co-exist in the
-- same table without schema gymnastics:
--
--   kind          — 'audit' (default, backfilled) or 'rebuild'. Other kinds
--                   may be added in future phases.
--   parent_job_id — FK to jobs.id for rebuild jobs; points at the audit job
--                   that produced the violations being fixed. NULL for audit
--                   jobs. ON DELETE SET NULL so deleting an audit doesn't
--                   cascade-delete its children.
--   mode          — rebuild tier: 'safe', 'assisted', or 'full'. NULL for
--                   audit jobs.
--
-- A composite index on (kind, status, created_at DESC) supports the worker's
-- queue-drain queries and the per-user rebuild quota check without a table
-- scan.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind           TEXT NOT NULL DEFAULT 'audit';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mode           TEXT;

-- Backfill: every existing row is an audit job.
UPDATE jobs SET kind = 'audit' WHERE kind IS NULL OR kind = '';

CREATE INDEX IF NOT EXISTS jobs_kind_status_created_at ON jobs (kind, status, created_at DESC);

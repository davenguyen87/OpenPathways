-- Phase 8: optional batch_id on jobs.
--
-- A "batch" is just a set of jobs that share a UUID — no separate batches
-- table. Queries: WHERE batch_id = ?  (filtered partial index keeps the
-- index small since most rows are non-batch).

ALTER TABLE jobs ADD COLUMN batch_id TEXT;

CREATE INDEX IF NOT EXISTS jobs_batch_id ON jobs (batch_id) WHERE batch_id IS NOT NULL;

-- Phase 8: bulk audit metadata (batches) and idempotency (batch_files).
--
-- A batch already exists conceptually as "jobs sharing a batch_id" (added in
-- 0002_jobs_batch_id.sql). This migration adds two pieces missing for the
-- bulk audit UX:
--
--   batches      — metadata that can't live on jobs: user-provided label,
--                  batch-level lifecycle status, announced count, expiry.
--   batch_files  — idempotency join: a row per uploaded file in a batch,
--                  keyed on (batch_id, sha256, filename) so a retry of the
--                  same file content+name returns the existing job_id
--                  instead of double-enqueueing.
--
-- jobs.batch_id stays the membership column. Queries like "all jobs in
-- batch X" still go through jobs.batch_id (with its partial index from
-- 0002), not through batch_files — batch_files is for idempotency only.

CREATE TABLE IF NOT EXISTS batches (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  engagement_id   TEXT NOT NULL,
  label           TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  error           TEXT,
  metadata_json   JSONB
);

CREATE INDEX IF NOT EXISTS batches_user_id_created_at_desc ON batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS batches_engagement_id ON batches (engagement_id);

CREATE TABLE IF NOT EXISTS batch_files (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  job_id      TEXT NOT NULL,
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (batch_id, sha256, filename)
);

CREATE INDEX IF NOT EXISTS batch_files_batch_id ON batch_files (batch_id);
CREATE INDEX IF NOT EXISTS batch_files_job_id ON batch_files (job_id);

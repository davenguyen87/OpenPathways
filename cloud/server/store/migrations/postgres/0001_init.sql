-- Phase 5: persistence schema for Postgres (hosted-mode target, but the
-- adapter is built now so Phase 9 has nothing to catch up on).
--
-- Schema matches cloud/ROADMAP.md §5.3 verbatim. The store adapter exposes
-- the same caller-facing shape as the SQLite adapter: options/result_json/
-- progress_json arrive as parsed objects, timestamps as JS epoch numbers.

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  options       JSONB NOT NULL,
  original_name TEXT,
  upload_path   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  result_json   JSONB,
  progress_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS jobs_created_at_desc ON jobs (created_at DESC);

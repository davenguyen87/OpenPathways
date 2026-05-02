-- Phase 5: persistence schema for SQLite (local dev default).
--
-- SQLite has no JSONB or TIMESTAMPTZ — the store adapter serializes JSON to
-- TEXT and stores timestamps as INTEGER milliseconds (epoch). Callers see
-- the same shape as the Postgres adapter: options is an object,
-- created_at/started_at/finished_at are JS-style epoch numbers.

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  options       TEXT NOT NULL,
  original_name TEXT,
  upload_path   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  error         TEXT,
  result_json   TEXT,
  progress_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS jobs_created_at_desc ON jobs (created_at DESC);

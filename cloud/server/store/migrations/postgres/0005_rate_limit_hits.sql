-- Phase 9C: rate-limit storage backing for express-rate-limit (Postgres).
-- Opt-in via RATE_LIMIT_STORE=postgres. Survives server restart.

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  bucket      TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_expires_at ON rate_limit_hits(expires_at);

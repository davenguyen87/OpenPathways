-- Phase 9C: rate-limit storage backing for express-rate-limit.
--
-- Opt-in via RATE_LIMIT_STORE=postgres + DB_DRIVER=postgres. The sqlite
-- migration is shipped for parity but local dev uses the memory store
-- (matches Phase 9B default).

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  bucket      TEXT NOT NULL,             -- "<key>:<windowEpoch>"
  count       INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (bucket)
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_expires_at ON rate_limit_hits(expires_at);

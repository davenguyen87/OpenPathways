-- Phase 9B: auth + multi-tenancy schema (Postgres).
-- Mirrors the SQLite migration; same caller-facing semantics, different
-- column types (TIMESTAMPTZ vs INTEGER ms; JSONB vs TEXT).

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_email ON magic_link_tokens(email);

CREATE TABLE IF NOT EXISTS login_attempts (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT,
  ip            TEXT,
  attempted_at  TIMESTAMPTZ NOT NULL,
  success       BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_email ON login_attempts(email);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT,
  event_type    TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  details_json  JSONB
);
CREATE INDEX IF NOT EXISTS auth_audit_log_user_id ON auth_audit_log(user_id);

ALTER TABLE jobs ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS jobs_user_id ON jobs(user_id) WHERE user_id IS NOT NULL;

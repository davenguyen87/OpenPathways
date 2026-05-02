-- Phase 9B: auth + multi-tenancy schema.
--
-- Sessions and magic-link tokens are stored as sha256 hashes of the value
-- the client sees (cookie value / URL token). A DB leak doesn't directly
-- compromise active sessions or active links: the attacker has hashes,
-- not the originals. The cookie/URL value carries enough entropy
-- (32+ random bytes) that the lookup itself is the security boundary.
--
-- Schema-level constraints stay minimal. Application-layer logic enforces
-- consume-once on magic_link_tokens and expiry on sessions.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,         -- sha256(cookie value)
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id           TEXT PRIMARY KEY,        -- sha256(URL token)
  email        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_email ON magic_link_tokens(email);

CREATE TABLE IF NOT EXISTS login_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT,
  ip            TEXT,
  attempted_at  INTEGER NOT NULL,
  success       INTEGER NOT NULL          -- 0 / 1
);
CREATE INDEX IF NOT EXISTS login_attempts_email ON login_attempts(email);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,                     -- nullable; failed logins have no user
  event_type    TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  occurred_at   INTEGER NOT NULL,
  details_json  TEXT
);
CREATE INDEX IF NOT EXISTS auth_audit_log_user_id ON auth_audit_log(user_id);

-- Per-user ownership on jobs.
ALTER TABLE jobs ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS jobs_user_id ON jobs(user_id) WHERE user_id IS NOT NULL;

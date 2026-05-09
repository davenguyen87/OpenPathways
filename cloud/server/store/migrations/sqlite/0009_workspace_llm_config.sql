-- Phase 12.5: per-workspace LLM configuration (SQLite).
--
-- Mirrors the Postgres migration; differences:
--   - created_at / updated_at stored as INTEGER (epoch ms, like all other
--     timestamp columns in the sqlite adapter).
--   - No TIMESTAMPTZ — SQLite stores dates as TEXT/INTEGER/REAL.
--   - No trigger for updated_at — the CRUD layer sets it explicitly on
--     every upsert (INSERT OR REPLACE sets both columns; UPDATE sets
--     updated_at = epoch-ms-now in the SQL).
--   - REFERENCES users(id) ON DELETE CASCADE is declared for
--     documentation; enforcement relies on the foreign_keys pragma
--     (SqliteStore.init() sets PRAGMA foreign_keys = ON).
--
-- NOTE: migration numbers 0007 (rebuild kind, Phase 12) and 0008
-- (reserved for Phase 12 checkpoint work) are in use by other Phase 12
-- agents. This migration is 0009, reserved for Phase 12.5.

CREATE TABLE IF NOT EXISTS workspace_llm_config (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'anthropic',
  model             TEXT,
  encrypted_api_key TEXT NOT NULL,   -- base64( iv(12B) || tag(16B) || ciphertext )
  key_last4         TEXT NOT NULL,   -- e.g. 'AbC4' — last 4 chars of plaintext key
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

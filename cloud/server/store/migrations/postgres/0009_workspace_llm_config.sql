-- Phase 12.5: per-workspace LLM configuration (Postgres).
--
-- Stores an encrypted Anthropic API key (or other provider key) per user.
-- The plaintext key is never stored; only the AES-256-GCM ciphertext and
-- a redacted last-4 hint for display in the Settings UI.
--
-- One row per user (user_id is the PK). Upsert semantics: the CRUD layer
-- does INSERT ... ON CONFLICT DO UPDATE so callers can freely call
-- setWorkspaceLlmConfig without checking existence first.
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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on any row change.
CREATE OR REPLACE FUNCTION workspace_llm_config_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_llm_config_updated_at
  BEFORE UPDATE ON workspace_llm_config
  FOR EACH ROW
  EXECUTE FUNCTION workspace_llm_config_set_updated_at();

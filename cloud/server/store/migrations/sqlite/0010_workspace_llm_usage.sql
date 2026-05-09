-- Phase 12.5: per-workspace LLM usage telemetry (SQLite).
--
-- Records one row per LLM call so users can see their last-30-day spend.
-- Differences from Postgres:
--   - occurred_at stored as INTEGER (epoch ms, consistent with all other
--     timestamp columns in the SQLite adapter).
--   - No TIMESTAMPTZ — SQLite stores dates as TEXT/INTEGER/REAL.
--   - REFERENCES users(id) ON DELETE CASCADE is declared for documentation;
--     enforcement relies on the foreign_keys pragma (set ON in SqliteStore.init).

CREATE TABLE IF NOT EXISTS workspace_llm_usage (
  id                TEXT    PRIMARY KEY,          -- uuid
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature           TEXT    NOT NULL,             -- 'narrative' | 'assisted' | 'judgment'
  model             TEXT    NOT NULL,
  input_tokens      INTEGER NOT NULL,
  output_tokens     INTEGER NOT NULL,
  estimated_cost_usd REAL   NOT NULL,
  occurred_at       INTEGER NOT NULL              -- epoch ms
);

CREATE INDEX IF NOT EXISTS workspace_llm_usage_user_at
  ON workspace_llm_usage (user_id, occurred_at DESC);

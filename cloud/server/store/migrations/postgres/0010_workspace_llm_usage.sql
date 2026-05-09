-- Phase 12.5: per-workspace LLM usage telemetry (Postgres).
--
-- Records one row per LLM call so users can see their last-30-day spend.
-- One row per LLM call per user per feature; the rollup query aggregates.

CREATE TABLE IF NOT EXISTS workspace_llm_usage (
  id                TEXT        PRIMARY KEY,       -- uuid
  user_id           TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature           TEXT        NOT NULL,          -- 'narrative' | 'assisted' | 'judgment'
  model             TEXT        NOT NULL,
  input_tokens      INTEGER     NOT NULL,
  output_tokens     INTEGER     NOT NULL,
  estimated_cost_usd REAL       NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_llm_usage_user_at
  ON workspace_llm_usage (user_id, occurred_at DESC);

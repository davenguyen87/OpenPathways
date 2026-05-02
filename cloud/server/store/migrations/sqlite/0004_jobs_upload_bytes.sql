-- Phase 9C: track upload size per job for stored-bytes quota + disk
-- eviction. Nullable so 9A/9B rows stay valid; quota math treats NULL as 0.

ALTER TABLE jobs ADD COLUMN upload_bytes INTEGER;

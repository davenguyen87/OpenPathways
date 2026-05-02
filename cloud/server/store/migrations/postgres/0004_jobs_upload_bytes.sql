-- Phase 9C: track upload size per job (Postgres). BIGINT — uploads can be
-- up to 1 GB, comfortably under 2^63 but a plain INT (32-bit) feels small.

ALTER TABLE jobs ADD COLUMN upload_bytes BIGINT;

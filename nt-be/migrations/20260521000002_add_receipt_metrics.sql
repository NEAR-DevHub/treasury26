ALTER TABLE usage_tracking
    ADD COLUMN IF NOT EXISTS receipts_generated int4 NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS receipts_printed int4 NOT NULL DEFAULT 0;
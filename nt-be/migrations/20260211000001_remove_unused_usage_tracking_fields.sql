-- Remove unused usage_tracking columns and related indexes.
-- Drop any optional indexes that may have been created on these columns.
DROP INDEX IF EXISTS idx_usage_tracking_exchanges_count;

DROP INDEX IF EXISTS idx_usage_tracking_exchanges_volume_cents;

DROP INDEX IF EXISTS idx_usage_tracking_overage_volume_cents;

DROP INDEX IF EXISTS idx_usage_tracking_overage_fees_cents;

DROP INDEX IF EXISTS idx_usage_tracking_exchange_fees_cents;

DROP INDEX IF EXISTS idx_usage_tracking_total_fees_cents;

ALTER TABLE
    usage_tracking DROP COLUMN IF EXISTS exchanges_count,
    DROP COLUMN IF EXISTS exchanges_volume_cents,
    DROP COLUMN IF EXISTS overage_volume_cents,
    DROP COLUMN IF EXISTS overage_fees_cents,
    DROP COLUMN IF EXISTS exchange_fees_cents,
    DROP COLUMN IF EXISTS total_fees_cents;

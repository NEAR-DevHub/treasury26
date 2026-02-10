-- Add subscription system with plan tiers and usage tracking
-- For launch: All new users get Pro plan via API, no payment processing
-- Metrics tracking is retained for future monetization
--------------------------------------------------------------------------------
-- ENUMS
--------------------------------------------------------------------------------
-- Plan types: free, plus, pro, enterprise
CREATE TYPE plan_type AS ENUM ('free', 'plus', 'pro', 'enterprise');

--------------------------------------------------------------------------------
-- ALTER monitored_accounts: Add plan_type
--------------------------------------------------------------------------------
ALTER TABLE
    monitored_accounts
ADD
    COLUMN plan_type plan_type NOT NULL DEFAULT 'free';

ALTER TABLE
    monitored_accounts
ADD
    COLUMN credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    
ALTER TABLE
    monitored_accounts
ADD
    COLUMN gas_covered_transactions INTEGER NOT NULL DEFAULT 10;

CREATE INDEX idx_monitored_accounts_plan_type ON monitored_accounts(plan_type);

COMMENT ON COLUMN monitored_accounts.plan_type IS 'Subscription plan tier: free, plus, pro, enterprise';

COMMENT ON COLUMN monitored_accounts.credits_reset_at IS 'Last time export_credits and batch_payment_credits were reset (1st of month for paid plans)';

--------------------------------------------------------------------------------
-- TABLE: usage_tracking (retained for metrics)
--------------------------------------------------------------------------------
CREATE TABLE usage_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Link to monitored account
    monitored_account_id TEXT NOT NULL REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,
    -- Billing period
    billing_year INTEGER NOT NULL,
    billing_month INTEGER NOT NULL,
    -- Volume tracking (in USD cents)
    outbound_volume_cents BIGINT NOT NULL DEFAULT 0,
    -- Feature usage
    exports_used INTEGER NOT NULL DEFAULT 0,
    batch_payments_used INTEGER NOT NULL DEFAULT 0,
    gas_covered_transactions INTEGER NOT NULL DEFAULT 0,
    -- Exchange/swap tracking
    exchanges_count INTEGER NOT NULL DEFAULT 0,
    exchanges_volume_cents BIGINT NOT NULL DEFAULT 0,
    -- Fee tracking (in USD cents) - for future monetization
    overage_volume_cents BIGINT NOT NULL DEFAULT 0,
    overage_fees_cents BIGINT NOT NULL DEFAULT 0,
    exchange_fees_cents BIGINT NOT NULL DEFAULT 0,
    total_fees_cents BIGINT NOT NULL DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One record per account per month
    UNIQUE(
        monitored_account_id,
        billing_year,
        billing_month
    )
);

CREATE INDEX idx_usage_tracking_account_period ON usage_tracking(
    monitored_account_id,
    billing_year,
    billing_month
);

CREATE INDEX idx_usage_tracking_period ON usage_tracking(billing_year, billing_month);

CREATE
OR REPLACE FUNCTION update_usage_tracking_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW();

RETURN NEW;

END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_usage_tracking_updated_at BEFORE
UPDATE
    ON usage_tracking FOR EACH ROW EXECUTE FUNCTION update_usage_tracking_updated_at();

COMMENT ON TABLE usage_tracking IS 'Monthly usage tracking for metrics and future billing';

COMMENT ON COLUMN usage_tracking.outbound_volume_cents IS 'Total outbound payment volume in USD cents';

COMMENT ON COLUMN usage_tracking.overage_volume_cents IS 'Volume exceeding plan monthly limit in USD cents';

COMMENT ON COLUMN usage_tracking.overage_fees_cents IS 'Calculated fees for overage (for future billing)';

COMMENT ON COLUMN usage_tracking.exchange_fees_cents IS 'Calculated fees for token swaps/exchanges (for future billing)';

UPDATE
    monitored_accounts
SET
    plan_type = 'pro',
    batch_payment_credits = 100,
    export_credits = 10,
    gas_covered_transactions = 1000;

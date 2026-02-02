-- Add subscription system with plan tiers, subscriptions, payments, and usage tracking
-- Supports two payment providers:
--   - Stripe: Recurring subscriptions (monthly/yearly) with auto-renewal
--   - PingPay: One-time crypto payments for fixed periods (6 or 12 months), NO auto-renewal

--------------------------------------------------------------------------------
-- ENUMS
--------------------------------------------------------------------------------

-- Plan types: free, plus, pro, enterprise
CREATE TYPE plan_type AS ENUM ('free', 'plus', 'pro', 'enterprise');

-- Subscription status
CREATE TYPE subscription_status AS ENUM (
    'active',
    'cancelled',
    'expired',
    'past_due',
    'trialing'
);

-- Payment provider
CREATE TYPE payment_provider AS ENUM ('stripe', 'pingpay');

-- Billing period
CREATE TYPE billing_period AS ENUM ('monthly', 'six_months', 'yearly');

-- Payment status
CREATE TYPE payment_status AS ENUM (
    'pending',
    'processing',
    'succeeded',
    'failed',
    'refunded',
    'cancelled'
);

--------------------------------------------------------------------------------
-- ALTER monitored_accounts: Add plan_type
--------------------------------------------------------------------------------

ALTER TABLE monitored_accounts
ADD COLUMN plan_type plan_type NOT NULL DEFAULT 'free';

ALTER TABLE monitored_accounts
ADD COLUMN credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Note: monthly volume is calculated dynamically from usage_tracking table

CREATE INDEX idx_monitored_accounts_plan_type ON monitored_accounts(plan_type);

COMMENT ON COLUMN monitored_accounts.plan_type IS 'Subscription plan tier: free, plus, pro, enterprise';
COMMENT ON COLUMN monitored_accounts.credits_reset_at IS 'Last time export_credits and batch_payment_credits were reset (1st of month for paid plans)';

--------------------------------------------------------------------------------
-- TABLE: subscriptions
--------------------------------------------------------------------------------

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Link to monitored account (treasury)
    monitored_account_id TEXT NOT NULL REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,

    -- User who purchased the subscription/access
    purchased_by_account_id VARCHAR(64) REFERENCES users(account_id) ON DELETE SET NULL,

    -- Plan and billing
    plan_type plan_type NOT NULL,
    billing_period billing_period NOT NULL,
    payment_provider payment_provider NOT NULL,

    -- Stripe fields (recurring subscription)
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),

    -- PingPay fields (one-time payment, NOT a subscription)
    pingpay_payment_id VARCHAR(255),
    pingpay_wallet_address VARCHAR(128),

    -- Lifecycle
    status subscription_status NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,

    -- Price at time of subscription (in USD cents)
    amount_cents INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',

    -- Cancellation tracking
    cancelled_at TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,

    -- Auto-renew flag (true for Stripe, false for PingPay)
    auto_renew BOOLEAN NOT NULL DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_account ON subscriptions(monitored_account_id);
CREATE INDEX idx_subscriptions_purchaser ON subscriptions(purchased_by_account_id);
CREATE INDEX idx_subscriptions_active ON subscriptions(status) WHERE status = 'active';
CREATE INDEX idx_subscriptions_period_end ON subscriptions(current_period_end) WHERE status = 'active';
CREATE UNIQUE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX idx_subscriptions_pingpay ON subscriptions(pingpay_payment_id) WHERE pingpay_payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION update_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_subscriptions_updated_at();

COMMENT ON TABLE subscriptions IS 'Tracks active and historical subscriptions/access periods for treasuries';
COMMENT ON COLUMN subscriptions.stripe_subscription_id IS 'Stripe subscription ID for recurring payments';
COMMENT ON COLUMN subscriptions.pingpay_payment_id IS 'PingPay payment ID for one-time crypto payments';
COMMENT ON COLUMN subscriptions.pingpay_wallet_address IS 'Crypto wallet address that made the payment';
COMMENT ON COLUMN subscriptions.auto_renew IS 'true for Stripe recurring, false for PingPay one-time';

--------------------------------------------------------------------------------
-- TABLE: payments
--------------------------------------------------------------------------------

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Link to subscription (optional)
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,

    -- Link to monitored account
    monitored_account_id TEXT NOT NULL REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,

    -- Payment provider
    payment_provider payment_provider NOT NULL,

    -- Auth user who made the payment (NEAR account)
    payer_account_id VARCHAR(64) REFERENCES users(account_id) ON DELETE SET NULL,

    -- Stripe fields
    stripe_payment_intent_id VARCHAR(255),
    stripe_invoice_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    stripe_card_brand VARCHAR(32),
    stripe_card_last4 VARCHAR(4),
    stripe_card_first6 VARCHAR(6),

    -- PingPay/Crypto fields
    pingpay_transaction_id VARCHAR(255),
    pingpay_transaction_hash VARCHAR(128),
    crypto_wallet_address VARCHAR(128),
    crypto_amount VARCHAR(64),
    crypto_currency VARCHAR(32),

    -- Payment details
    amount_cents INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status payment_status NOT NULL DEFAULT 'pending',
    description TEXT,
    metadata JSONB,

    -- Error tracking
    failure_reason TEXT,

    -- Timestamps
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_account ON payments(monitored_account_id);
CREATE INDEX idx_payments_subscription ON payments(subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX idx_payments_payer ON payments(payer_account_id) WHERE payer_account_id IS NOT NULL;
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_paid_at ON payments(paid_at) WHERE paid_at IS NOT NULL;
CREATE UNIQUE INDEX idx_payments_stripe_intent ON payments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_payments_pingpay_tx ON payments(pingpay_transaction_id) WHERE pingpay_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX idx_payments_pingpay_hash ON payments(pingpay_transaction_hash) WHERE pingpay_transaction_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION update_payments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION update_payments_updated_at();

COMMENT ON TABLE payments IS 'Tracks all payment transactions from Stripe and PingPay';
COMMENT ON COLUMN payments.stripe_card_brand IS 'Card brand: visa, mastercard, amex, etc.';
COMMENT ON COLUMN payments.stripe_card_last4 IS 'Last 4 digits of the card used';
COMMENT ON COLUMN payments.stripe_card_first6 IS 'BIN/First 6 digits for card identification';
COMMENT ON COLUMN payments.pingpay_transaction_hash IS 'On-chain transaction hash for crypto payment verification';
COMMENT ON COLUMN payments.crypto_wallet_address IS 'Crypto wallet address that made the payment';

--------------------------------------------------------------------------------
-- TABLE: usage_tracking
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

    -- Exchange/swap tracking
    exchanges_count INTEGER NOT NULL DEFAULT 0,
    exchanges_volume_cents BIGINT NOT NULL DEFAULT 0,

    -- Fee tracking (in USD cents)
    overage_volume_cents BIGINT NOT NULL DEFAULT 0,
    overage_fees_cents BIGINT NOT NULL DEFAULT 0,
    exchange_fees_cents BIGINT NOT NULL DEFAULT 0,
    total_fees_cents BIGINT NOT NULL DEFAULT 0,

    -- Fee collection
    fees_collected_at TIMESTAMPTZ,
    fees_payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One record per account per month
    UNIQUE(monitored_account_id, billing_year, billing_month)
);

CREATE INDEX idx_usage_tracking_account_period ON usage_tracking(monitored_account_id, billing_year, billing_month);
CREATE INDEX idx_usage_tracking_period ON usage_tracking(billing_year, billing_month);

CREATE OR REPLACE FUNCTION update_usage_tracking_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_usage_tracking_updated_at
    BEFORE UPDATE ON usage_tracking
    FOR EACH ROW
    EXECUTE FUNCTION update_usage_tracking_updated_at();

COMMENT ON TABLE usage_tracking IS 'Monthly usage tracking for overage billing and fee collection';
COMMENT ON COLUMN usage_tracking.outbound_volume_cents IS 'Total outbound payment volume in USD cents';
COMMENT ON COLUMN usage_tracking.overage_volume_cents IS 'Volume exceeding plan monthly limit in USD cents';
COMMENT ON COLUMN usage_tracking.overage_fees_cents IS 'Fees collected for overage';
COMMENT ON COLUMN usage_tracking.exchange_fees_cents IS 'Fees collected for token swaps/exchanges';

-- Create subscription tables for PingPay integration

-- Subscription plans (configurable pricing)
CREATE TABLE subscription_plans (
    id VARCHAR(16) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    duration_months INTEGER NOT NULL,
    price_usdc NUMERIC(18, 6) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Treasury subscriptions
CREATE TABLE treasury_subscriptions (
    id SERIAL PRIMARY KEY,
    account_id VARCHAR(128) NOT NULL,
    plan_id VARCHAR(16) NOT NULL REFERENCES subscription_plans(id),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_subscription_status CHECK (status IN ('pending', 'active', 'expired', 'cancelled'))
);

-- Payment records
CREATE TABLE subscription_payments (
    id SERIAL PRIMARY KEY,
    subscription_id INTEGER NOT NULL REFERENCES treasury_subscriptions(id),
    usdc_amount NUMERIC(18, 6) NOT NULL,
    pingpay_session_id VARCHAR(128),
    pingpay_payment_id VARCHAR(128),
    deposit_address VARCHAR(256),
    tx_status VARCHAR(32),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT valid_payment_status CHECK (status IN ('pending', 'completed', 'failed', 'expired'))
);

-- Invoice records
CREATE TABLE subscription_invoices (
    id SERIAL PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES subscription_payments(id),
    invoice_number VARCHAR(32) NOT NULL UNIQUE,
    invoice_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_treasury_subscriptions_account ON treasury_subscriptions(account_id);
CREATE INDEX idx_treasury_subscriptions_status ON treasury_subscriptions(status);
CREATE INDEX idx_treasury_subscriptions_expires ON treasury_subscriptions(expires_at);
CREATE INDEX idx_subscription_payments_subscription ON subscription_payments(subscription_id);
CREATE INDEX idx_subscription_payments_session ON subscription_payments(pingpay_session_id);
CREATE INDEX idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX idx_subscription_invoices_payment ON subscription_invoices(payment_id);

-- Trigger to auto-update updated_at on treasury_subscriptions
CREATE OR REPLACE FUNCTION update_treasury_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_treasury_subscriptions_updated_at
    BEFORE UPDATE ON treasury_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_treasury_subscriptions_updated_at();

-- Seed default plans (placeholder pricing - update as needed)
INSERT INTO subscription_plans (id, name, duration_months, price_usdc) VALUES
    ('3m', '3 Month Subscription', 3, 50.000000),
    ('6m', '6 Month Subscription', 6, 90.000000),
    ('12m', '12 Month Subscription', 12, 150.000000);

COMMENT ON TABLE subscription_plans IS 'Available subscription plans with pricing';
COMMENT ON TABLE treasury_subscriptions IS 'Treasury subscription records';
COMMENT ON TABLE subscription_payments IS 'Payment records for subscriptions (PingPay integration)';
COMMENT ON TABLE subscription_invoices IS 'Generated invoices for subscription payments';

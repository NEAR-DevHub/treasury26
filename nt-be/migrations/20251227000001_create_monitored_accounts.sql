-- Create monitored_accounts table for tracking accounts to continuously monitor
CREATE TABLE monitored_accounts (
    account_id TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_synced_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for querying enabled accounts efficiently
CREATE INDEX idx_monitored_accounts_enabled ON monitored_accounts(enabled) WHERE enabled = true;

-- Trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_monitored_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER monitored_accounts_updated_at
    BEFORE UPDATE ON monitored_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_monitored_accounts_updated_at();

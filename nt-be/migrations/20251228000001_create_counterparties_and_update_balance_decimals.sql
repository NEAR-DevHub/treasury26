-- Create counterparties table for storing account metadata
CREATE TABLE counterparties (
    account_id VARCHAR(64) PRIMARY KEY,
    account_type VARCHAR(32) NOT NULL,  -- 'ft_token', 'staking_pool', 'dao', 'personal', 'system', 'other'
    
    -- FT token metadata (NULL for non-FT accounts)
    token_symbol VARCHAR(16),
    token_name TEXT,
    token_decimals SMALLINT,
    token_icon TEXT,
    
    -- Discovery metadata
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified_at TIMESTAMPTZ,
    
    -- Additional metadata (JSONB for flexibility)
    metadata JSONB,
    
    -- Constraints
    CONSTRAINT valid_account_type CHECK (account_type IN ('ft_token', 'staking_pool', 'dao', 'personal', 'system', 'other')),
    CONSTRAINT ft_token_has_decimals CHECK (
        (account_type = 'ft_token' AND token_decimals IS NOT NULL) OR
        (account_type != 'ft_token')
    )
);

-- Indexes for common queries
CREATE INDEX idx_counterparties_type ON counterparties(account_type);
CREATE INDEX idx_counterparties_symbol ON counterparties(token_symbol) WHERE token_symbol IS NOT NULL;

COMMENT ON TABLE counterparties IS 'Stores metadata about accounts that appear as counterparties in balance changes';
COMMENT ON COLUMN counterparties.token_decimals IS 'Number of decimal places for FT tokens (e.g., 6 for arizcredits.near, 24 for NEAR)';

-- Update balance_changes to use NUMERIC for human-readable amounts with decimals
-- NUMERIC without precision/scale allows arbitrary precision without rounding
ALTER TABLE balance_changes ALTER COLUMN amount TYPE NUMERIC;
ALTER TABLE balance_changes ALTER COLUMN balance_before TYPE NUMERIC;
ALTER TABLE balance_changes ALTER COLUMN balance_after TYPE NUMERIC;

COMMENT ON COLUMN balance_changes.amount IS 'Human-readable token amount with decimals (e.g., 2.5 for 2.5 ARIZ, not 2500000)';
COMMENT ON COLUMN balance_changes.balance_before IS 'Human-readable balance before the change, with decimals';
COMMENT ON COLUMN balance_changes.balance_after IS 'Human-readable balance after the change, with decimals';

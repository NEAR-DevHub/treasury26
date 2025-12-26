-- Create balance_changes table for storing account balance history
CREATE TABLE balance_changes (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL,
    
    -- Block metadata
    block_height BIGINT NOT NULL,
    block_timestamp BIGINT NOT NULL,
    
    -- Transaction info
    transaction_block BIGINT,
    transaction_hashes TEXT[] NOT NULL DEFAULT '{}',
    signer_id VARCHAR(64),
    receiver_id VARCHAR(64),
    
    -- Token and transfer data
    token_id VARCHAR(64),
    receipt_id TEXT[] NOT NULL DEFAULT '{}',
    counterparty VARCHAR(64) NOT NULL,
    amount NUMERIC(78, 0) NOT NULL,  -- Up to 78 digits for yoctoNEAR amounts
    balance_before NUMERIC(78, 0) NOT NULL,  -- Arbitrary precision for large token amounts
    balance_after NUMERIC(78, 0) NOT NULL,  -- Arbitrary precision for large token amounts
    
    -- Raw data for debugging
    actions JSONB,
    raw_data JSONB,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT unique_account_block_token UNIQUE(account_id, block_height, token_id),
    CONSTRAINT positive_block_timestamp CHECK (block_timestamp > 0),
    CONSTRAINT positive_block_height CHECK (block_height > 0)
);

-- Indexes for common queries
CREATE INDEX idx_balance_changes_account ON balance_changes(account_id);
CREATE INDEX idx_balance_changes_block_height ON balance_changes(block_height DESC);
CREATE INDEX idx_balance_changes_timestamp ON balance_changes(block_timestamp DESC);
CREATE INDEX idx_balance_changes_tx_hashes ON balance_changes USING GIN(transaction_hashes);
CREATE INDEX idx_balance_changes_token_id ON balance_changes(token_id);
CREATE INDEX idx_balance_changes_counterparty ON balance_changes(counterparty);
CREATE INDEX idx_balance_changes_receipt_id ON balance_changes USING GIN(receipt_id);

-- Composite index for common balance queries
CREATE INDEX idx_balance_changes_account_token_block ON balance_changes(account_id, token_id, block_height DESC);

COMMENT ON TABLE balance_changes IS 'Stores balance change history from NEAR blockchain transactions';
COMMENT ON COLUMN balance_changes.token_id IS 'NULL for NEAR token, contract address for fungible tokens';
COMMENT ON COLUMN balance_changes.amount IS 'Positive for incoming, negative for outgoing';

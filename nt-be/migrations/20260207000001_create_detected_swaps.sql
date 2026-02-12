-- Create detected_swaps table for tracking swap fulfillments
-- Swaps are identified when a solver transaction debits one token from a deposit address
-- and credits another token to the user's account in the same transaction.

CREATE TABLE detected_swaps (
    id BIGSERIAL PRIMARY KEY,

    -- The account that performed the swap
    account_id VARCHAR(128) NOT NULL,

    -- Solver transaction that fulfilled the swap
    solver_transaction_hash TEXT NOT NULL,
    solver_account_id VARCHAR(128),

    -- The deposit this swap fulfilled (may be NULL if deposit not tracked)
    deposit_address VARCHAR(128),           -- intents deposit address the user sent to
    deposit_receipt_id TEXT,                -- receipt from when user deposited
    deposit_balance_change_id BIGINT REFERENCES balance_changes(id),

    -- The fulfillment (receive leg)
    fulfillment_receipt_id TEXT NOT NULL,
    fulfillment_balance_change_id BIGINT NOT NULL REFERENCES balance_changes(id),

    -- Token amounts
    sent_token_id VARCHAR(256),
    sent_amount NUMERIC(78, 18),
    received_token_id VARCHAR(256) NOT NULL,
    received_amount NUMERIC(78, 18) NOT NULL,

    -- Block info
    block_height BIGINT NOT NULL,
    block_timestamp BIGINT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT unique_swap_fulfillment UNIQUE(account_id, fulfillment_receipt_id)
);

-- Indexes
CREATE INDEX idx_detected_swaps_account ON detected_swaps(account_id);
CREATE INDEX idx_detected_swaps_solver_tx ON detected_swaps(solver_transaction_hash);
CREATE INDEX idx_detected_swaps_block ON detected_swaps(block_height DESC);
CREATE INDEX idx_detected_swaps_deposit_bc ON detected_swaps(deposit_balance_change_id) WHERE deposit_balance_change_id IS NOT NULL;
CREATE INDEX idx_detected_swaps_fulfillment_bc ON detected_swaps(fulfillment_balance_change_id);

COMMENT ON TABLE detected_swaps IS 'Stores detected swap fulfillments linking deposit and receive legs';
COMMENT ON COLUMN detected_swaps.solver_transaction_hash IS 'Transaction hash of the solver fulfillment';
COMMENT ON COLUMN detected_swaps.deposit_balance_change_id IS 'FK to the balance_change record for the deposit leg (may be NULL if unfound)';
COMMENT ON COLUMN detected_swaps.fulfillment_balance_change_id IS 'FK to the balance_change record for the receive leg';

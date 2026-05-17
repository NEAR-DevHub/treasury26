-- Create confidential_history_events table for storing confidential account history

CREATE TABLE IF NOT EXISTS confidential_history_events (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(128) NOT NULL,
    created_at_external TIMESTAMPTZ NOT NULL,
    deposit_address TEXT NOT NULL,
    deposit_memo TEXT,
    status TEXT NOT NULL,
    deposit_type TEXT NOT NULL,
    recipient_type TEXT,
    recipient TEXT,
    origin_asset TEXT,
    destination_asset TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() --last time system  this row
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_che ON confidential_history_events (account_id, created_at_external, deposit_address);

CREATE INDEX IF NOT EXISTS idx_che_in_flight ON confidential_history_events (account_id, status) WHERE status IN ('SUCCESS');


-- Create confidential_history_cursors table for storing confidential polling cursors

CREATE TABLE IF NOT EXISTS confidential_history_cursors(
    account_id VARCHAR(128) PRIMARY KEY,
    forward_cursor TEXT,  --required for forward polling
    backward_cursor TEXT, --required for backward polling
    backfill_done BOOLEAN NOT NULL DEFAULT FALSE, 
    next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_polled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), 
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chc_next_poll_at ON confidential_history_cursors (next_poll_at);
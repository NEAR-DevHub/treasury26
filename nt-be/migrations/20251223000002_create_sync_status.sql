-- Create sync_status table for tracking import progress
CREATE TABLE sync_status (
    id SERIAL PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL UNIQUE,
    
    last_synced_block BIGINT NOT NULL,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    first_block BIGINT,
    total_changes INTEGER DEFAULT 0,
    
    sync_errors JSONB,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT positive_last_synced_block CHECK (last_synced_block >= 0)
);

-- Index for looking up sync status by account
CREATE INDEX idx_sync_status_account ON sync_status(account_id);
CREATE INDEX idx_sync_status_last_synced ON sync_status(last_synced_at DESC);

COMMENT ON TABLE sync_status IS 'Tracks synchronization progress for account balance imports';
COMMENT ON COLUMN sync_status.last_synced_block IS 'Last block height successfully synced';
COMMENT ON COLUMN sync_status.total_changes IS 'Total number of balance change records imported';

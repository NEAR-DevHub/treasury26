-- Create daos table for caching DAO information from sputnik-dao.near
CREATE TABLE daos (
    dao_id VARCHAR(128) PRIMARY KEY,
    is_dirty BOOLEAN NOT NULL DEFAULT true,
    sync_failed BOOLEAN NOT NULL DEFAULT false,  -- DAOs that fail to sync (incompatible contracts)
    source VARCHAR(32) NOT NULL DEFAULT 'factory',  -- 'factory' or 'manual'
    last_policy_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient dirty DAO queries (high priority processing, exclude failed)
CREATE INDEX idx_daos_dirty ON daos(is_dirty) WHERE is_dirty = true AND sync_failed = false;

-- Index for periodic processing (non-dirty DAOs ordered by last sync time, exclude failed)
CREATE INDEX idx_daos_last_policy_sync ON daos(last_policy_sync_at) WHERE is_dirty = false AND sync_failed = false;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_daos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daos_updated_at
    BEFORE UPDATE ON daos
    FOR EACH ROW
    EXECUTE FUNCTION update_daos_updated_at();

-- Create dao_members table for member-to-DAO mappings
CREATE TABLE dao_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dao_id VARCHAR(128) NOT NULL REFERENCES daos(dao_id) ON DELETE CASCADE,
    account_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(dao_id, account_id)
);

-- Index for fast user treasury lookups (primary use case)
CREATE INDEX idx_dao_members_account_id ON dao_members(account_id);

-- Index for DAO membership queries
CREATE INDEX idx_dao_members_dao_id ON dao_members(dao_id);

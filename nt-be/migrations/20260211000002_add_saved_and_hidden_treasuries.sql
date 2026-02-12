-- Extend dao_members to support user-saved and hidden treasuries
ALTER TABLE dao_members
    ADD COLUMN is_policy_member BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN is_saved BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false;

-- Optimize visible treasury lookup for a user
CREATE INDEX idx_dao_members_account_visible
    ON dao_members(account_id, is_hidden)
    WHERE is_hidden = false;

-- Optimize sync cleanup of non-policy/non-saved rows
CREATE INDEX idx_dao_members_policy_saved
    ON dao_members(dao_id, is_policy_member, is_saved);

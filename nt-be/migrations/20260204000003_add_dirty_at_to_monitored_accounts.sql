ALTER TABLE monitored_accounts
ADD COLUMN dirty_at TIMESTAMPTZ;

-- Index for efficiently querying dirty accounts
CREATE INDEX idx_monitored_accounts_dirty
ON monitored_accounts(dirty_at) WHERE dirty_at IS NOT NULL;

ALTER TABLE confidential_history_cursors
    ADD COLUMN IF NOT EXISTS last_confidential_activity_at TIMESTAMPTZ;

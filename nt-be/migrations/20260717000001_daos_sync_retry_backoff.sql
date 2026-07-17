-- Per-DAO retry backoff for the dirty-DAO policy sync.
--
-- Before this, `process_dirty_daos` retried every dirty, non-failed DAO on
-- every cycle (`ORDER BY updated_at ASC LIMIT 50`). A DAO whose `get_policy`
-- kept failing with a *transient* error (deleted account, malformed policy,
-- RPC rate-limit) stayed dirty with an unchanged `updated_at`, so it sorted to
-- the front and reclaimed a processing slot forever. Enough of them starved
-- freshly created treasuries (newest `updated_at`, back of the queue) for
-- hours. These columns let a failing DAO back off and free its slot.

ALTER TABLE daos
    -- Consecutive failed sync attempts since the last success; reset to 0 on
    -- success. Drives the exponential backoff and the escalation to
    -- `sync_failed` after a cap.
    ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0,
    -- When the DAO is next eligible for a sync attempt. NULL means "due now"
    -- (never-deferred). Set to a backoff point in the future after a transient
    -- failure so the worker skips it until then.
    ADD COLUMN next_retry_at TIMESTAMPTZ;

-- Replaces `idx_daos_dirty` for the new selection: dirty, non-failed DAOs that
-- are due, ordered so never-synced DAOs (new treasuries) come first. Keeping
-- `next_retry_at` in the index lets the due-filter use it.
DROP INDEX IF EXISTS idx_daos_dirty;
CREATE INDEX idx_daos_dirty_due
    ON daos (last_policy_sync_at NULLS FIRST, next_retry_at NULLS FIRST)
    WHERE is_dirty = true AND sync_failed = false;

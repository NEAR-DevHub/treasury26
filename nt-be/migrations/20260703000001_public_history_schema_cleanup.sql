DROP INDEX IF EXISTS idx_bphc_due;
DROP INDEX IF EXISTS idx_bphe_account_time;
DROP INDEX IF EXISTS idx_sptl_account_time;
DROP INDEX IF EXISTS idx_gphe_dao_event_time;
DROP INDEX IF EXISTS idx_gphe_dao_type_event_time;

ALTER TABLE bronze_public_history_cursors
    DROP COLUMN IF EXISTS forward_cursor,
    DROP COLUMN IF EXISTS next_poll_at,
    DROP COLUMN IF EXISTS last_polled_at,
    DROP COLUMN IF EXISTS last_activity_at,
    DROP COLUMN IF EXISTS last_seen_block_timestamp;

ALTER TABLE bronze_public_history_events
    DROP COLUMN IF EXISTS block_hash;

ALTER TABLE silver_public_transfer_legs
    DROP COLUMN IF EXISTS event_index,
    DROP COLUMN IF EXISTS block_timestamp,
    DROP COLUMN IF EXISTS confidence,
    DROP COLUMN IF EXISTS linked_mint_bronze_id,
    DROP COLUMN IF EXISTS linked_transfer_bronze_id;

CREATE INDEX IF NOT EXISTS idx_bphe_account_time
    ON bronze_public_history_events (account_id, block_time, block_height, id);

CREATE INDEX IF NOT EXISTS idx_sptl_account_time
    ON silver_public_transfer_legs (account_id, block_time, block_height, id);

CREATE INDEX IF NOT EXISTS idx_gphe_dao_event_time
    ON gold_public_history_events (dao_id, event_time DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_gphe_dao_type_event_time
    ON gold_public_history_events (dao_id, transaction_type, event_time DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_apalis_jobs_active_key
    ON apalis.jobs (job_type, ((job->>'job_key')))
    WHERE status IN ('Pending', 'Running', 'Failed');

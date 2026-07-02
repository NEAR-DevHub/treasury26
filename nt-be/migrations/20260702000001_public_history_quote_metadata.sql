CREATE TYPE public_history_event_status AS ENUM (
    'pending',
    'success',
    'failed'
);

ALTER TABLE dao_proposals
    ADD COLUMN IF NOT EXISTS quote_metadata JSONB,
    ADD COLUMN IF NOT EXISTS quote_deposit_address TEXT;

CREATE INDEX IF NOT EXISTS idx_dao_proposals_quote_deposit_address
    ON dao_proposals (dao_id, quote_deposit_address)
    WHERE quote_deposit_address IS NOT NULL;

ALTER TABLE gold_public_history_events
    ADD COLUMN IF NOT EXISTS status public_history_event_status NOT NULL DEFAULT 'success',
    DROP COLUMN IF EXISTS swap_correlation_id,
    DROP COLUMN IF EXISTS swap_status;

ALTER TYPE public_history_source ADD VALUE IF NOT EXISTS 'quote_projection';
ALTER TYPE public_transfer_leg_kind ADD VALUE IF NOT EXISTS 'quote_pending';

ALTER TABLE dao_proposals
    ADD COLUMN IF NOT EXISTS quote_status_checked_at TIMESTAMPTZ;

ALTER TABLE silver_public_transfer_legs
    ALTER COLUMN source_event_id DROP NOT NULL;

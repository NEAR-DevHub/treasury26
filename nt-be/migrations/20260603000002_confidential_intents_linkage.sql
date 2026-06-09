-- Link confidential intent requests to DAO proposals and 1Click history events.
-- confidential_intents itself is created in 20260403000001_add_confidential.sql.

ALTER TABLE confidential_intents
    ADD COLUMN IF NOT EXISTS deposit_address TEXT,
    ADD COLUMN IF NOT EXISTS history_event_id BIGINT REFERENCES bronze_confidential_history_events(id),
    ADD COLUMN IF NOT EXISTS proposal_id BIGINT,
    ADD COLUMN IF NOT EXISTS proposal_created_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS proposal_executed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS proposal_execution_block_height BIGINT,
    ADD COLUMN IF NOT EXISTS proposal_execution_transaction_hash TEXT;

UPDATE confidential_intents
SET deposit_address = quote_metadata->'quote'->>'depositAddress'
WHERE deposit_address IS NULL
  AND quote_metadata IS NOT NULL
  AND quote_metadata->'quote'->>'depositAddress' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_confidential_intents_deposit_address
    ON confidential_intents (dao_id, deposit_address)
    WHERE deposit_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_confidential_intents_proposal_id
    ON confidential_intents (dao_id, proposal_id)
    WHERE proposal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_confidential_intents_history_event_id
    ON confidential_intents (history_event_id)
    WHERE history_event_id IS NOT NULL;

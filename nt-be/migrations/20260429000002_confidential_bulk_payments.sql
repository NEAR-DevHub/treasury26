-- Confidential bulk-payment activations.
-- One row per DAO proposal that signs the header transfer (DAO → sub.bulk-payment.near).
-- The N recipient intents are stored in `confidential_intents` (one row each,
-- keyed by their own NEP-413 hash) so the existing auto-submit relay path
-- can post them to 1Click once the bulk-payment subaccount signs them.
CREATE TABLE IF NOT EXISTS confidential_bulk_payments (
    id SERIAL PRIMARY KEY,
    dao_id TEXT NOT NULL,
    bulk_account_id TEXT NOT NULL,
    -- Hash of the header (DAO → sub) intent. Matches the proposal's v1.signer
    -- payload_v2.Eddsa, so the relay can route this proposal to bulk-handling.
    header_payload_hash TEXT NOT NULL,
    -- N recipient hashes; each maps to a row in `confidential_intents`.
    recipient_payload_hashes TEXT[] NOT NULL,
    -- DAO proposal id — populated by the relay once observed on-chain.
    proposal_id BIGINT,
    -- pending | activating | signing | completed | failed
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dao_id, header_payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_confidential_bulk_payments_status
    ON confidential_bulk_payments (status);
CREATE INDEX IF NOT EXISTS idx_confidential_bulk_payments_dao_proposal
    ON confidential_bulk_payments (dao_id, proposal_id);

-- Recipient intents inside a bulk payment reuse `confidential_intents` rows.
-- Tag them with intent_type = 'bulk_recipient' so the relay/auto-submit path
-- can skip them (the bulk processor handles recipient submits) and the bulk
-- enrichment query can index efficiently.
CREATE INDEX IF NOT EXISTS idx_confidential_intents_intent_type
    ON confidential_intents (intent_type);

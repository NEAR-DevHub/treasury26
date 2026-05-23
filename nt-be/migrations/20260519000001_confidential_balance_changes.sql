-- Gold projection for successful confidential 1Click history rows.

ALTER TABLE confidential_history_cursors
    ADD COLUMN IF NOT EXISTS gold_dirty_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gold_recompute_from TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS confidential_balance_changes (
    id                          BIGSERIAL PRIMARY KEY,

    history_event_id            BIGINT NOT NULL UNIQUE
        REFERENCES confidential_history_events(id) ON DELETE CASCADE,
    intent_id                   INTEGER REFERENCES confidential_intents(id),

    dao_id                      TEXT NOT NULL,
    transaction_type            TEXT NOT NULL
        CHECK (transaction_type IN ('sent', 'exchange', 'deposit')),

    origin_asset                TEXT,
    destination_asset           TEXT NOT NULL,
    amount_in                   NUMERIC,
    amount_out                  NUMERIC NOT NULL,
    amount_in_usd               NUMERIC,
    amount_out_usd              NUMERIC,
    usd_change                  NUMERIC,

    origin_balance_before       NUMERIC,
    origin_balance_after        NUMERIC,
    destination_balance_before  NUMERIC,
    destination_balance_after   NUMERIC,

    recipient                   TEXT NOT NULL,
    refund_to                   TEXT NOT NULL,
    counterparty                TEXT NOT NULL,
    deposit_address             TEXT NOT NULL,
    deposit_memo                TEXT,

    block_height                BIGINT,
    block_time                  TIMESTAMPTZ,
    transaction_hash            TEXT,

    quote_created_at            TIMESTAMPTZ NOT NULL,
    proposal_created_at         TIMESTAMPTZ,
    executed_at                 TIMESTAMPTZ,
    settled_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbc_dao_settled
    ON confidential_balance_changes (dao_id, settled_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_cbc_dao_type_settled
    ON confidential_balance_changes (dao_id, transaction_type, settled_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_cbc_intent_id
    ON confidential_balance_changes (intent_id);

CREATE INDEX IF NOT EXISTS idx_cbc_dao_quote_created
    ON confidential_balance_changes (dao_id, quote_created_at, history_event_id);

CREATE TABLE IF NOT EXISTS confidential_balance_change_projection_errors (
    id                  BIGSERIAL PRIMARY KEY,
    history_event_id    BIGINT NOT NULL UNIQUE
        REFERENCES confidential_history_events(id) ON DELETE CASCADE,
    dao_id              TEXT NOT NULL,
    reason              TEXT NOT NULL,
    raw_payload         JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbcp_errors_dao
    ON confidential_balance_change_projection_errors (dao_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_che_gold_scan
    ON confidential_history_events (account_id, status, created_at_external, id);

ALTER TABLE confidential_intents
    ADD COLUMN IF NOT EXISTS execution_block_height BIGINT,
    ADD COLUMN IF NOT EXISTS execution_block_time TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS execution_transaction_hash TEXT;

COMMENT ON TABLE confidential_balance_changes IS
    'Gold projection of successful confidential_history_events. Balances are ledger-derived from Bronze rows, not RPC verified.';

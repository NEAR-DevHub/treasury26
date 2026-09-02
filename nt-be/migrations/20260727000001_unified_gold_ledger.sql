-- Unified treasury gold ledger: the consumer table history and charts read
-- for both public and confidential treasuries. Rows carry user-owned
-- balances per leg. Public chain truth stays in silver_balance_history with
-- transaction-triggered live RPC verification; confidential rows are replayed
-- from bronze 1Click history and verified against the 1Click balances API at
-- projection time.

CREATE TYPE gold_ledger_source_kind AS ENUM (
    'public_silver_leg',
    'public_balance_ledger',
    'confidential_history_event'
);

CREATE TABLE gold_treasury_ledger_events (
    id BIGSERIAL PRIMARY KEY,
    gold_event_key TEXT NOT NULL UNIQUE,
    dao_id TEXT NOT NULL,
    source_kind gold_ledger_source_kind NOT NULL,
    history_visible BOOLEAN NOT NULL,
    transaction_type public_transaction_type NOT NULL,
    status public_history_event_status NOT NULL DEFAULT 'success',
    event_time TIMESTAMPTZ NOT NULL,
    block_height BIGINT,
    -- Deterministic tie-break inside one block: the ledger intra_block_seq.
    source_order BIGINT NOT NULL DEFAULT 0,

    -- Amounts are unsigned; the sign lives in the leg (in = credit,
    -- out = debit). user_balance_before is derived, never stored.
    token_in TEXT,
    amount_in NUMERIC,
    amount_in_usd NUMERIC,
    token_in_user_balance_after NUMERIC,

    token_out TEXT,
    amount_out NUMERIC,
    amount_out_usd NUMERIC,
    token_out_user_balance_after NUMERIC,

    usd_change NUMERIC,

    recipient TEXT,
    counterparty TEXT,
    transaction_hash TEXT,
    receipt_id TEXT,
    -- Quote metadata is joined from dao_proposals at read time, never
    -- re-stored here.
    proposal_id BIGINT,
    proposal_created_at TIMESTAMPTZ,
    proposal_executed_at TIMESTAMPTZ,
    proposal_execution_block_height BIGINT,
    proposal_execution_transaction_hash TEXT,

    primary_transfer_leg_id BIGINT REFERENCES silver_public_transfer_legs(id) ON DELETE CASCADE,
    counter_transfer_leg_id BIGINT REFERENCES silver_public_transfer_legs(id) ON DELETE CASCADE,
    balance_entry_id BIGINT REFERENCES silver_balance_history(id) ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (dao_id) REFERENCES monitored_accounts (account_id),
    CHECK (token_in IS NOT NULL OR token_out IS NOT NULL)
);

CREATE UNIQUE INDEX idx_gtle_primary_leg_unique
    ON gold_treasury_ledger_events (primary_transfer_leg_id)
    WHERE primary_transfer_leg_id IS NOT NULL;
CREATE UNIQUE INDEX idx_gtle_counter_leg_unique
    ON gold_treasury_ledger_events (counter_transfer_leg_id)
    WHERE counter_transfer_leg_id IS NOT NULL;
CREATE UNIQUE INDEX idx_gtle_balance_entry_unique
    ON gold_treasury_ledger_events (balance_entry_id)
    WHERE balance_entry_id IS NOT NULL;

CREATE INDEX idx_gtle_dao_history
    ON gold_treasury_ledger_events (dao_id, event_time DESC, id DESC)
    WHERE history_visible;
CREATE INDEX idx_gtle_dao_type_history
    ON gold_treasury_ledger_events (dao_id, transaction_type, event_time DESC, id DESC)
    WHERE history_visible;
-- Chart scans walk every successful balance-bearing row in event order.
CREATE INDEX idx_gtle_dao_chart_order
    ON gold_treasury_ledger_events (dao_id, event_time, block_height, source_order, id)
    WHERE status = 'success';
-- Confidential list/export sort key: display time is the proposal execution
-- time when present, else the 1Click event time.
CREATE INDEX idx_gtle_confidential_display_order
    ON gold_treasury_ledger_events (dao_id, (COALESCE(proposal_executed_at, event_time)) DESC, id DESC)
    WHERE source_kind = 'confidential_history_event';

COMMENT ON TABLE gold_treasury_ledger_events IS
    'Unified treasury ledger (public + confidential). history_visible gates the activity feed/exports; charts read every successful balance-bearing row. Balances are user-owned; public chain truth lives in silver_balance_history, confidential rows replay bronze 1Click history. user_balance_before is derived (user_balance_after - amount), never stored. Confidential provenance is carried by gold_event_key = ''confidential:{history_event_id}''.';

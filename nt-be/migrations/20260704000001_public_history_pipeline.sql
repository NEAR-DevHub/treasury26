-- Public history pipeline: NearBlocks bronze ingest, silver transfer legs,
-- DAO proposal lifecycle, and gold projection.
-- Each migration runs exactly once under sqlx, so enum creation is plain
-- CREATE TYPE (no DO/EXCEPTION idempotency wrappers), matching the confidential
-- history migration style.

CREATE TYPE public_history_source AS ENUM (
    'nearblocks_ft',
    'nearblocks_mt',
    'nearblocks_receipt'
);

CREATE TYPE proposal_status AS ENUM (
    'in_progress',
    'approved',
    'rejected',
    'removed',
    'expired',
    'moved',
    'failed'
);

CREATE TYPE public_token_standard AS ENUM ('native', 'nep141', 'nep245');

CREATE TYPE public_transfer_direction AS ENUM ('incoming', 'outgoing', 'internal');

CREATE TYPE public_transfer_leg_kind AS ENUM (
    'transfer',
    'mint',
    'burn',
    'wrap_and_transfer'
);

CREATE TYPE public_transaction_type AS ENUM ('deposit', 'sent', 'exchange');

CREATE TYPE public_history_event_status AS ENUM (
    'pending',
    'success',
    'failed'
);

CREATE TABLE IF NOT EXISTS bronze_public_history_cursors (
    account_id TEXT NOT NULL,
    source public_history_source NOT NULL,
    backward_cursor TEXT,
    backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen_block_height BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, source)
);

CREATE TABLE IF NOT EXISTS public_history_backfill_usage (
    account_id TEXT NOT NULL,
    source public_history_source NOT NULL,
    usage_date DATE NOT NULL,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, source, usage_date)
);

CREATE TABLE IF NOT EXISTS bronze_public_history_events (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    source public_history_source NOT NULL,
    source_event_key TEXT NOT NULL,
    transaction_hash TEXT,
    receipt_id TEXT,
    event_index INTEGER,
    block_height BIGINT NOT NULL,
    block_timestamp NUMERIC NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    affected_account_id TEXT NOT NULL,
    involved_account_id TEXT,
    contract_account_id TEXT,
    token_id TEXT,
    cause TEXT,
    action_kind TEXT,
    method_name TEXT,
    delta_amount_raw NUMERIC,
    decimals INTEGER,
    deposit_raw NUMERIC,
    outcome_status BOOLEAN,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, source_event_key)
);
CREATE INDEX IF NOT EXISTS idx_bphe_account_source_time
    ON bronze_public_history_events (account_id, source, block_time, id);
CREATE INDEX IF NOT EXISTS idx_bphe_account_time
    ON bronze_public_history_events (account_id, block_time, block_height, id);
CREATE INDEX IF NOT EXISTS idx_bphe_tx_receipt
    ON bronze_public_history_events (transaction_hash, receipt_id);

COMMENT ON TABLE bronze_public_history_events IS
    'Raw public-history events from NearBlocks. Bronze preserves provider field names so future indexes and reprocessing can use the original source semantics.';
COMMENT ON COLUMN bronze_public_history_events.account_id IS
    'Monitored treasury/DAO account whose public history page was fetched. This is our pipeline partition key, not necessarily the account that changed in the event.';
COMMENT ON COLUMN bronze_public_history_events.affected_account_id IS
    'NearBlocks account that had the FT/MT balance effect. For receipt rows, this is the receiver account because receipts do not expose a token balance delta.';
COMMENT ON COLUMN bronze_public_history_events.involved_account_id IS
    'NearBlocks counterparty account for token transfers. For receipt rows, this is the predecessor/sender account when available.';
COMMENT ON COLUMN bronze_public_history_events.contract_account_id IS
    'Contract account associated with the event. For FT/MT rows this is the token contract; for receipt rows this is the receipt receiver/contract.';
COMMENT ON COLUMN bronze_public_history_events.raw_payload IS
    'Original NearBlocks item JSON, kept for fields we do not normalize yet and for future reprocessing/debugging.';

CREATE TABLE IF NOT EXISTS dao_proposals (
    id BIGSERIAL PRIMARY KEY,
    dao_id TEXT NOT NULL,
    proposal_id BIGINT NOT NULL,
    status proposal_status NOT NULL DEFAULT 'in_progress',
    proposal_kind JSONB,
    proposal_created_at TIMESTAMPTZ,
    proposal_creation_block_height BIGINT,
    proposal_creation_transaction_hash TEXT,
    proposal_creation_receipt_id TEXT,
    proposal_executed_at TIMESTAMPTZ,
    proposal_execution_block_height BIGINT,
    proposal_execution_transaction_hash TEXT,
    proposal_execution_receipt_id TEXT,
    quote_metadata JSONB,
    quote_deposit_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dao_id, proposal_id)
);
CREATE INDEX IF NOT EXISTS idx_dao_proposals_dao_status
    ON dao_proposals (dao_id, status, proposal_id);
CREATE INDEX IF NOT EXISTS idx_dao_proposals_execution_tx
    ON dao_proposals (dao_id, proposal_execution_transaction_hash)
    WHERE proposal_execution_transaction_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dao_proposals_quote_deposit_address
    ON dao_proposals (dao_id, quote_deposit_address)
    WHERE quote_deposit_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS silver_public_history_cursors (
    account_id TEXT PRIMARY KEY,
    silver_dirty_since TIMESTAMPTZ,
    silver_recompute_from TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sphc_dirty
    ON silver_public_history_cursors (silver_dirty_since)
    WHERE silver_dirty_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS silver_public_transfer_legs (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    leg_key TEXT NOT NULL UNIQUE,
    source_event_id BIGINT NOT NULL REFERENCES bronze_public_history_events(id) ON DELETE CASCADE,
    source public_history_source NOT NULL,
    proposal_ref BIGINT REFERENCES dao_proposals(id),
    proposal_id BIGINT,
    transaction_hash TEXT,
    receipt_id TEXT,
    block_height BIGINT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    token_standard public_token_standard NOT NULL,
    token_id TEXT NOT NULL,
    direction public_transfer_direction NOT NULL,
    counterparty TEXT,
    amount_raw NUMERIC NOT NULL,
    amount NUMERIC NOT NULL,
    decimals INTEGER NOT NULL,
    leg_kind public_transfer_leg_kind NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_sptl_account_time
    ON silver_public_transfer_legs (account_id, block_time, block_height, id);
CREATE INDEX IF NOT EXISTS idx_sptl_tx_receipt
    ON silver_public_transfer_legs (transaction_hash, receipt_id);
CREATE INDEX IF NOT EXISTS idx_sptl_proposal_ref
    ON silver_public_transfer_legs (proposal_ref)
    WHERE proposal_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS silver_public_history_projection_errors (
    id BIGSERIAL PRIMARY KEY,
    source_event_id BIGINT NOT NULL UNIQUE REFERENCES bronze_public_history_events(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sphpe_account
    ON silver_public_history_projection_errors (account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gold_public_history_cursors (
    account_id TEXT PRIMARY KEY,
    gold_dirty_since TIMESTAMPTZ,
    gold_recompute_from TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gphc_dirty
    ON gold_public_history_cursors (gold_dirty_since)
    WHERE gold_dirty_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS gold_public_history_events (
    id BIGSERIAL PRIMARY KEY,
    gold_event_key TEXT NOT NULL UNIQUE,
    primary_transfer_leg_id BIGINT NOT NULL UNIQUE REFERENCES silver_public_transfer_legs(id) ON DELETE CASCADE,
    counter_transfer_leg_id BIGINT REFERENCES silver_public_transfer_legs(id) ON DELETE CASCADE,
    proposal_ref BIGINT REFERENCES dao_proposals(id),
    dao_id TEXT NOT NULL,
    transaction_type public_transaction_type NOT NULL,
    token_in TEXT,
    token_out TEXT,
    amount_in NUMERIC,
    amount_out NUMERIC,
    amount_in_usd NUMERIC,
    amount_out_usd NUMERIC,
    usd_change NUMERIC,
    token_in_balance_before NUMERIC,
    token_in_balance_after NUMERIC,
    token_out_balance_before NUMERIC,
    token_out_balance_after NUMERIC,
    recipient TEXT,
    counterparty TEXT,
    refund_to TEXT,
    transaction_hash TEXT,
    receipt_id TEXT,
    block_height BIGINT,
    event_time TIMESTAMPTZ NOT NULL,
    proposal_id BIGINT,
    proposal_status proposal_status,
    proposal_created_at TIMESTAMPTZ,
    proposal_executed_at TIMESTAMPTZ,
    proposal_execution_block_height BIGINT,
    proposal_execution_transaction_hash TEXT,
    status public_history_event_status NOT NULL DEFAULT 'success',
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gphe_counter_leg_unique
    ON gold_public_history_events (counter_transfer_leg_id)
    WHERE counter_transfer_leg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gphe_dao_event_time
    ON gold_public_history_events (dao_id, event_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gphe_dao_type_event_time
    ON gold_public_history_events (dao_id, transaction_type, event_time DESC, id DESC);

CREATE TABLE IF NOT EXISTS gold_public_history_projection_errors (
    id BIGSERIAL PRIMARY KEY,
    transfer_leg_id BIGINT NOT NULL UNIQUE REFERENCES silver_public_transfer_legs(id) ON DELETE CASCADE,
    dao_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gphpe_dao
    ON gold_public_history_projection_errors (dao_id, updated_at DESC);

ALTER TABLE bronze_public_history_cursors
    ADD COLUMN IF NOT EXISTS latest_refresh_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS latest_refresh_cutoff_block_height BIGINT;

COMMENT ON COLUMN bronze_public_history_cursors.latest_refresh_at IS
    'Completion time of the latest successful full latest-page drain; backfill progress does not update it.';
COMMENT ON COLUMN bronze_public_history_cursors.latest_refresh_cutoff_block_height IS
    'NearBlocks indexed head verified immediately before the latest source drain; used as the verification block watermark.';

-- Balance-complete public ledger projected purely from bronze. Unlike the
-- display-oriented silver transfer legs, this table carries EVERY
-- balance-affecting movement: receipt-attached function-call deposits (wraps,
-- staking), sponsor/system top-ups, and FT/MT deltas. Gold stamps its
-- balance_before/after columns from here; charts read gold.
CREATE TYPE public_balance_entry_kind AS ENUM (
    'movement',
    'reconciliation',
    'observation'
);

CREATE TABLE silver_balance_history (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    token_standard public_token_standard NOT NULL,
    entry_kind public_balance_entry_kind NOT NULL DEFAULT 'movement',
    -- FT/MT: '{source}:{source_event_key}' (equals the silver leg_key);
    -- native: 'native:{account_id}:{receipt_id}';
    -- reconciliation: 'rebase:{account_id}:{asset}:{block_height}';
    -- observation: 'observation:{account_id}:{asset}:{block_height}'.
    entry_key TEXT NOT NULL UNIQUE,
    source public_history_source,
    source_event_id BIGINT REFERENCES bronze_public_history_events(id) ON DELETE CASCADE,
    receipt_id TEXT,
    transaction_hash TEXT,
    counterparty TEXT,
    block_height BIGINT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    intra_block_seq INTEGER NOT NULL,
    delta_raw NUMERIC NOT NULL,
    delta NUMERIC NOT NULL,
    decimals INTEGER NOT NULL,
    balance_before NUMERIC NOT NULL,
    -- Deliberately no >= 0 CHECK: a negative running balance is a
    -- verification failure to surface, not a projection abort.
    balance_after NUMERIC NOT NULL,
    -- Economic ownership: sponsor/system funding, treasury-creation deposits
    -- and reconciliation rebases move the chain balance but not the user's.
    affects_user_balance BOOLEAN NOT NULL,
    user_balance_after NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((entry_kind IN ('reconciliation', 'observation')) = (source IS NULL)),
    UNIQUE (account_id, asset, block_height, intra_block_seq)
);
CREATE INDEX idx_sbh_account_asset_order
    ON silver_balance_history (account_id, asset, block_time, block_height, intra_block_seq);
CREATE INDEX idx_sbh_account_receipt
    ON silver_balance_history (account_id, receipt_id)
    WHERE receipt_id IS NOT NULL;

COMMENT ON TABLE silver_balance_history IS
    'Balance-complete running ledger per (account, asset), projected purely from bronze_public_history_events. Reconciliation entries are verifier-written rebases to the observed on-chain balance (bounded by tolerance).';

-- On-chain verification state. RPC is a verification authority, not a balance
-- source: the ledger is derived from bronze alone and checked against chain.
CREATE TYPE public_balance_verification_status AS ENUM (
    'unverified',
    'passed',
    'failed'
);

CREATE TABLE public_balance_verification_cursors (
    account_id TEXT PRIMARY KEY,
    status public_balance_verification_status NOT NULL DEFAULT 'unverified',
    verified_at TIMESTAMPTZ,
    verified_block_height BIGINT,
    last_head_check_at TIMESTAMPTZ,
    last_head_check_block_height BIGINT,
    last_head_check_passed BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public_balance_verification_results (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    check_kind TEXT NOT NULL,
    block_height BIGINT NOT NULL,
    ledger_balance NUMERIC NOT NULL,
    chain_balance NUMERIC NOT NULL,
    drift NUMERIC NOT NULL,
    min_running_balance NUMERIC,
    passed BOOLEAN NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pbvr_account
    ON public_balance_verification_results (account_id, checked_at DESC);

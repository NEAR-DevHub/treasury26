-- Staking pool observations: the one balance source RPC is authoritative
-- for, because staking rewards accrue every epoch with no transaction to
-- ingest. Each reading is stored as provenance (the 'staking:{pool}' ledger
-- series is rebuilt from here without re-hitting archival RPC) and applied
-- to silver_balance_history as a hidden 'observation' entry, which flows
-- into the unified ledger and charts.

CREATE TABLE bronze_staking_observations (
    id BIGSERIAL PRIMARY KEY,
    -- 'staking:{account_id}:{pool}:{block_height}'
    observation_key TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    pool_account_id TEXT NOT NULL,
    block_height BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    balance NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_bso_account_pool_time
    ON bronze_staking_observations (account_id, pool_account_id, observed_at DESC);

-- Worker state: pools discovered from bronze function-call receipts,
-- validated against the staking interface before any reading is recorded.
-- Chart readiness gates on backfill_done so a partially backfilled staked
-- series is never served.
-- Boundary block resolution interpolates between the nearest bronze rows on
-- either side of a chart boundary, across ALL accounts; without global
-- time/height indexes each probe is a full-table scan.
CREATE INDEX idx_bphe_block_time ON bronze_public_history_events (block_time);
CREATE INDEX idx_bphe_block_height ON bronze_public_history_events (block_height);

CREATE TABLE staking_observation_cursors (
    account_id TEXT NOT NULL,
    pool_account_id TEXT NOT NULL,
    validated BOOLEAN NOT NULL DEFAULT FALSE,
    backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
    last_observed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, pool_account_id)
);
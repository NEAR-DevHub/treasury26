ALTER TABLE bronze_public_history_cursors
    ADD COLUMN latest_refresh_at TIMESTAMPTZ,
    ADD COLUMN latest_refresh_cutoff_block_height BIGINT;

COMMENT ON COLUMN bronze_public_history_cursors.latest_refresh_at IS
    'Completion time of the latest successful full latest-page drain; backfill progress does not update it.';
COMMENT ON COLUMN bronze_public_history_cursors.latest_refresh_cutoff_block_height IS
    'NearBlocks indexed head verified immediately before the latest source drain; compared with a lag-adjusted snapshot anchor.';

CREATE TABLE public_balance_snapshot (
    dao_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    block_height BIGINT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    balance NUMERIC NOT NULL CHECK (balance >= 0),
    usd_value NUMERIC CHECK (usd_value IS NULL OR usd_value >= 0),
    PRIMARY KEY (dao_id, asset, block_height)
);

CREATE INDEX public_balance_snapshot_chart_idx
    ON public_balance_snapshot (dao_id, asset, block_time DESC);

CREATE TABLE public_balance_snapshot_cursors (
    account_id TEXT PRIMARY KEY,
    snapshot_dirty_generation BIGINT NOT NULL DEFAULT 0,
    snapshot_applied_generation BIGINT NOT NULL DEFAULT 0,
    snapshot_recompute_from TIMESTAMPTZ,
    snapshot_applied_at TIMESTAMPTZ,
    snapshot_seeded_at TIMESTAMPTZ,
    CHECK (snapshot_applied_generation <= snapshot_dirty_generation)
);

COMMENT ON COLUMN public_balance_snapshot_cursors.snapshot_seeded_at IS
    'Set once after the one-time historical seed from trusted legacy balance history; NULL means the next refresh must seed first.';

-- Runtime cursor bootstrap, invalidation and historical reprojection are
-- implemented in the typed Rust repositories. This migration is DDL-only.

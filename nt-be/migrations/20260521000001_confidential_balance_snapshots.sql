-- Authoritative balance snapshots for confidential DAOs, sourced from the 1Click
-- /v0/account/balances endpoint. Independent of confidential_history_events: charts
-- and balance values come from here so missing history rows do not corrupt them.

CREATE TABLE IF NOT EXISTS confidential_balance_snapshots (
    dao_id        TEXT        NOT NULL,
    asset         TEXT        NOT NULL,
    snapshot_at   TIMESTAMPTZ NOT NULL,
    raw_balance   NUMERIC     NOT NULL,
    balance       NUMERIC     NOT NULL,
    PRIMARY KEY (dao_id, asset, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_cbs_dao_snapshot_at
    ON confidential_balance_snapshots (dao_id, snapshot_at DESC);

COMMENT ON TABLE confidential_balance_snapshots IS
    'Per-asset balance snapshots from 1Click /v0/account/balances. Zero rows act as tombstones for assets that disappeared from /balances since the prior snapshot.';
COMMENT ON COLUMN confidential_balance_snapshots.asset IS
    'Defuse-format token id as returned by /v0/account/balances (e.g. nep141:wrap.near). Resolve to unified asset id at chart read time.';
COMMENT ON COLUMN confidential_balance_snapshots.raw_balance IS
    'Integer base-units value from /v0/account/balances.available, stored as NUMERIC.';
COMMENT ON COLUMN confidential_balance_snapshots.balance IS
    'Decimal-adjusted balance (raw_balance / 10^decimals).';

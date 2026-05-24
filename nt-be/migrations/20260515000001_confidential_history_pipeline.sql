-- Confidential 1Click history bronze + gold projection tables.

CREATE TABLE IF NOT EXISTS confidential_history_events (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(128) NOT NULL,
    created_at_external TIMESTAMPTZ NOT NULL,
    deposit_address TEXT NOT NULL,
    deposit_memo TEXT,
    status TEXT NOT NULL,
    deposit_type TEXT NOT NULL,
    recipient_type TEXT,
    recipient TEXT,
    origin_asset TEXT,
    destination_asset TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_che
    ON confidential_history_events (account_id, created_at_external, deposit_address);
CREATE INDEX IF NOT EXISTS idx_che_in_flight
    ON confidential_history_events (account_id, status) WHERE status IN ('SUCCESS');
CREATE INDEX IF NOT EXISTS idx_che_gold_scan
    ON confidential_history_events (account_id, status, created_at_external, id);


CREATE TABLE IF NOT EXISTS confidential_history_cursors (
    account_id VARCHAR(128) PRIMARY KEY,
    forward_cursor TEXT,
    backward_cursor TEXT,
    backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
    next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_polled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    gold_dirty_since TIMESTAMPTZ,
    gold_recompute_from TIMESTAMPTZ,
    last_confidential_activity_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chc_next_poll_at
    ON confidential_history_cursors (next_poll_at);


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
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cbc_dao_created
    ON confidential_balance_changes (dao_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cbc_dao_type_created
    ON confidential_balance_changes (dao_id, transaction_type, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cbc_intent_id
    ON confidential_balance_changes (intent_id);
CREATE INDEX IF NOT EXISTS idx_cbc_dao_quote_created
    ON confidential_balance_changes (dao_id, quote_created_at, history_event_id);

COMMENT ON TABLE confidential_balance_changes IS
    'Gold projection of successful confidential_history_events. Balances are ledger-derived from Bronze rows, not RPC verified.';


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

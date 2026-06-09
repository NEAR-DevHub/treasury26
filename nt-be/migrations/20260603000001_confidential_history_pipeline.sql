-- Confidential 1Click history: bronze ingest + gold projection tables.

CREATE TYPE confidential_transaction_type AS ENUM ('sent', 'exchange', 'deposit');

CREATE TABLE IF NOT EXISTS bronze_confidential_history_events (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_bche_unique_event
    ON bronze_confidential_history_events (account_id, created_at_external, deposit_address);
CREATE INDEX IF NOT EXISTS idx_bche_gold_scan
    ON bronze_confidential_history_events (account_id, status, created_at_external, id);


CREATE TABLE IF NOT EXISTS bronze_confidential_history_cursors (
    account_id VARCHAR(128) PRIMARY KEY,
    forward_cursor TEXT,
    backward_cursor TEXT,
    backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
    next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_polled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_confidential_activity_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bchc_next_poll_at
    ON bronze_confidential_history_cursors (next_poll_at);


CREATE TABLE IF NOT EXISTS gold_confidential_history_cursors (
    account_id VARCHAR(128) PRIMARY KEY,
    gold_dirty_since TIMESTAMPTZ,
    gold_recompute_from TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gchc_dirty
    ON gold_confidential_history_cursors (gold_dirty_since)
    WHERE gold_dirty_since IS NOT NULL;


CREATE TABLE IF NOT EXISTS gold_confidential_history_events (
    id                          BIGSERIAL PRIMARY KEY,
    history_event_id            BIGINT NOT NULL UNIQUE
        REFERENCES bronze_confidential_history_events(id) ON DELETE CASCADE,
    intent_id                   INTEGER REFERENCES confidential_intents(id),
    dao_id                      TEXT NOT NULL,
    transaction_type            confidential_transaction_type NOT NULL,
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
    proposal_execution_block_height BIGINT,
    proposal_executed_at        TIMESTAMPTZ,
    proposal_execution_transaction_hash TEXT,
    quote_created_at            TIMESTAMPTZ NOT NULL,
    proposal_created_at         TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gche_intent_id
    ON gold_confidential_history_events (intent_id);
CREATE INDEX IF NOT EXISTS idx_gche_dao_quote_created
    ON gold_confidential_history_events (dao_id, quote_created_at);

-- Read paths sort by business event time, not projection insert time. `id` is
-- only a stable tie-breaker for rows with identical event timestamps.
CREATE INDEX IF NOT EXISTS idx_gche_dao_event_time
    ON gold_confidential_history_events (
        dao_id,
        (COALESCE(proposal_executed_at, quote_created_at)) DESC,
        id DESC
    );
CREATE INDEX IF NOT EXISTS idx_gche_dao_type_event_time
    ON gold_confidential_history_events (
        dao_id,
        transaction_type,
        (COALESCE(proposal_executed_at, quote_created_at)) DESC,
        id DESC
    );

COMMENT ON TABLE gold_confidential_history_events IS
    'Gold projection of successful bronze_confidential_history_events. Balances are ledger-derived from bronze rows, not RPC verified.';


CREATE TABLE IF NOT EXISTS gold_confidential_history_projection_errors (
    id                  BIGSERIAL PRIMARY KEY,
    history_event_id    BIGINT NOT NULL UNIQUE
        REFERENCES bronze_confidential_history_events(id) ON DELETE CASCADE,
    dao_id              TEXT NOT NULL,
    reason              TEXT NOT NULL,
    raw_payload         JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gchpe_errors_dao
    ON gold_confidential_history_projection_errors (dao_id, updated_at DESC);


CREATE TABLE IF NOT EXISTS gold_confidential_balance_snapshots (
    dao_id        TEXT        NOT NULL,
    asset         TEXT        NOT NULL,
    snapshot_at   TIMESTAMPTZ NOT NULL,
    raw_balance   NUMERIC     NOT NULL,
    balance       NUMERIC     NOT NULL,
    PRIMARY KEY (dao_id, asset, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_gcbs_dao_snapshot_at
    ON gold_confidential_balance_snapshots (dao_id, snapshot_at DESC);

COMMENT ON TABLE gold_confidential_balance_snapshots IS
    'Per-asset balance snapshots from 1Click /v0/account/balances. Zero rows act as tombstones for assets that disappeared from /balances since the prior snapshot.';
COMMENT ON COLUMN gold_confidential_balance_snapshots.asset IS
    'Defuse-format token id as returned by /v0/account/balances (e.g. nep141:wrap.near). Resolve to unified asset id at chart read time.';
COMMENT ON COLUMN gold_confidential_balance_snapshots.raw_balance IS
    'Integer base-units value from /v0/account/balances.available, stored as NUMERIC.';
COMMENT ON COLUMN gold_confidential_balance_snapshots.balance IS
    'Decimal-adjusted balance (raw_balance / 10^decimals).';
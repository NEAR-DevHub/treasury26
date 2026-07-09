-- Centralized token registry + minute-level USD price time series.
--
-- `tokens` is the canonical registry keyed by defuse asset id
-- (e.g. 'nep141:wrap.near'), refreshed every minute from the chaindefuser
-- tokens API. It carries the latest price so hot-path "current price"
-- lookups never touch the time series.
--
-- `token_prices` stores one row per token per 5-minute sample, partitioned by
-- month so multi-year history stays manageable without creating hundreds of
-- tiny child tables. Rows are only written when the upstream price actually
-- advanced since the previous persisted sample. Point-in-time reads resolve to
-- the nearest earlier sample. The time series is keyed on `tokens.id` (small
-- int surrogate) rather than the long TEXT asset id to keep heap and PK index
-- compact over multi-year retention.

CREATE TABLE tokens (
    -- Surrogate key referenced by token_prices; token_id stays the natural key
    id                INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
    -- Defuse asset id, e.g. 'nep141:wrap.near'
    token_id          TEXT PRIMARY KEY,
    symbol            TEXT NOT NULL,
    decimals          SMALLINT NOT NULL,
    blockchain        TEXT NOT NULL,
    -- On-chain contract address; NULL for assets without one (e.g. native omft)
    contract_address  TEXT,
    coingecko_id      TEXT,
    -- Icon, tags, and future upstream fields land here without schema changes
    metadata          JSONB NOT NULL DEFAULT '{}',
    -- Latest known USD price; NULL when upstream has no (or a zero) price
    price_usd         NUMERIC,
    price_updated_at  TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tokens_contract_address
    ON tokens (LOWER(contract_address))
    WHERE contract_address IS NOT NULL;

CREATE TABLE token_prices (
    token_ref  INTEGER NOT NULL REFERENCES tokens (id),
    minute_at  TIMESTAMPTZ NOT NULL,
    price_usd  NUMERIC NOT NULL,
    PRIMARY KEY (token_ref, minute_at)
) PARTITION BY RANGE (minute_at);

-- The ingest worker creates monthly partitions ahead of time
-- (token_prices_pYYYYMM). Seed the first partition here so inserts work even
-- before the worker's first tick.
CREATE TABLE IF NOT EXISTS token_prices_p202607
    PARTITION OF token_prices
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

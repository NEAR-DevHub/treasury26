-- Create historical_prices table for caching historical USD price data
-- This table supports multiple price sources (CoinGecko, Pyth, etc.)

CREATE TABLE historical_prices (
    id BIGSERIAL PRIMARY KEY,

    -- Asset identification (canonical identifier like "bitcoin", "near", "usd-coin")
    asset_id VARCHAR(64) NOT NULL,

    -- Price data
    price_date DATE NOT NULL,
    price_usd NUMERIC NOT NULL,

    -- Price source (e.g., "coingecko", "pyth", "manual")
    source VARCHAR(32) NOT NULL,

    -- Metadata
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints: one price per asset per date per source
    CONSTRAINT unique_asset_date_source UNIQUE(asset_id, price_date, source)
);

-- Index for efficient lookups by asset and date
CREATE INDEX idx_historical_prices_lookup ON historical_prices(asset_id, price_date);

-- Index for cleanup/maintenance queries by source
CREATE INDEX idx_historical_prices_source ON historical_prices(source);

COMMENT ON TABLE historical_prices IS 'Cached historical USD prices from various price sources';
COMMENT ON COLUMN historical_prices.asset_id IS 'Canonical asset identifier (e.g., bitcoin, near, ethereum, usd-coin)';
COMMENT ON COLUMN historical_prices.price_date IS 'Date of the price snapshot (UTC)';
COMMENT ON COLUMN historical_prices.price_usd IS 'USD price at the given date';
COMMENT ON COLUMN historical_prices.source IS 'Price data source (coingecko, pyth, manual, etc.)';

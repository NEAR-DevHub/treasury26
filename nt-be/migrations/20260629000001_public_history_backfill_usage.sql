CREATE TABLE IF NOT EXISTS public_history_backfill_usage (
    account_id TEXT NOT NULL,
    source public_history_source NOT NULL,
    usage_date DATE NOT NULL,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, source, usage_date)
);

ALTER TABLE gold_confidential_balance_snapshots
    ADD COLUMN IF NOT EXISTS price_usd NUMERIC NULL,
    ADD COLUMN IF NOT EXISTS value_usd NUMERIC NULL;

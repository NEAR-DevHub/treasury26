-- Per-deposit amount corrections for confidential gold history.
--
-- The 1Click history API reports the quote nominal (~0.001) as the deposit
-- amount, not the real deposited quantity. This table holds the corrected
-- quantity per bronze history event; the gold projector applies it when
-- present (gated by CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS). Sources:
--   live_fetch      -- forward: live 1Click balance diff at ingest time
--   balance_changes -- backfill: poller-recorded deposit legs
-- Stores both the raw (base-units) and decimal-adjusted quantity, mirroring
-- gold_confidential_balance_snapshots (raw_balance / balance).

CREATE TYPE confidential_deposit_correction_source AS ENUM ('live_fetch', 'balance_changes');

CREATE TABLE IF NOT EXISTS confidential_deposit_amount_corrections (
    history_event_id     BIGINT PRIMARY KEY
        REFERENCES bronze_confidential_history_events(id) ON DELETE CASCADE,
    corrected_raw_amount NUMERIC NOT NULL,
    corrected_net_amount NUMERIC NOT NULL,
    source               confidential_deposit_correction_source NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE confidential_deposit_amount_corrections IS
    'Real deposited quantity per confidential gold deposit, overriding the ~0.001 quote nominal from the 1Click history API. Applied by the gold projector when CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS is enabled.';
COMMENT ON COLUMN confidential_deposit_amount_corrections.corrected_raw_amount IS
    'Real deposited quantity in base units (integer-valued).';
COMMENT ON COLUMN confidential_deposit_amount_corrections.corrected_net_amount IS
    'Real deposited quantity, decimal-adjusted (corrected_raw_amount / 10^decimals).';

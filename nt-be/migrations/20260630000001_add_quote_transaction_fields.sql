-- Add deposit_tx_hash to gold confidential history.
-- Extracted from quoteTransactions[0].txHash in the bronze raw_payload.
-- The deposit sender (quoteTransactions[0].sender) is stored directly in
-- `counterparty` during gold projection, so no separate column is needed.
-- Existing rows are backfilled by the reconciliation job re-projecting bronze.

ALTER TABLE gold_confidential_history_events
    ADD COLUMN IF NOT EXISTS deposit_tx_hash TEXT;

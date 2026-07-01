-- Add extracted quoteTransactions fields to gold confidential history.
-- quoteTransactions[0].sender is the on-chain deposit sender address.
-- quoteTransactions[0].txHash is the on-chain deposit transaction hash.
-- Both fields are nullable because older history rows and non-deposit types may lack them.
-- Bronze already stores the full raw_payload JSONB; gold projector extracts these during
-- bronze→gold projection, so existing rows are backfilled by the reconciliation job.

ALTER TABLE gold_confidential_history_events
ADD COLUMN IF NOT EXISTS sender_address TEXT,
ADD COLUMN IF NOT EXISTS deposit_tx_hash TEXT;
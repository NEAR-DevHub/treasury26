-- Add export and batch payment credits to monitored_accounts
-- Credits are granted when a treasury is first registered
ALTER TABLE
    monitored_accounts
ADD
    COLUMN export_credits INTEGER NOT NULL DEFAULT 10,
ADD
    COLUMN batch_payment_credits INTEGER NOT NULL DEFAULT 5;

-- Grant credits to existing accounts (retroactive)
UPDATE
    monitored_accounts
SET
    export_credits = 10,
    batch_payment_credits = 5
WHERE
    export_credits = 0
    OR batch_payment_credits = 0;

COMMENT ON COLUMN monitored_accounts.export_credits IS 'Credits for CSV exports. 10 granted on first registration.';

COMMENT ON COLUMN monitored_accounts.batch_payment_credits IS 'Credits for batch payments. 120 granted on first registration.';

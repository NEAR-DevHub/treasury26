-- Bulk-payment subaccount JWT storage.
-- Mirrors the DAO-side `confidential_*` columns but for the per-DAO
-- `<dao>.bulk-payment.near` subaccount, which authenticates with the 1Click
-- API using DAO-signed NEP-413 (DAO's MPC pubkey is registered under the sub
-- on intents.near during the subaccount's `bootstrap()` call).
ALTER TABLE
    monitored_accounts
ADD
    COLUMN IF NOT EXISTS bulk_payment_access_token TEXT,
ADD
    COLUMN IF NOT EXISTS bulk_payment_refresh_token TEXT,
ADD
    COLUMN IF NOT EXISTS bulk_payment_token_expires_at TIMESTAMPTZ;

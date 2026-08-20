-- Encrypted credential bundles (AES-256-GCM envelopes) for the 1Click
-- confidential-intents JWTs. Replaces the four plaintext token columns on
-- monitored_accounts; those stay in place until the encrypted rollout
-- completes and are dropped in a later migration.
ALTER TABLE monitored_accounts
ADD COLUMN IF NOT EXISTS confidential_credentials_enc BYTEA,
ADD COLUMN IF NOT EXISTS bulk_payment_credentials_enc BYTEA;

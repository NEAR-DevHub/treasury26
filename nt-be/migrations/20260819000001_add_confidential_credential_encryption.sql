-- Encrypted credential bundles (AES-256-GCM envelopes) for the 1Click
-- confidential-intents JWTs. Replaces the four plaintext token columns on
-- monitored_accounts; those stay in place until the encrypted rollout
-- completes and are dropped in a later migration.
ALTER TABLE monitored_accounts
ADD COLUMN IF NOT EXISTS confidential_credentials_enc BYTEA,
ADD COLUMN IF NOT EXISTS bulk_payment_credentials_enc BYTEA;

-- Singleton key-generation fence for the credential keyring. One PostgreSQL
-- schema = one credential domain = one keyring: every fence-aware pod
-- registers its keyring here at boot, every encrypted write takes a shared
-- lock on this row and refuses to write under a stale generation, and a key
-- rotation counts as done only once rotation_status = 'complete' has been
-- persisted by a post-reconcile verification sweep — never from logs alone.
-- Only a SHA-256 fingerprint of the active key is stored, never key material.
CREATE TABLE IF NOT EXISTS confidential_credential_key_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    generation BIGINT NOT NULL CHECK (generation > 0),
    active_key_id TEXT NOT NULL,
    active_key_fingerprint TEXT NOT NULL,
    rotation_status TEXT NOT NULL CHECK (rotation_status IN ('pending', 'complete')),
    promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at TIMESTAMPTZ
);

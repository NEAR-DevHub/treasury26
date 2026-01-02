-- Increase VARCHAR columns in balance_changes table to accommodate long identifiers
-- This includes intents tokens, long account IDs, and other NEAR identifiers
-- Example: intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
-- is 77 characters long, exceeding the original 64 character limit

ALTER TABLE balance_changes
    ALTER COLUMN account_id TYPE VARCHAR(128),
    ALTER COLUMN signer_id TYPE VARCHAR(128),
    ALTER COLUMN receiver_id TYPE VARCHAR(128),
    ALTER COLUMN counterparty TYPE VARCHAR(128);

COMMENT ON COLUMN balance_changes.account_id IS 'Account identifier - supports regular accounts and long NEAR identifiers (up to 128 characters)';
COMMENT ON COLUMN balance_changes.signer_id IS 'Transaction signer account ID (up to 128 characters)';
COMMENT ON COLUMN balance_changes.receiver_id IS 'Transaction receiver account ID (up to 128 characters)';
COMMENT ON COLUMN balance_changes.counterparty IS 'Counterparty identifier - supports accounts, FT contracts, and intents tokens (up to 128 characters)';

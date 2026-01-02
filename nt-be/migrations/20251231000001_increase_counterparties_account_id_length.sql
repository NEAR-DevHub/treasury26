-- Increase counterparties.account_id column length to accommodate long intents tokens
-- Intents tokens are stored in counterparties table for metadata caching
-- Example: intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
-- is 77 characters long, exceeding the original 64 character limit

ALTER TABLE counterparties
    ALTER COLUMN account_id TYPE VARCHAR(128);

COMMENT ON COLUMN counterparties.account_id IS 'Account identifier - supports regular accounts, FT contracts, and intents.near multi-tokens (up to 128 characters)';

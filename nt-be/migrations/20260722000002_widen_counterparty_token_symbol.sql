-- Spam/meme FT contracts use on-chain symbols far longer than 16 characters
-- (some embed URLs). The VARCHAR(16) cap made `upsert_ft_counterparty` fail
-- for any such token, which aborted every public balance snapshot refresh
-- whose asset set included one. VARCHAR -> TEXT is a metadata-only change.
ALTER TABLE counterparties ALTER COLUMN token_symbol TYPE TEXT;

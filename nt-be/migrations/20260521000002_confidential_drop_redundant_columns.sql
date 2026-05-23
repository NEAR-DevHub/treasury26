-- Drop redundant columns added by 20260519000001:
--   * confidential_intents.execution_block_time was always populated from the
--     same goldsky block_time parameter as executed_at and never diverged.
--   * confidential_balance_changes.settled_at was never written explicitly
--     anywhere in the code; it always equalled created_at (both default NOW()).

DROP INDEX IF EXISTS idx_cbc_dao_settled;
DROP INDEX IF EXISTS idx_cbc_dao_type_settled;

ALTER TABLE confidential_balance_changes
    DROP COLUMN IF EXISTS settled_at;

CREATE INDEX IF NOT EXISTS idx_cbc_dao_created
    ON confidential_balance_changes (dao_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_cbc_dao_type_created
    ON confidential_balance_changes (dao_id, transaction_type, created_at DESC, id DESC);

ALTER TABLE confidential_intents
    DROP COLUMN IF EXISTS execution_block_time;

-- Public medallion reads may start only after a successful gold projection.
-- Bronze backfill completion alone is not sufficient because silver and gold
-- are projected asynchronously after the final bronze cursor is committed.
ALTER TABLE gold_public_history_cursors
    ADD COLUMN IF NOT EXISTS projection_ready_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS projection_ready_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS projection_validation_pending BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS gold_force_full_recompute BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN gold_public_history_cursors.projection_ready_at IS
    'Set by a successful gold projection after bronze backfill and silver projection are complete; cleared whenever derived public history becomes dirty.';
COMMENT ON COLUMN gold_public_history_cursors.projection_ready_version IS
    'Readiness schema epoch published by the projector; readers require the current application epoch.';
COMMENT ON COLUMN gold_public_history_cursors.projection_validation_pending IS
    'Durable handoff flag consumed by current projectors, including after an older binary clears the legacy dirty timestamp.';
COMMENT ON COLUMN gold_public_history_cursors.gold_force_full_recompute IS
    'Preserves a required full rebuild across later incremental dirty marks until a current projector succeeds.';

-- Database-level invalidation protects rolling deploys. Older binaries do not
-- know about the readiness columns, but their ordinary bronze/silver/gold
-- cursor writes still clear the marker and leave a durable validation request
-- for a current binary.
CREATE OR REPLACE FUNCTION invalidate_public_gold_readiness_on_gold_dirty()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.gold_dirty_since IS NOT NULL THEN
        NEW.projection_ready_at := NULL;
        NEW.projection_ready_version := 0;
        NEW.projection_validation_pending := true;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invalidate_public_gold_readiness_on_gold_dirty
    ON gold_public_history_cursors;
CREATE TRIGGER trg_invalidate_public_gold_readiness_on_gold_dirty
BEFORE INSERT OR UPDATE ON gold_public_history_cursors
FOR EACH ROW
EXECUTE FUNCTION invalidate_public_gold_readiness_on_gold_dirty();

CREATE OR REPLACE FUNCTION invalidate_public_gold_readiness_on_silver_dirty()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.silver_dirty_since IS NOT NULL THEN
        INSERT INTO gold_public_history_cursors (
            account_id,
            projection_ready_at,
            projection_ready_version,
            projection_validation_pending,
            updated_at
        )
        VALUES (NEW.account_id, NULL, 0, true, NOW())
        ON CONFLICT (account_id) DO UPDATE SET
            projection_ready_at = NULL,
            projection_ready_version = 0,
            projection_validation_pending = true,
            updated_at = NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invalidate_public_gold_readiness_on_silver_dirty
    ON silver_public_history_cursors;
CREATE TRIGGER trg_invalidate_public_gold_readiness_on_silver_dirty
AFTER INSERT OR UPDATE ON silver_public_history_cursors
FOR EACH ROW
EXECUTE FUNCTION invalidate_public_gold_readiness_on_silver_dirty();

CREATE OR REPLACE FUNCTION invalidate_public_gold_readiness_on_backfill_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO gold_public_history_cursors (
        account_id,
        projection_ready_at,
        projection_ready_version,
        projection_validation_pending,
        gold_force_full_recompute,
        updated_at
    )
    VALUES (NEW.account_id, NULL, 0, true, true, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        projection_ready_at = NULL,
        projection_ready_version = 0,
        projection_validation_pending = true,
        gold_force_full_recompute = true,
        updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invalidate_public_gold_readiness_on_backfill_insert
    ON bronze_public_history_cursors;
CREATE TRIGGER trg_invalidate_public_gold_readiness_on_backfill_insert
AFTER INSERT ON bronze_public_history_cursors
FOR EACH ROW
EXECUTE FUNCTION invalidate_public_gold_readiness_on_backfill_progress();

DROP TRIGGER IF EXISTS trg_invalidate_public_gold_readiness_on_backfill_update
    ON bronze_public_history_cursors;
CREATE TRIGGER trg_invalidate_public_gold_readiness_on_backfill_update
AFTER UPDATE OF backward_cursor, backfill_done ON bronze_public_history_cursors
FOR EACH ROW
EXECUTE FUNCTION invalidate_public_gold_readiness_on_backfill_progress();

-- Require one verified post-migration projection before enabling medallion
-- reads for accounts whose bronze backfill was already complete. A NULL
-- recompute cursor deliberately requests a full gold rebuild.
INSERT INTO gold_public_history_cursors (
    account_id,
    gold_dirty_since,
    gold_recompute_from,
    projection_ready_at,
    projection_ready_version,
    projection_validation_pending,
    gold_force_full_recompute,
    updated_at
)
SELECT
    completed.account_id,
    NOW(),
    NULL,
    NULL,
    0,
    true,
    true,
    NOW()
FROM (
    SELECT account_id
    FROM bronze_public_history_cursors
    WHERE source IN (
        'nearblocks_ft'::public_history_source,
        'nearblocks_mt'::public_history_source,
        'nearblocks_receipt'::public_history_source
    )
      AND backfill_done = true
    GROUP BY account_id
    HAVING COUNT(*) = 3
) completed
ON CONFLICT (account_id) DO UPDATE SET
    gold_dirty_since = NOW(),
    gold_recompute_from = NULL,
    projection_ready_at = NULL,
    projection_ready_version = 0,
    projection_validation_pending = true,
    gold_force_full_recompute = true,
    updated_at = NOW();

-- Backfill previously paginated NearBlocks v3 with the wrong query param
-- (`cursor` instead of `next`), so every walk re-received page 1 and was
-- marked done after ~2 pages. Reset so backfill restarts from the newest
-- page and walks the full history; bronze upserts are idempotent.
UPDATE bronze_public_history_cursors
SET backfill_done = false,
    backward_cursor = NULL;

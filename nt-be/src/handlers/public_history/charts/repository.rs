use chrono::{DateTime, Utc};
use sqlx::PgPool;

use super::models::{ChartReadiness, GoldBalancePoint};

/// Balance-bearing gold rows for one DAO and chart window, unpivoted to
/// (asset, user-owned balance) points in event chronology. The query returns
/// every point inside the window plus the latest point before `start_time`
/// per asset, which is the carry-forward baseline for the first bucket.
///
/// Every candidate is anchored at its gold row's own `event_time` — for an
/// exchange that is the completion time, so the consuming leg orders after
/// the same-block deposit it consumed (the hidden balance-ledger row of that
/// deposit carries the earlier movement time). `leg_order` puts the out-leg
/// state before the in-leg state of the same row; `gold_id` is the final
/// tiebreak only.
pub async fn load_gold_balance_points(
    pool: &PgPool,
    dao_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    asset_ids: &[String],
) -> Result<Vec<GoldBalancePoint>, sqlx::Error> {
    sqlx::query_as::<_, GoldBalancePoint>(
        r#"
        WITH cap AS (
            -- MAX, not MIN: chart points span every asset (native/FT/MT,
            -- i.e. all 3 sources), so — like silver's recompute floor —
            -- this needs a bound that's safe regardless of which source's
            -- data a given point comes from. MAX(all 3 caps) is guaranteed
            -- >= each individual source's own cap, so it can never admit a
            -- source's pre-cap point; MIN would, for whichever source isn't
            -- the minimum of the three.
            SELECT MAX(capped_at_time) AS capped_at_time
            FROM bronze_public_history_cursors
            WHERE account_id = $1 AND backfill_capped = true
        ),
        candidate_points AS (
            SELECT
                gold.token_out AS asset,
                gold.token_out_user_balance_after AS balance,
                gold.event_time AS at_time,
                gold.block_height AS at_height,
                gold.source_order AS source_order,
                gold.id AS gold_id,
                0 AS leg_order
            FROM gold_treasury_ledger_events gold, cap
            WHERE gold.dao_id = $1
              AND gold.source_kind IN ('public_silver_leg', 'public_balance_ledger')
              AND gold.token_out IS NOT NULL
              AND gold.token_out_user_balance_after IS NOT NULL
              AND gold.event_time <= $3
              -- Pre-cap points are unreconciled history, never a reliable
              -- chart value or baseline — exclude them outright rather than
              -- only steering readers away via coverage metadata.
              AND gold.event_time >= COALESCE(cap.capped_at_time, gold.event_time)
              AND (
                  cardinality($4::text[]) = 0
                  OR gold.token_out = ANY($4::text[])
              )

            UNION ALL

            SELECT
                gold.token_in AS asset,
                gold.token_in_user_balance_after AS balance,
                gold.event_time AS at_time,
                gold.block_height AS at_height,
                gold.source_order AS source_order,
                gold.id AS gold_id,
                1 AS leg_order
            FROM gold_treasury_ledger_events gold, cap
            WHERE gold.dao_id = $1
              AND gold.source_kind IN ('public_silver_leg', 'public_balance_ledger')
              AND gold.token_in IS NOT NULL
              AND gold.token_in_user_balance_after IS NOT NULL
              AND gold.event_time <= $3
              AND gold.event_time >= COALESCE(cap.capped_at_time, gold.event_time)
              AND (
                  cardinality($4::text[]) = 0
                  OR gold.token_in = ANY($4::text[])
              )
        ),
        baseline AS (
            SELECT DISTINCT ON (asset)
                asset, balance, at_time, at_height, source_order, gold_id, leg_order
            FROM candidate_points
            WHERE at_time < $2
            ORDER BY
                asset ASC,
                at_time DESC,
                at_height DESC NULLS LAST,
                source_order DESC,
                leg_order DESC,
                gold_id DESC
        ),
        window_points AS (
            SELECT asset, balance, at_time, at_height, source_order, gold_id, leg_order
            FROM candidate_points
            WHERE at_time >= $2
        )
        SELECT asset, balance, at_time, at_height, gold_id, leg_order
        FROM (
            SELECT asset, balance, at_time, at_height, source_order, gold_id, leg_order
            FROM baseline
            UNION ALL
            SELECT asset, balance, at_time, at_height, source_order, gold_id, leg_order
            FROM window_points
        ) points
        ORDER BY
            at_time ASC,
            at_height ASC NULLS LAST,
            source_order ASC,
            leg_order ASC,
            gold_id ASC
        "#,
    )
    .bind(dao_id)
    .bind(start_time)
    .bind(end_time)
    .bind(asset_ids)
    .fetch_all(pool)
    .await
}

/// Confidential counterpart of [`load_gold_balance_points`]: unified-ledger
/// rows replayed from 1Click history. Both legs carry the row's replay
/// position (`event_time`, `source_order`), out-leg before in-leg.
pub async fn load_confidential_balance_points(
    pool: &PgPool,
    dao_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    asset_ids: &[String],
) -> Result<Vec<GoldBalancePoint>, sqlx::Error> {
    sqlx::query_as::<_, GoldBalancePoint>(
        r#"
        WITH candidate_points AS (
            SELECT
                gold.token_out AS asset,
                gold.token_out_user_balance_after AS balance,
                gold.event_time AS at_time,
                gold.source_order AS at_height,
                gold.id AS gold_id,
                0 AS leg_order
            FROM gold_treasury_ledger_events gold
            WHERE gold.dao_id = $1
              AND gold.source_kind = 'confidential_history_event'
              AND gold.token_out IS NOT NULL
              AND gold.token_out_user_balance_after IS NOT NULL
              AND gold.event_time <= $3
              AND (
                  cardinality($4::text[]) = 0
                  OR gold.token_out = ANY($4::text[])
              )

            UNION ALL

            SELECT
                gold.token_in AS asset,
                gold.token_in_user_balance_after AS balance,
                gold.event_time AS at_time,
                gold.source_order AS at_height,
                gold.id AS gold_id,
                1 AS leg_order
            FROM gold_treasury_ledger_events gold
            WHERE gold.dao_id = $1
              AND gold.source_kind = 'confidential_history_event'
              AND gold.token_in IS NOT NULL
              AND gold.token_in_user_balance_after IS NOT NULL
              AND gold.event_time <= $3
              AND (
                  cardinality($4::text[]) = 0
                  OR gold.token_in = ANY($4::text[])
              )
        ),
        baseline AS (
            SELECT DISTINCT ON (asset)
                asset, balance, at_time, at_height, gold_id, leg_order
            FROM candidate_points
            WHERE at_time < $2
            ORDER BY
                asset ASC,
                at_time DESC,
                at_height DESC,
                gold_id DESC,
                leg_order DESC
        ),
        window_points AS (
            SELECT asset, balance, at_time, at_height, gold_id, leg_order
            FROM candidate_points
            WHERE at_time >= $2
        )
        SELECT asset, balance, at_time, at_height, gold_id, leg_order
        FROM (
            SELECT asset, balance, at_time, at_height, gold_id, leg_order
            FROM baseline
            UNION ALL
            SELECT asset, balance, at_time, at_height, gold_id, leg_order
            FROM window_points
        ) points
        ORDER BY
            at_time ASC,
            at_height ASC,
            gold_id ASC,
            leg_order ASC
        "#,
    )
    .bind(dao_id)
    .bind(start_time)
    .bind(end_time)
    .bind(asset_ids)
    .fetch_all(pool)
    .await
}

/// Confidential chart readiness. There is no verification gate or staking
/// series: balances are checked against the 1Click balances API at projection
/// time, so the chart serves whenever confidential rows exist — Stale while
/// the backfill or a recompute is in flight.
pub async fn load_confidential_chart_readiness(
    pool: &PgPool,
    account_id: &str,
) -> Result<ChartReadiness, sqlx::Error> {
    sqlx::query_as::<_, ChartReadiness>(
        r#"
        SELECT
            (
                EXISTS (
                    SELECT 1
                    FROM bronze_confidential_history_cursors bronze_cursor
                    WHERE bronze_cursor.account_id = $1
                      AND bronze_cursor.backfill_done = true
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM gold_confidential_history_cursors gold_cursor
                    WHERE gold_cursor.account_id = $1
                      AND gold_cursor.gold_dirty_since IS NOT NULL
                )
            ) AS projection_ready,
            (
                SELECT gold_cursor.updated_at
                FROM gold_confidential_history_cursors gold_cursor
                WHERE gold_cursor.account_id = $1
            ) AS projection_ready_at,
            EXISTS (
                SELECT 1
                FROM gold_confidential_history_cursors gold_cursor
                WHERE gold_cursor.account_id = $1
                  AND gold_cursor.gold_dirty_since IS NOT NULL
            ) AS gold_dirty,
            TRUE AS verification_passed,
            FALSE AS head_check_failed,
            TRUE AS staking_ready,
            EXISTS (
                SELECT 1
                FROM gold_treasury_ledger_events gold
                WHERE gold.dao_id = $1
                  AND gold.source_kind = 'confidential_history_event'
                  AND (
                      (gold.token_in IS NOT NULL
                       AND gold.token_in_user_balance_after IS NOT NULL)
                      OR
                      (gold.token_out IS NOT NULL
                       AND gold.token_out_user_balance_after IS NOT NULL)
                  )
            ) AS has_gold_balance_points,
            (
                SELECT MIN(event_time)
                FROM gold_treasury_ledger_events
                WHERE dao_id = $1
                  AND source_kind = 'confidential_history_event'
            ) AS ledger_coverage_start,
            (
                SELECT MAX(event_time)
                FROM gold_treasury_ledger_events
                WHERE dao_id = $1
                  AND source_kind = 'confidential_history_event'
            ) AS ledger_head_time
        "#,
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
}

pub async fn load_chart_readiness(
    pool: &PgPool,
    account_id: &str,
) -> Result<ChartReadiness, sqlx::Error> {
    sqlx::query_as::<_, ChartReadiness>(
        r#"
        SELECT
            EXISTS (
                SELECT 1
                FROM gold_public_history_cursors gold_cursor
                WHERE gold_cursor.account_id = $1
                  AND gold_cursor.projection_ready_at IS NOT NULL
                  AND gold_cursor.projection_validation_pending = false
                  AND gold_cursor.gold_force_full_recompute = false
                  AND (
                      SELECT COUNT(*)
                      FROM bronze_public_history_cursors bronze_cursor
                      WHERE bronze_cursor.account_id = gold_cursor.account_id
                        AND bronze_cursor.source IN (
                            'nearblocks_ft'::public_history_source,
                            'nearblocks_mt'::public_history_source,
                            'nearblocks_receipt'::public_history_source
                        )
                        AND bronze_cursor.backfill_done = true
                  ) = 3
            ) AS projection_ready,
            (
                SELECT gold_cursor.projection_ready_at
                FROM gold_public_history_cursors gold_cursor
                WHERE gold_cursor.account_id = $1
            ) AS projection_ready_at,
            EXISTS (
                SELECT 1
                FROM gold_public_history_cursors gold_cursor
                WHERE gold_cursor.account_id = $1
                  AND gold_cursor.gold_dirty_since IS NOT NULL
            ) AS gold_dirty,
            EXISTS (
                SELECT 1
                FROM public_balance_verification_cursors verification
                WHERE verification.account_id = $1
                  AND verification.status = 'passed'
            ) AS verification_passed,
            EXISTS (
                SELECT 1
                FROM public_balance_verification_cursors verification
                WHERE verification.account_id = $1
                  AND verification.last_head_check_passed = false
            ) AS head_check_failed,
            NOT EXISTS (
                SELECT 1
                FROM staking_observation_cursors staking
                WHERE staking.account_id = $1
                  AND staking.validated = true
                  AND staking.backfill_done = false
            ) AS staking_ready,
            EXISTS (
                SELECT 1
                FROM gold_treasury_ledger_events gold
                WHERE gold.dao_id = $1
                  AND (
                      (gold.token_in IS NOT NULL
                       AND gold.token_in_user_balance_after IS NOT NULL)
                      OR
                      (gold.token_out IS NOT NULL
                       AND gold.token_out_user_balance_after IS NOT NULL)
                  )
            ) AS has_gold_balance_points,
            (
                -- A capped account's coverage genuinely starts at the clamp,
                -- not at whatever earlier history happens to still be
                -- retained — that older data is display-only, not a
                -- reconciled base. GREATEST is safe here: the anchor row
                -- itself lives at capped_at_time, so it never exceeds MIN.
                SELECT GREATEST(
                    MIN(silver_balance_history.block_time),
                    (
                        SELECT MAX(capped_at_time)
                        FROM bronze_public_history_cursors
                        WHERE account_id = $1 AND backfill_capped = true
                    )
                )
                FROM silver_balance_history
                WHERE account_id = $1
            ) AS ledger_coverage_start,
            (
                SELECT MAX(block_time)
                FROM silver_balance_history
                WHERE account_id = $1
            ) AS ledger_head_time
        "#,
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
}

use sqlx::PgPool;

use super::models::{ChartReadiness, GoldBalancePoint};

/// Every balance-bearing unified-ledger leg for one DAO, unpivoted to
/// (asset, user-owned balance) points in chain chronology. Visible activity
/// rows contribute up to two legs whose chain times come from their silver
/// legs (the counter/incoming leg carries its own time so carry-forward
/// follows actual chronology, not the flattened display time); hidden ledger
/// rows (sponsor top-ups, wraps, observations, rebases) carry their own block
/// position. One indexed query per request; carry-forward happens in Rust.
pub async fn load_gold_balance_points(
    pool: &PgPool,
    dao_id: &str,
) -> Result<Vec<GoldBalancePoint>, sqlx::Error> {
    sqlx::query_as::<_, GoldBalancePoint>(
        r#"
        SELECT asset, balance, at_time, at_height, gold_id, leg_order
        FROM (
            SELECT
                gold.token_in AS asset,
                gold.token_in_user_balance_after AS balance,
                COALESCE(counter_leg.block_time, primary_leg.block_time) AS at_time,
                COALESCE(counter_leg.block_height, primary_leg.block_height) AS at_height,
                gold.id AS gold_id,
                1 AS leg_order
            FROM gold_treasury_ledger_events gold
            JOIN silver_public_transfer_legs primary_leg
              ON primary_leg.id = gold.primary_transfer_leg_id
            LEFT JOIN silver_public_transfer_legs counter_leg
              ON counter_leg.id = gold.counter_transfer_leg_id
            WHERE gold.dao_id = $1
              AND gold.source_kind = 'public_silver_leg'
              AND gold.token_in IS NOT NULL
              AND gold.token_in_user_balance_after IS NOT NULL

            UNION ALL

            SELECT
                gold.token_out AS asset,
                gold.token_out_user_balance_after AS balance,
                primary_leg.block_time AS at_time,
                primary_leg.block_height AS at_height,
                gold.id AS gold_id,
                0 AS leg_order
            FROM gold_treasury_ledger_events gold
            JOIN silver_public_transfer_legs primary_leg
              ON primary_leg.id = gold.primary_transfer_leg_id
            WHERE gold.dao_id = $1
              AND gold.source_kind = 'public_silver_leg'
              AND gold.token_out IS NOT NULL
              AND gold.token_out_user_balance_after IS NOT NULL

            UNION ALL

            SELECT
                COALESCE(gold.token_in, gold.token_out) AS asset,
                COALESCE(
                    gold.token_in_user_balance_after,
                    gold.token_out_user_balance_after
                ) AS balance,
                gold.event_time AS at_time,
                gold.block_height AS at_height,
                gold.id AS gold_id,
                0 AS leg_order
            FROM gold_treasury_ledger_events gold
            WHERE gold.dao_id = $1
              AND gold.source_kind = 'public_balance_ledger'
              AND COALESCE(
                  gold.token_in_user_balance_after,
                  gold.token_out_user_balance_after
              ) IS NOT NULL
        ) points
        ORDER BY at_time ASC, at_height ASC, gold_id ASC, leg_order ASC
        "#,
    )
    .bind(dao_id)
    .fetch_all(pool)
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
            (
                SELECT MIN(block_time)
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

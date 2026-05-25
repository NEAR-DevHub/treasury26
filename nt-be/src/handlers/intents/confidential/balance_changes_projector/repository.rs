use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{BronzeProjectionRow, DirtyDao, GoldBalanceSeedRow, ProjectedRow};

const MARK_GOLD_DIRTY_SQL: &str = r#"
    INSERT INTO confidential_history_cursors (
        account_id,
        gold_dirty_since,
        gold_recompute_from,
        updated_at
    )
    VALUES ($1, NOW(), $2, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        gold_dirty_since = NOW(),
        gold_recompute_from = CASE
            WHEN EXCLUDED.gold_recompute_from IS NULL THEN confidential_history_cursors.gold_recompute_from
            WHEN confidential_history_cursors.gold_recompute_from IS NULL THEN EXCLUDED.gold_recompute_from
            ELSE LEAST(confidential_history_cursors.gold_recompute_from, EXCLUDED.gold_recompute_from)
        END,
        updated_at = NOW()
"#;

async fn mark_gold_dirty(
    pool: &PgPool,
    dao_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_DIRTY_SQL)
        .bind(dao_id)
        .bind(recompute_from)
        .execute(pool)
        .await?;
    Ok(())
}

/// Transaction-scoped so the Bronze upsert and dirty flag commit atomically.
pub async fn mark_gold_dirty_tx(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_DIRTY_SQL)
        .bind(dao_id)
        .bind(recompute_from)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn mark_gold_dirty_for_history_event(
    pool: &PgPool,
    history_event_id: i64,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        r#"
        SELECT account_id, created_at_external
        FROM confidential_history_events
        WHERE id = $1
        "#,
    )
    .bind(history_event_id)
    .fetch_optional(pool)
    .await?;

    if let Some((dao_id, recompute_from)) = row {
        mark_gold_dirty(pool, &dao_id, Some(recompute_from)).await?;
    }

    Ok(())
}

pub async fn refresh_gold_metadata_for_intent(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE confidential_balance_changes cbc
        SET intent_id = ci.id,
            proposal_created_at = ci.proposal_created_at,
            executed_at = ci.executed_at,
            block_height = ci.execution_block_height,
            block_time = ci.executed_at,
            transaction_hash = ci.execution_transaction_hash,
            updated_at = NOW()
        FROM confidential_intents ci
        WHERE ci.dao_id = $1
          AND ci.payload_hash = $2
          AND ci.history_event_id = cbc.history_event_id
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        let row = sqlx::query_as::<_, (DateTime<Utc>,)>(
            r#"
            SELECT he.created_at_external
            FROM confidential_intents ci
            JOIN confidential_history_events he ON he.id = ci.history_event_id
            WHERE ci.dao_id = $1
              AND ci.payload_hash = $2
            "#,
        )
        .bind(dao_id)
        .bind(payload_hash)
        .fetch_optional(pool)
        .await?;

        if let Some((recompute_from,)) = row {
            mark_gold_dirty(pool, dao_id, Some(recompute_from)).await?;
        }
    }

    Ok(result.rows_affected())
}

pub(crate) async fn load_dirty_daos(pool: &PgPool) -> Result<Vec<DirtyDao>, sqlx::Error> {
    sqlx::query_as::<_, DirtyDao>(
        r#"
        SELECT chc.account_id, chc.gold_dirty_since, chc.gold_recompute_from
        FROM confidential_history_cursors chc
        JOIN monitored_accounts ma ON ma.account_id = chc.account_id
        WHERE chc.gold_dirty_since IS NOT NULL
          AND ma.enabled = true
          AND ma.is_confidential_account = true
        ORDER BY chc.gold_dirty_since ASC, chc.account_id ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub(crate) async fn earliest_success_for_dao(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(created_at_external)
        FROM confidential_history_events
        WHERE account_id = $1
          AND status = 'SUCCESS'
        "#,
    )
    .bind(dao_id)
    .fetch_one(&mut **tx)
    .await
}

pub(crate) async fn seed_ledger_before(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<HashMap<String, BigDecimal>, sqlx::Error> {
    let rows = sqlx::query_as::<_, GoldBalanceSeedRow>(
        r#"
        SELECT DISTINCT ON (asset) asset, balance
        FROM (
            SELECT
                origin_asset AS asset,
                origin_balance_after AS balance,
                quote_created_at,
                history_event_id
            FROM confidential_balance_changes
            WHERE dao_id = $1
              AND quote_created_at < $2
              AND origin_asset IS NOT NULL
              AND origin_balance_after IS NOT NULL

            UNION ALL

            SELECT
                destination_asset AS asset,
                destination_balance_after AS balance,
                quote_created_at,
                history_event_id
            FROM confidential_balance_changes
            WHERE dao_id = $1
              AND quote_created_at < $2
              AND destination_balance_after IS NOT NULL
        ) balances
        ORDER BY asset, quote_created_at DESC, history_event_id DESC
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await?;

    let mut ledger = HashMap::new();
    for row in rows {
        ledger.insert(row.asset, row.balance);
    }

    Ok(ledger)
}

pub(crate) async fn has_gold_before(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM confidential_balance_changes
            WHERE dao_id = $1
              AND quote_created_at < $2
        )
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .fetch_one(&mut **tx)
    .await
}

pub(crate) async fn load_bronze_suffix(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<BronzeProjectionRow>, sqlx::Error> {
    sqlx::query_as::<_, BronzeProjectionRow>(
        r#"
        SELECT
            he.id,
            he.account_id,
            he.created_at_external,
            he.deposit_address,
            he.deposit_memo,
            he.deposit_type,
            he.recipient_type,
            he.recipient,
            he.origin_asset,
            he.destination_asset,
            he.raw_payload,
            ci.id AS intent_id,
            ci.proposal_created_at,
            ci.executed_at,
            ci.execution_block_height,
            ci.execution_transaction_hash
        FROM confidential_history_events he
        LEFT JOIN confidential_intents ci ON ci.history_event_id = he.id
        WHERE he.account_id = $1
          AND he.status = 'SUCCESS'
          AND he.created_at_external >= $2
        ORDER BY he.created_at_external ASC, he.id ASC
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await
}

pub(crate) async fn upsert_projection(
    tx: &mut Transaction<'_, Postgres>,
    row: &ProjectedRow,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO confidential_balance_changes (
            history_event_id,
            intent_id,
            dao_id,
            transaction_type,
            origin_asset,
            destination_asset,
            amount_in,
            amount_out,
            amount_in_usd,
            amount_out_usd,
            usd_change,
            origin_balance_before,
            origin_balance_after,
            destination_balance_before,
            destination_balance_after,
            recipient,
            refund_to,
            counterparty,
            deposit_address,
            deposit_memo,
            block_height,
            block_time,
            transaction_hash,
            quote_created_at,
            proposal_created_at,
            executed_at
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26
        )
        ON CONFLICT (history_event_id) DO UPDATE SET
            intent_id = EXCLUDED.intent_id,
            dao_id = EXCLUDED.dao_id,
            transaction_type = EXCLUDED.transaction_type,
            origin_asset = EXCLUDED.origin_asset,
            destination_asset = EXCLUDED.destination_asset,
            amount_in = EXCLUDED.amount_in,
            amount_out = EXCLUDED.amount_out,
            amount_in_usd = EXCLUDED.amount_in_usd,
            amount_out_usd = EXCLUDED.amount_out_usd,
            usd_change = EXCLUDED.usd_change,
            origin_balance_before = EXCLUDED.origin_balance_before,
            origin_balance_after = EXCLUDED.origin_balance_after,
            destination_balance_before = EXCLUDED.destination_balance_before,
            destination_balance_after = EXCLUDED.destination_balance_after,
            recipient = EXCLUDED.recipient,
            refund_to = EXCLUDED.refund_to,
            counterparty = EXCLUDED.counterparty,
            deposit_address = EXCLUDED.deposit_address,
            deposit_memo = EXCLUDED.deposit_memo,
            block_height = EXCLUDED.block_height,
            block_time = EXCLUDED.block_time,
            transaction_hash = EXCLUDED.transaction_hash,
            quote_created_at = EXCLUDED.quote_created_at,
            proposal_created_at = EXCLUDED.proposal_created_at,
            executed_at = EXCLUDED.executed_at,
            updated_at = NOW()
        "#,
    )
    .bind(row.history_event_id)
    .bind(row.intent_id)
    .bind(&row.dao_id)
    .bind(row.transaction_type.as_str())
    .bind(&row.origin_asset)
    .bind(&row.destination_asset)
    .bind(&row.amount_in)
    .bind(&row.amount_out)
    .bind(&row.amount_in_usd)
    .bind(&row.amount_out_usd)
    .bind(&row.usd_change)
    .bind(&row.origin_balance_before)
    .bind(&row.origin_balance_after)
    .bind(&row.destination_balance_before)
    .bind(&row.destination_balance_after)
    .bind(&row.recipient)
    .bind(&row.refund_to)
    .bind(&row.counterparty)
    .bind(&row.deposit_address)
    .bind(&row.deposit_memo)
    .bind(row.block_height)
    .bind(row.block_time)
    .bind(&row.transaction_hash)
    .bind(row.quote_created_at)
    .bind(row.proposal_created_at)
    .bind(row.executed_at)
    .execute(&mut **tx)
    .await?;

    clear_projection_error(tx, row.history_event_id).await?;

    Ok(())
}

pub(crate) async fn clear_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    history_event_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM confidential_balance_change_projection_errors
        WHERE history_event_id = $1
        "#,
    )
    .bind(history_event_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub(crate) async fn upsert_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    history_event_id: i64,
    dao_id: &str,
    reason: &str,
    raw_payload: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO confidential_balance_change_projection_errors (
            history_event_id,
            dao_id,
            reason,
            raw_payload
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (history_event_id) DO UPDATE SET
            dao_id = EXCLUDED.dao_id,
            reason = EXCLUDED.reason,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(history_event_id)
    .bind(dao_id)
    .bind(reason)
    .bind(raw_payload)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub(crate) async fn delete_stale_gold_rows(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
    preserve_ids: &[i64],
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM confidential_balance_changes
        WHERE dao_id = $1
          AND quote_created_at >= $2
          AND NOT (history_event_id = ANY($3))
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .bind(preserve_ids)
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected())
}

pub(crate) async fn clear_gold_dirty_if_not_advanced(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    dirty_since: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE confidential_history_cursors
        SET gold_dirty_since = NULL,
            gold_recompute_from = NULL,
            updated_at = NOW()
        WHERE account_id = $1
          AND gold_dirty_since <= $2
        "#,
    )
    .bind(dao_id)
    .bind(dirty_since)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn mark_backfilled_confidential_daos_gold_dirty(
    pool: &PgPool,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        WITH earliest_success AS (
            SELECT account_id, MIN(created_at_external) AS recompute_from
            FROM confidential_history_events
            WHERE status = 'SUCCESS'
            GROUP BY account_id
        ),
        gold_counts AS (
            SELECT dao_id, COUNT(*) AS projected_count
            FROM confidential_balance_changes
            GROUP BY dao_id
        )
        UPDATE confidential_history_cursors chc
        SET gold_dirty_since = NOW(),
            gold_recompute_from = CASE
                WHEN chc.gold_recompute_from IS NULL THEN es.recompute_from
                ELSE LEAST(chc.gold_recompute_from, es.recompute_from)
            END,
            updated_at = NOW()
        FROM monitored_accounts ma
        JOIN earliest_success es ON es.account_id = ma.account_id
        LEFT JOIN gold_counts gc ON gc.dao_id = ma.account_id
        WHERE ma.account_id = chc.account_id
          AND ma.enabled = true
          AND ma.is_confidential_account = true
          AND chc.backfill_done = true
          AND (
              chc.gold_dirty_since IS NOT NULL
              OR COALESCE(gc.projected_count, 0) = 0
          )
        "#,
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

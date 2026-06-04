use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{BronzeProjectionRow, DirtyDao, GoldBalanceSeedRow, ProjectedRow};
use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty;

pub async fn refresh_gold_metadata_for_intent(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE gold_confidential_history_events cbc
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
            JOIN bronze_confidential_history_events he ON he.id = ci.history_event_id
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
        SELECT gchc.account_id, gchc.gold_dirty_since, gchc.gold_recompute_from
        FROM gold_confidential_history_cursors gchc
        JOIN monitored_accounts ma ON ma.account_id = gchc.account_id
        WHERE gchc.gold_dirty_since IS NOT NULL
          AND ma.enabled = true
          AND ma.is_confidential_account = true
        ORDER BY gchc.gold_dirty_since ASC, gchc.account_id ASC
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
        FROM bronze_confidential_history_events
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
            FROM gold_confidential_history_events
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
            FROM gold_confidential_history_events
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
            FROM gold_confidential_history_events
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
        FROM bronze_confidential_history_events he
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
        INSERT INTO gold_confidential_history_events (
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
    .bind(row.dao_id.as_str())
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
        DELETE FROM gold_confidential_history_projection_errors
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
        INSERT INTO gold_confidential_history_projection_errors (
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
        DELETE FROM gold_confidential_history_events
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

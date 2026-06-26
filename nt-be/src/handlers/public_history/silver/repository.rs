use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{
    BronzePublicHistoryRow, DirtyPublicHistoryAccount, NormalizedTransferLeg,
};
use crate::handlers::public_history::gold::cursors::mark_gold_dirty_tx;

pub async fn load_dirty_accounts(
    pool: &PgPool,
) -> Result<Vec<DirtyPublicHistoryAccount>, sqlx::Error> {
    sqlx::query_as::<_, DirtyPublicHistoryAccount>(
        r#"
        SELECT
            account_id,
            silver_dirty_since AS dirty_since,
            silver_recompute_from AS recompute_from
        FROM silver_public_history_cursors
        WHERE silver_dirty_since IS NOT NULL
        ORDER BY silver_dirty_since ASC, account_id ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn earliest_bronze_time(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(block_time)
        FROM bronze_public_history_events
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
}

pub async fn has_silver_before(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM silver_public_transfer_legs
            WHERE account_id = $1
              AND block_time < $2
        )
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_one(&mut **tx)
    .await
}

pub async fn load_bronze_suffix(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<BronzePublicHistoryRow>, sqlx::Error> {
    sqlx::query_as::<_, BronzePublicHistoryRow>(
        r#"
        SELECT
            b.id,
            b.account_id,
            b.source::text AS source,
            b.source_event_key,
            b.transaction_hash,
            b.receipt_id,
            b.event_index,
            b.block_height,
            b.block_timestamp,
            b.block_time,
            b.affected_account_id,
            b.involved_account_id,
            b.contract_account_id,
            b.token_id,
            b.cause,
            b.action_kind,
            b.method_name,
            b.delta_amount_raw,
            b.decimals,
            b.deposit_raw,
            b.outcome_status,
            b.raw_payload,
            dp.id AS proposal_ref,
            dp.proposal_id
        FROM bronze_public_history_events b
        LEFT JOIN dao_proposals dp
          ON dp.dao_id = b.account_id
         AND dp.proposal_execution_transaction_hash = b.transaction_hash
        WHERE b.account_id = $1
          AND b.block_time >= $2
        ORDER BY b.block_time ASC, b.block_height ASC, b.id ASC
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await
}

pub async fn upsert_silver_leg(
    tx: &mut Transaction<'_, Postgres>,
    leg: &NormalizedTransferLeg,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO silver_public_transfer_legs (
            account_id,
            leg_key,
            source_event_id,
            source,
            proposal_ref,
            proposal_id,
            transaction_hash,
            receipt_id,
            event_index,
            block_height,
            block_timestamp,
            block_time,
            token_standard,
            token_id,
            direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind,
            linked_mint_bronze_id,
            linked_transfer_bronze_id,
            confidence,
            raw_payload
        )
        VALUES (
            $1, $2, $3, $4::public_history_source, $5, $6, $7, $8,
            $9, $10, $11, $12, $13::public_token_standard, $14,
            $15::public_transfer_direction, $16, $17, $18, $19,
            $20::public_transfer_leg_kind, $21, $22,
            $23::public_transfer_confidence, $24
        )
        ON CONFLICT (leg_key) DO UPDATE SET
            source_event_id = EXCLUDED.source_event_id,
            source = EXCLUDED.source,
            proposal_ref = EXCLUDED.proposal_ref,
            proposal_id = EXCLUDED.proposal_id,
            transaction_hash = EXCLUDED.transaction_hash,
            receipt_id = EXCLUDED.receipt_id,
            event_index = EXCLUDED.event_index,
            block_height = EXCLUDED.block_height,
            block_timestamp = EXCLUDED.block_timestamp,
            block_time = EXCLUDED.block_time,
            token_standard = EXCLUDED.token_standard,
            token_id = EXCLUDED.token_id,
            direction = EXCLUDED.direction,
            counterparty = EXCLUDED.counterparty,
            amount_raw = EXCLUDED.amount_raw,
            amount = EXCLUDED.amount,
            decimals = EXCLUDED.decimals,
            leg_kind = EXCLUDED.leg_kind,
            linked_mint_bronze_id = EXCLUDED.linked_mint_bronze_id,
            linked_transfer_bronze_id = EXCLUDED.linked_transfer_bronze_id,
            confidence = EXCLUDED.confidence,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(&leg.account_id)
    .bind(&leg.leg_key)
    .bind(leg.source_event_id)
    .bind(leg.source.as_str())
    .bind(leg.proposal_link.as_ref().map(|link| link.proposal_ref))
    .bind(leg.proposal_link.as_ref().map(|link| link.proposal_id))
    .bind(&leg.transaction_hash)
    .bind(&leg.receipt_id)
    .bind(leg.event_index)
    .bind(leg.block_height)
    .bind(&leg.block_timestamp)
    .bind(leg.block_time)
    .bind(leg.asset.token_standard().as_str())
    .bind(leg.asset.token_id())
    .bind(leg.direction.as_str())
    .bind(&leg.counterparty)
    .bind(&leg.amount.raw)
    .bind(&leg.amount.amount)
    .bind(leg.amount.decimals)
    .bind(leg.leg_kind.as_str())
    .bind(leg.linked_mint_bronze_id)
    .bind(leg.linked_transfer_bronze_id)
    .bind(leg.confidence.as_str())
    .bind(&leg.raw_payload)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn upsert_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    source_event_id: i64,
    account_id: &str,
    reason: &str,
    raw_payload: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO silver_public_history_projection_errors (
            source_event_id,
            account_id,
            reason,
            raw_payload
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (source_event_id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            reason = EXCLUDED.reason,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(source_event_id)
    .bind(account_id)
    .bind(reason)
    .bind(raw_payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn clear_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    source_event_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM silver_public_history_projection_errors
        WHERE source_event_id = $1
        "#,
    )
    .bind(source_event_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn delete_stale_silver_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
    preserve_leg_keys: &[String],
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM silver_public_transfer_legs
        WHERE account_id = $1
          AND block_time >= $2
          AND NOT (leg_key = ANY($3))
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .bind(preserve_leg_keys)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

pub async fn mark_gold_dirty_for_silver_change(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    mark_gold_dirty_tx(tx, account_id, recompute_from).await
}

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{DirtyPublicGoldAccount, GoldBalanceSeedRow, GoldPublicHistoryEvent};
use crate::handlers::public_history::silver::models::SilverTransferLegRow;

pub async fn load_dirty_accounts(
    pool: &PgPool,
) -> Result<Vec<DirtyPublicGoldAccount>, sqlx::Error> {
    sqlx::query_as::<_, DirtyPublicGoldAccount>(
        r#"
        SELECT
            account_id,
            gold_dirty_since AS dirty_since,
            gold_recompute_from AS recompute_from
        FROM gold_public_history_cursors
        WHERE gold_dirty_since IS NOT NULL
        ORDER BY gold_dirty_since ASC, account_id ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn earliest_silver_time(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(block_time)
        FROM silver_public_transfer_legs
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
}

pub async fn has_gold_before(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM gold_public_history_events
            WHERE dao_id = $1
              AND event_time < $2
        )
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_one(&mut **tx)
    .await
}

pub async fn earliest_pending_exchange_time(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(COALESCE(l.block_time, g.event_time))
        FROM gold_public_history_events g
        LEFT JOIN silver_public_transfer_legs l
          ON l.id = g.primary_transfer_leg_id
        WHERE g.dao_id = $1
          AND g.transaction_type = 'exchange'
          AND g.status = 'pending'
        "#,
    )
    .bind(dao_id)
    .fetch_one(&mut **tx)
    .await
}

pub async fn seed_ledger_before(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<GoldBalanceSeedRow>, sqlx::Error> {
    sqlx::query_as::<_, GoldBalanceSeedRow>(
        r#"
        SELECT DISTINCT ON (asset) asset, balance
        FROM (
            SELECT
                token_in AS asset,
                token_in_balance_after AS balance,
                event_time,
                id
            FROM gold_public_history_events
            WHERE dao_id = $1
              AND event_time < $2
              AND token_in IS NOT NULL
              AND token_in_balance_after IS NOT NULL

            UNION ALL

            SELECT
                token_out AS asset,
                token_out_balance_after AS balance,
                event_time,
                id
            FROM gold_public_history_events
            WHERE dao_id = $1
              AND event_time < $2
              AND token_out IS NOT NULL
              AND token_out_balance_after IS NOT NULL
        ) balances
        ORDER BY asset, event_time DESC, id DESC
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await
}

pub async fn load_silver_suffix(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<SilverTransferLegRow>, sqlx::Error> {
    sqlx::query_as::<_, SilverTransferLegRow>(
        r#"
        SELECT
            l.id,
            l.account_id,
            l.leg_key,
            l.proposal_ref,
            l.proposal_id,
            l.transaction_hash,
            l.receipt_id,
            l.block_height,
            l.block_time,
            l.token_standard::text AS token_standard,
            l.token_id,
            l.direction::text AS direction,
            l.counterparty,
            l.amount_raw,
            l.amount,
            l.decimals,
            l.leg_kind::text AS leg_kind,
            l.raw_payload,
            dp.status::text AS proposal_status,
            dp.proposal_created_at,
            dp.proposal_executed_at,
            dp.proposal_execution_block_height,
            dp.proposal_execution_transaction_hash,
            dp.quote_metadata,
            dp.quote_deposit_address
        FROM silver_public_transfer_legs l
        LEFT JOIN dao_proposals dp
          ON dp.id = l.proposal_ref
        WHERE l.account_id = $1
          AND l.block_time >= $2
        ORDER BY l.block_time ASC, l.block_height ASC, l.id ASC
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await
}

pub async fn upsert_gold_event(
    tx: &mut Transaction<'_, Postgres>,
    event: &GoldPublicHistoryEvent,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gold_public_history_events (
            gold_event_key,
            primary_transfer_leg_id,
            counter_transfer_leg_id,
            proposal_ref,
            dao_id,
            transaction_type,
            token_in,
            token_out,
            amount_in,
            amount_out,
            amount_in_usd,
            amount_out_usd,
            usd_change,
            token_in_balance_before,
            token_in_balance_after,
            token_out_balance_before,
            token_out_balance_after,
            recipient,
            counterparty,
            refund_to,
            transaction_hash,
            receipt_id,
            block_height,
            event_time,
            proposal_id,
            proposal_status,
            proposal_created_at,
            proposal_executed_at,
            proposal_execution_block_height,
            proposal_execution_transaction_hash,
            status,
            raw_payload
        )
        VALUES (
            $1, $2, $3, $4, $5, $6::public_transaction_type, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26::proposal_status,
            $27, $28, $29, $30, $31::public_history_event_status, $32
        )
        ON CONFLICT (gold_event_key) DO UPDATE SET
            primary_transfer_leg_id = EXCLUDED.primary_transfer_leg_id,
            counter_transfer_leg_id = EXCLUDED.counter_transfer_leg_id,
            proposal_ref = EXCLUDED.proposal_ref,
            dao_id = EXCLUDED.dao_id,
            transaction_type = EXCLUDED.transaction_type,
            token_in = EXCLUDED.token_in,
            token_out = EXCLUDED.token_out,
            amount_in = EXCLUDED.amount_in,
            amount_out = EXCLUDED.amount_out,
            amount_in_usd = EXCLUDED.amount_in_usd,
            amount_out_usd = EXCLUDED.amount_out_usd,
            usd_change = EXCLUDED.usd_change,
            token_in_balance_before = EXCLUDED.token_in_balance_before,
            token_in_balance_after = EXCLUDED.token_in_balance_after,
            token_out_balance_before = EXCLUDED.token_out_balance_before,
            token_out_balance_after = EXCLUDED.token_out_balance_after,
            recipient = EXCLUDED.recipient,
            counterparty = EXCLUDED.counterparty,
            refund_to = EXCLUDED.refund_to,
            transaction_hash = EXCLUDED.transaction_hash,
            receipt_id = EXCLUDED.receipt_id,
            block_height = EXCLUDED.block_height,
            event_time = EXCLUDED.event_time,
            proposal_id = EXCLUDED.proposal_id,
            proposal_status = EXCLUDED.proposal_status,
            proposal_created_at = EXCLUDED.proposal_created_at,
            proposal_executed_at = EXCLUDED.proposal_executed_at,
            proposal_execution_block_height = EXCLUDED.proposal_execution_block_height,
            proposal_execution_transaction_hash = EXCLUDED.proposal_execution_transaction_hash,
            status = EXCLUDED.status,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(&event.gold_event_key)
    .bind(event.primary_transfer_leg_id)
    .bind(event.counter_transfer_leg_id)
    .bind(event.proposal_ref)
    .bind(&event.dao_id)
    .bind(event.transaction_type.as_str())
    .bind(&event.token_in)
    .bind(&event.token_out)
    .bind(&event.amount_in)
    .bind(&event.amount_out)
    .bind(&event.amount_in_usd)
    .bind(&event.amount_out_usd)
    .bind(&event.usd_change)
    .bind(&event.token_in_balance_before)
    .bind(&event.token_in_balance_after)
    .bind(&event.token_out_balance_before)
    .bind(&event.token_out_balance_after)
    .bind(&event.recipient)
    .bind(&event.counterparty)
    .bind(&event.refund_to)
    .bind(&event.transaction_hash)
    .bind(&event.receipt_id)
    .bind(event.block_height)
    .bind(event.event_time)
    .bind(event.proposal_id)
    .bind(&event.proposal_status)
    .bind(event.proposal_created_at)
    .bind(event.proposal_executed_at)
    .bind(event.proposal_execution_block_height)
    .bind(&event.proposal_execution_transaction_hash)
    .bind(event.status.as_str())
    .bind(&event.raw_payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn clear_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    transfer_leg_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM gold_public_history_projection_errors
        WHERE transfer_leg_id = $1
        "#,
    )
    .bind(transfer_leg_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn upsert_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    transfer_leg_id: i64,
    dao_id: &str,
    reason: &str,
    raw_payload: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gold_public_history_projection_errors (
            transfer_leg_id,
            dao_id,
            reason,
            raw_payload
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (transfer_leg_id) DO UPDATE SET
            dao_id = EXCLUDED.dao_id,
            reason = EXCLUDED.reason,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(transfer_leg_id)
    .bind(dao_id)
    .bind(reason)
    .bind(raw_payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn delete_stale_gold_rows(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
    preserve_keys: &[String],
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM gold_public_history_events
        WHERE dao_id = $1
          AND event_time >= $2
          AND NOT (gold_event_key = ANY($3))
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .bind(preserve_keys)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

#[allow(dead_code)]
pub fn zero() -> BigDecimal {
    BigDecimal::from(0)
}

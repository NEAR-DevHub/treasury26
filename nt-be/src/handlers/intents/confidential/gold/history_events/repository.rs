use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::convert::{confidential_gold_event_key, unified_bind_from_event};
use super::models::{
    BronzeProjectionRow, ConfidentialDepositCorrection, ConfidentialDepositCorrectionIndex,
    DirtyDao, GoldBalanceSeedRow, ProjectedRow,
};
use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty;

pub async fn refresh_gold_metadata_for_intent(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE gold_treasury_ledger_events gle
        SET proposal_id = ci.proposal_id,
            proposal_created_at = ci.proposal_created_at,
            proposal_executed_at = ci.proposal_executed_at,
            proposal_execution_block_height = ci.proposal_execution_block_height,
            proposal_execution_transaction_hash = ci.proposal_execution_transaction_hash,
            updated_at = NOW()
        FROM confidential_intents ci
        WHERE ci.dao_id = $1
          AND ci.payload_hash = $2
          AND gle.gold_event_key = 'confidential:' || ci.history_event_id
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .execute(pool)
    .await?;

    // TODO(confidential-v2): remove with the legacy read path. Mirrors onto
    // the legacy table while UNIFIED_GOLD_LEDGER_READS can still serve it.
    sqlx::query(
        r#"
        UPDATE gold_confidential_history_events cbc
        SET intent_id = ci.id,
            proposal_created_at = ci.proposal_created_at,
            proposal_executed_at = ci.proposal_executed_at,
            proposal_execution_block_height = ci.proposal_execution_block_height,
            proposal_execution_transaction_hash = ci.proposal_execution_transaction_hash,
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
                token_out AS asset,
                token_out_user_balance_after AS balance,
                event_time,
                source_order,
                id
            FROM gold_treasury_ledger_events
            WHERE dao_id = $1
              AND source_kind = 'confidential_history_event'
              AND event_time < $2
              AND token_out IS NOT NULL
              AND token_out_user_balance_after IS NOT NULL

            UNION ALL

            SELECT
                token_in AS asset,
                token_in_user_balance_after AS balance,
                event_time,
                source_order,
                id
            FROM gold_treasury_ledger_events
            WHERE dao_id = $1
              AND source_kind = 'confidential_history_event'
              AND event_time < $2
              AND token_in IS NOT NULL
              AND token_in_user_balance_after IS NOT NULL
        ) balances
        ORDER BY asset, event_time DESC, source_order DESC, id DESC
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

/// Current per-asset ledger head balances from the unified confidential rows —
/// the values the inline 1Click balance check compares against.
pub(crate) async fn load_ledger_head_balances(
    pool: &PgPool,
    dao_id: &str,
) -> Result<HashMap<String, BigDecimal>, sqlx::Error> {
    let rows = sqlx::query_as::<_, GoldBalanceSeedRow>(
        r#"
        SELECT DISTINCT ON (asset) asset, balance
        FROM (
            SELECT
                token_out AS asset,
                token_out_user_balance_after AS balance,
                event_time,
                source_order,
                id
            FROM gold_treasury_ledger_events
            WHERE dao_id = $1
              AND source_kind = 'confidential_history_event'
              AND token_out IS NOT NULL
              AND token_out_user_balance_after IS NOT NULL

            UNION ALL

            SELECT
                token_in AS asset,
                token_in_user_balance_after AS balance,
                event_time,
                source_order,
                id
            FROM gold_treasury_ledger_events
            WHERE dao_id = $1
              AND source_kind = 'confidential_history_event'
              AND token_in IS NOT NULL
              AND token_in_user_balance_after IS NOT NULL
        ) balances
        ORDER BY asset, event_time DESC, source_order DESC, id DESC
        "#,
    )
    .bind(dao_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| (row.asset, row.balance))
        .collect())
}

const BALANCE_CHECK_REASON_PREFIX: &str = "balance check: ";

/// Record a ledger-vs-1Click balance mismatch on the DAO's newest bronze
/// event so drift is visible in the existing projection-errors table. Rows
/// keep serving — event data stays the feed's truth.
pub(crate) async fn record_balance_check_mismatch(
    pool: &PgPool,
    dao_id: &str,
    detail: &str,
) -> Result<(), sqlx::Error> {
    let head = sqlx::query_as::<_, (i64, Value)>(
        r#"
        SELECT id, raw_payload
        FROM bronze_confidential_history_events
        WHERE account_id = $1
          AND status = 'SUCCESS'
        ORDER BY created_at_external DESC, id DESC
        LIMIT 1
        "#,
    )
    .bind(dao_id)
    .fetch_optional(pool)
    .await?;

    let Some((history_event_id, raw_payload)) = head else {
        return Ok(());
    };

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
    .bind(format!("{BALANCE_CHECK_REASON_PREFIX}{detail}"))
    .bind(raw_payload)
    .execute(pool)
    .await?;

    Ok(())
}

pub(crate) async fn clear_balance_check_errors(
    pool: &PgPool,
    dao_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM gold_confidential_history_projection_errors
        WHERE dao_id = $1
          AND reason LIKE $2
        "#,
    )
    .bind(dao_id)
    .bind(format!("{BALANCE_CHECK_REASON_PREFIX}%"))
    .execute(pool)
    .await?;

    Ok(())
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
            FROM gold_treasury_ledger_events
            WHERE dao_id = $1
              AND source_kind = 'confidential_history_event'
              AND event_time < $2
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
            ci.proposal_id::bigint AS proposal_id,
            ci.proposal_created_at,
            ci.proposal_executed_at,
            ci.proposal_execution_block_height,
            ci.proposal_execution_transaction_hash
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
    let bind = unified_bind_from_event(row);
    sqlx::query(
        r#"
        INSERT INTO gold_treasury_ledger_events (
            gold_event_key,
            dao_id,
            source_kind,
            history_visible,
            transaction_type,
            status,
            event_time,
            block_height,
            source_order,
            token_in,
            amount_in,
            amount_in_usd,
            token_in_user_balance_after,
            token_out,
            amount_out,
            amount_out_usd,
            token_out_user_balance_after,
            usd_change,
            recipient,
            counterparty,
            transaction_hash,
            proposal_id,
            proposal_created_at,
            proposal_executed_at,
            proposal_execution_block_height,
            proposal_execution_transaction_hash
        )
        VALUES (
            $1, $2, 'confidential_history_event', TRUE,
            $3::public_transaction_type, 'success',
            $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, $21, $22
        )
        ON CONFLICT (gold_event_key) DO UPDATE SET
            dao_id = EXCLUDED.dao_id,
            transaction_type = EXCLUDED.transaction_type,
            event_time = EXCLUDED.event_time,
            source_order = EXCLUDED.source_order,
            token_in = EXCLUDED.token_in,
            token_out = EXCLUDED.token_out,
            amount_in = EXCLUDED.amount_in,
            amount_out = EXCLUDED.amount_out,
            amount_in_usd = CASE
                WHEN gold_treasury_ledger_events.token_in IS NOT DISTINCT FROM EXCLUDED.token_in
                 AND gold_treasury_ledger_events.amount_in IS NOT DISTINCT FROM EXCLUDED.amount_in
                 AND gold_treasury_ledger_events.event_time = EXCLUDED.event_time
                THEN COALESCE(EXCLUDED.amount_in_usd, gold_treasury_ledger_events.amount_in_usd)
                ELSE EXCLUDED.amount_in_usd
            END,
            amount_out_usd = CASE
                WHEN gold_treasury_ledger_events.token_out IS NOT DISTINCT FROM EXCLUDED.token_out
                 AND gold_treasury_ledger_events.amount_out IS NOT DISTINCT FROM EXCLUDED.amount_out
                 AND gold_treasury_ledger_events.event_time = EXCLUDED.event_time
                THEN COALESCE(EXCLUDED.amount_out_usd, gold_treasury_ledger_events.amount_out_usd)
                ELSE EXCLUDED.amount_out_usd
            END,
            token_in_user_balance_after = EXCLUDED.token_in_user_balance_after,
            token_out_user_balance_after = EXCLUDED.token_out_user_balance_after,
            usd_change = EXCLUDED.usd_change,
            recipient = EXCLUDED.recipient,
            counterparty = EXCLUDED.counterparty,
            transaction_hash = EXCLUDED.transaction_hash,
            proposal_id = EXCLUDED.proposal_id,
            proposal_created_at = EXCLUDED.proposal_created_at,
            proposal_executed_at = EXCLUDED.proposal_executed_at,
            proposal_execution_block_height = EXCLUDED.proposal_execution_block_height,
            proposal_execution_transaction_hash = EXCLUDED.proposal_execution_transaction_hash,
            updated_at = NOW()
        "#,
    )
    .bind(&bind.gold_event_key)
    .bind(row.dao_id.as_str())
    .bind(row.transaction_type.as_str())
    .bind(bind.event_time)
    .bind(bind.source_order)
    .bind(&bind.token_in)
    .bind(&bind.amount_in)
    .bind(&bind.amount_in_usd)
    .bind(&bind.token_in_user_balance_after)
    .bind(&bind.token_out)
    .bind(&bind.amount_out)
    .bind(&bind.amount_out_usd)
    .bind(&bind.token_out_user_balance_after)
    .bind(&row.usd_change)
    .bind(&row.recipient)
    .bind(&row.counterparty)
    .bind(&row.deposit_tx_hash)
    .bind(row.proposal_id)
    .bind(row.proposal_created_at)
    .bind(row.proposal_executed_at)
    .bind(row.proposal_execution_block_height)
    .bind(&row.proposal_execution_transaction_hash)
    .execute(&mut **tx)
    .await?;

    clear_projection_error(tx, row.history_event_id).await?;

    Ok(())
}

// TODO(confidential-v2): remove with the legacy read path.
/// Legacy dual-write while `UNIFIED_GOLD_LEDGER_READS` can still serve
/// confidential reads from `gold_confidential_history_events`.
pub(crate) async fn upsert_legacy_projection(
    tx: &mut Transaction<'_, Postgres>,
    row: &ProjectedRow,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gold_confidential_history_events (
            history_event_id, intent_id, dao_id, transaction_type,
            origin_asset, destination_asset, amount_in, amount_out,
            amount_in_usd, amount_out_usd, usd_change,
            origin_balance_before, origin_balance_after,
            destination_balance_before, destination_balance_after,
            recipient, refund_to, counterparty, deposit_address, deposit_memo,
            proposal_execution_block_height, proposal_executed_at,
            proposal_execution_transaction_hash, quote_created_at,
            proposal_created_at, deposit_tx_hash
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
            proposal_execution_block_height = EXCLUDED.proposal_execution_block_height,
            proposal_executed_at = EXCLUDED.proposal_executed_at,
            proposal_execution_transaction_hash = EXCLUDED.proposal_execution_transaction_hash,
            quote_created_at = EXCLUDED.quote_created_at,
            proposal_created_at = EXCLUDED.proposal_created_at,
            deposit_tx_hash = EXCLUDED.deposit_tx_hash,
            updated_at = NOW()
        "#,
    )
    .bind(row.history_event_id)
    .bind(row.intent_id)
    .bind(row.dao_id.as_str())
    .bind(row.transaction_type)
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
    .bind(row.proposal_execution_block_height)
    .bind(row.proposal_executed_at)
    .bind(&row.proposal_execution_transaction_hash)
    .bind(row.quote_created_at)
    .bind(row.proposal_created_at)
    .bind(&row.deposit_tx_hash)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub(crate) async fn delete_stale_legacy_gold_rows(
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

// Gold is a replayed projection of Bronze, so an existing Gold row can become
// stale during recomputation. For example, a Bronze row may be updated by
// 1Click, stop being `SUCCESS`, or start getting skipped by the classifier. In
// that case we remove the old projection so history/export stays aligned with
// Bronze.
pub(crate) async fn delete_stale_gold_rows(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
    preserve_ids: &[i64],
) -> Result<u64, sqlx::Error> {
    let preserve_keys: Vec<String> = preserve_ids
        .iter()
        .map(|id| confidential_gold_event_key(*id))
        .collect();
    let result = sqlx::query(
        r#"
        DELETE FROM gold_treasury_ledger_events
        WHERE dao_id = $1
          AND source_kind = 'confidential_history_event'
          AND event_time >= $2
          AND NOT (gold_event_key = ANY($3))
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .bind(&preserve_keys)
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected())
}

/// Load the recorded deposit corrections for a DAO over the recompute window
/// into an index the projector consumes during replay.
pub(crate) async fn load_confidential_deposit_corrections(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<ConfidentialDepositCorrectionIndex, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConfidentialDepositCorrection>(
        r#"
        SELECT
            c.history_event_id,
            c.corrected_raw_amount,
            c.corrected_net_amount
        FROM confidential_deposit_amount_corrections c
        JOIN bronze_confidential_history_events he ON he.id = c.history_event_id
        WHERE he.account_id = $1
          AND he.created_at_external >= $2
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await?;

    let entries = rows
        .into_iter()
        .map(|row| (row.history_event_id, row))
        .collect();
    Ok(ConfidentialDepositCorrectionIndex::new(entries))
}

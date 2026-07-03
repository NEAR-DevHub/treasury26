use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{
    BronzeProjectionRow, ConfidentialDepositCorrection, ConfidentialDepositCorrectionIndex,
    DirtyDao, GoldBalanceSeedRow, ProjectedRow,
};
use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty;
use crate::handlers::intents::confidential::types::ConfidentialDepositCorrectionSource;

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
            proposal_execution_block_height,
            proposal_executed_at,
            proposal_execution_transaction_hash,
            quote_created_at,
            proposal_created_at,
            deposit_tx_hash
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

/// Upsert a deposit correction. `BalanceChanges` (per-leg, authoritative) wins
/// over `LiveFetch` (a real-time stopgap): a `balance_changes` row always
/// overwrites, while a `live_fetch` row never overwrites an existing
/// `balance_changes` row (it only fills a gap or refreshes another live_fetch).
pub(crate) async fn upsert_confidential_deposit_correction(
    pool: &PgPool,
    history_event_id: i64,
    corrected_raw_amount: &BigDecimal,
    corrected_net_amount: &BigDecimal,
    source: ConfidentialDepositCorrectionSource,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO confidential_deposit_amount_corrections (
            history_event_id,
            corrected_raw_amount,
            corrected_net_amount,
            source
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (history_event_id) DO UPDATE SET
            corrected_raw_amount = EXCLUDED.corrected_raw_amount,
            corrected_net_amount = EXCLUDED.corrected_net_amount,
            source = EXCLUDED.source,
            updated_at = NOW()
        WHERE EXCLUDED.source = 'balance_changes'
           OR confidential_deposit_amount_corrections.source = 'live_fetch'
        "#,
    )
    .bind(history_event_id)
    .bind(corrected_raw_amount)
    .bind(corrected_net_amount)
    .bind(source)
    .execute(pool)
    .await?;

    Ok(())
}

/// A poller-recorded confidential deposit increase (`balance_changes` row with
/// `raw_data.source = '1click-poll'`), the backfill correction source. Swap-in
/// fulfillments are excluded — those are exchanges, not deposits.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ConfidentialDepositLeg {
    pub(crate) asset: String,
    pub(crate) observed_at: DateTime<Utc>,
    /// The poller's computed balance increase = the real deposited quantity.
    pub(crate) amount: BigDecimal,
}

/// Latest known ledger balance for a token (as either origin or destination
/// leg) across this DAO's gold rows — the "previous balance from the table"
/// the forward live-fetch correction diffs against. `None` if the token has no
/// prior gold row.
pub(crate) async fn latest_gold_token_balance(
    pool: &PgPool,
    dao_id: &str,
    asset: &str,
) -> Result<Option<BigDecimal>, sqlx::Error> {
    sqlx::query_scalar::<_, BigDecimal>(
        r#"
        SELECT balance
        FROM (
            SELECT origin_balance_after AS balance, quote_created_at, history_event_id
            FROM gold_confidential_history_events
            WHERE dao_id = $1 AND origin_asset = $2 AND origin_balance_after IS NOT NULL

            UNION ALL

            SELECT destination_balance_after AS balance, quote_created_at, history_event_id
            FROM gold_confidential_history_events
            WHERE dao_id = $1 AND destination_asset = $2 AND destination_balance_after IS NOT NULL
        ) balances
        ORDER BY quote_created_at DESC, history_event_id DESC
        LIMIT 1
        "#,
    )
    .bind(dao_id)
    .bind(asset)
    .fetch_optional(pool)
    .await
}

/// A projected deposit gold row — the rows whose amount the 1Click history API
/// misreports (same-asset `out - in` and origin-less shapes), which the backfill
/// pairs against poller legs.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct GoldDeposit {
    pub(crate) history_event_id: i64,
    pub(crate) asset: String,
    pub(crate) quote_created_at: DateTime<Utc>,
}

/// Load this DAO's deposit gold rows, time-ordered per (destination) asset, for
/// ordinal pairing against `balance_changes` deposit legs during backfill.
pub(crate) async fn load_confidential_gold_deposits(
    pool: &PgPool,
    dao_id: &str,
) -> Result<Vec<GoldDeposit>, sqlx::Error> {
    sqlx::query_as::<_, GoldDeposit>(
        r#"
        SELECT
            history_event_id,
            destination_asset AS asset,
            quote_created_at
        FROM gold_confidential_history_events
        WHERE dao_id = $1
          AND transaction_type = 'deposit'
        ORDER BY quote_created_at ASC, history_event_id ASC
        "#,
    )
    .bind(dao_id)
    .fetch_all(pool)
    .await
}

/// Load the poller's confidential deposit legs for a DAO, time-ordered per
/// asset, for ordinal pairing against gold deposit rows during backfill.
pub(crate) async fn load_confidential_deposit_legs(
    pool: &PgPool,
    dao_id: &str,
) -> Result<Vec<ConfidentialDepositLeg>, sqlx::Error> {
    sqlx::query_as::<_, ConfidentialDepositLeg>(
        r#"
        SELECT
            substring(token_id FROM 'intents\.near:(.*)') AS asset,
            block_time AS observed_at,
            amount
        FROM balance_changes
        WHERE account_id = $1
          AND token_id LIKE 'intents.near:%'
          AND raw_data->>'source' = '1click-poll'
          AND amount > 0
          AND counterparty <> 'intents.near'
          -- Poller deposit rows carry no method; named-method rows (e.g.
          -- act_proposal) and swap-in fulfillments (counterparty = intents.near)
          -- are not deposits.
          AND (method_name IS NULL OR method_name = '')
          AND block_time IS NOT NULL
        ORDER BY asset, block_time ASC, id ASC
        "#,
    )
    .bind(dao_id)
    .fetch_all(pool)
    .await
}

//! Hidden-row sync for the unified `gold_treasury_ledger_events` table.
//!
//! Activity rows are written directly by the gold projector. Ledger entries
//! not represented by a visible leg (sponsor top-ups, wraps, reconciliation
//! rebases) become hidden rows here, so the unified table alone is
//! balance-complete for charts.
//!
//! Cleanup is structural: hidden rows cascade with their
//! `silver_balance_history` entry (the ledger suffix is delete-then-insert),
//! activity rows cascade with their silver legs or are deleted by the
//! projector's stale-row sweep.

use chrono::{DateTime, Utc};
use sqlx::{Postgres, Transaction};

/// Hidden-row sync: hidden rows exist exactly for ledger entries not covered
/// by a visible activity row. Covered leftovers are deleted first (a pending
/// exchange's incoming entry gains its activity row only when the fulfillment
/// leg lands), then uncovered entries are upserted.
pub async fn sync_hidden_ledger_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    from: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    delete_covered_hidden_rows(tx, account_id, from).await?;
    upsert_hidden_ledger_rows(tx, account_id, from).await
}

/// Hidden rows whose ledger entry is now represented by an activity row;
/// keeping them would double-count the movement in charts.
async fn delete_covered_hidden_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    from: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM gold_treasury_ledger_events hidden
        USING silver_balance_history entry
        WHERE hidden.dao_id = $1
          AND hidden.source_kind = 'public_balance_ledger'
          AND hidden.balance_entry_id = entry.id
          AND entry.block_time >= $2
          AND EXISTS (
              SELECT 1
              FROM silver_public_transfer_legs leg
              JOIN gold_treasury_ledger_events activity
                ON activity.source_kind = 'public_silver_leg'
               AND leg.id IN (activity.primary_transfer_leg_id, activity.counter_transfer_leg_id)
              WHERE leg.account_id = $1
                AND (
                    (leg.token_standard <> 'native' AND leg.leg_key = entry.entry_key)
                    OR (
                        leg.token_standard = 'native'
                        AND leg.receipt_id IS NOT NULL
                        AND entry.entry_key = 'native:' || leg.account_id || ':' || leg.receipt_id
                    )
                )
          )
        "#,
    )
    .bind(account_id)
    .bind(from)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

/// Ledger entries with no visible feed leg become hidden single-leg rows, so
/// charts reading the unified table alone see every balance change.
async fn upsert_hidden_ledger_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        INSERT INTO gold_treasury_ledger_events (
            gold_event_key, dao_id, source_kind,
            history_visible, transaction_type, status,
            event_time, block_height, source_order,
            token_in, amount_in,
            token_in_user_balance_after,
            token_out, amount_out,
            token_out_user_balance_after,
            counterparty, transaction_hash, receipt_id,
            balance_entry_id
        )
        SELECT
            'ledger:' || entry.entry_key, $1,
            'public_balance_ledger',
            FALSE,
            CASE WHEN entry.delta >= 0 THEN 'deposit' ELSE 'sent' END::public_transaction_type,
            'success',
            entry.block_time, entry.block_height, entry.intra_block_seq,
            CASE WHEN entry.delta >= 0 THEN entry.asset END,
            CASE WHEN entry.delta >= 0 THEN entry.delta END,
            CASE WHEN entry.delta >= 0 THEN entry.user_balance_after END,
            CASE WHEN entry.delta < 0 THEN entry.asset END,
            CASE WHEN entry.delta < 0 THEN -entry.delta END,
            CASE WHEN entry.delta < 0 THEN entry.user_balance_after END,
            entry.counterparty, entry.transaction_hash, entry.receipt_id,
            entry.id
        FROM silver_balance_history entry
        WHERE entry.account_id = $1
          AND entry.block_time >= $2
          AND EXISTS (
              SELECT 1 FROM monitored_accounts classification
              WHERE classification.account_id = $1
                AND COALESCE(classification.is_confidential_account, false) = false
          )
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_transfer_legs leg
              JOIN gold_treasury_ledger_events activity
                ON activity.source_kind = 'public_silver_leg'
               AND leg.id IN (activity.primary_transfer_leg_id, activity.counter_transfer_leg_id)
              WHERE leg.account_id = $1
                AND (
                    (leg.token_standard <> 'native' AND leg.leg_key = entry.entry_key)
                    OR (
                        leg.token_standard = 'native'
                        AND leg.receipt_id IS NOT NULL
                        AND entry.entry_key = 'native:' || leg.account_id || ':' || leg.receipt_id
                    )
                )
          )
        ON CONFLICT (gold_event_key) DO UPDATE SET
            transaction_type = EXCLUDED.transaction_type,
            event_time = EXCLUDED.event_time,
            block_height = EXCLUDED.block_height,
            source_order = EXCLUDED.source_order,
            token_in = EXCLUDED.token_in,
            amount_in = EXCLUDED.amount_in,
            token_in_user_balance_after = EXCLUDED.token_in_user_balance_after,
            token_out = EXCLUDED.token_out,
            amount_out = EXCLUDED.amount_out,
            token_out_user_balance_after = EXCLUDED.token_out_user_balance_after,
            counterparty = EXCLUDED.counterparty,
            transaction_hash = EXCLUDED.transaction_hash,
            receipt_id = EXCLUDED.receipt_id,
            balance_entry_id = EXCLUDED.balance_entry_id,
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

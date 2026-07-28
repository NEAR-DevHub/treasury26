//! Dual-projection into the unified `gold_treasury_ledger_events` table.
//!
//! Runs inside the public gold projection transaction, after
//! `gold_public_history_events` is up to date. Visible feed rows become
//! unified rows stamped with user-owned balances; ledger entries not
//! represented by a visible leg (sponsor top-ups, wraps, reconciliation
//! rebases) become hidden rows so the unified table alone is
//! balance-complete for charts.
//!
//! Cleanup is structural: hidden rows cascade with their
//! `silver_balance_history` entry (the ledger suffix is delete-then-insert),
//! activity rows cascade with their silver legs, and rows whose legacy gold
//! event disappeared are deleted here explicitly.

use chrono::{DateTime, Utc};
use sqlx::{Postgres, Transaction};

#[derive(Debug, Clone, Copy, Default)]
pub struct UnifiedSyncOutcome {
    pub activity_rows: u64,
    pub hidden_rows: u64,
    pub deleted_rows: u64,
}

pub async fn sync_unified_for_account(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<UnifiedSyncOutcome, sqlx::Error> {
    let deleted_rows = delete_orphaned_activity_rows(tx, account_id, recompute_from).await?;
    let activity_rows = upsert_activity_rows(tx, account_id, recompute_from).await?;
    let hidden_rows = upsert_hidden_ledger_rows(tx, account_id, recompute_from).await?;
    Ok(UnifiedSyncOutcome {
        activity_rows,
        hidden_rows,
        deleted_rows,
    })
}

/// Activity rows whose legacy gold event was deleted by the recompute.
async fn delete_orphaned_activity_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM gold_treasury_ledger_events unified
        WHERE unified.dao_id = $1
          AND unified.source_kind = 'public_silver_leg'
          AND unified.event_time >= $2
          AND NOT EXISTS (
              SELECT 1
              FROM gold_public_history_events legacy
              WHERE legacy.gold_event_key = unified.gold_event_key
          )
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

/// One unified row per visible feed event, keyed by the same gold_event_key.
/// User-owned balances are stamped from the ledger entry matched through the
/// event's silver legs (exact identity: leg_key for FT/MT, receipt for
/// native); pending rows without ledger entries keep NULL stamps.
async fn upsert_activity_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        WITH leg_entry AS (
            SELECT
                leg.id AS leg_id,
                leg.direction,
                entry.user_balance_after,
                entry.intra_block_seq
            FROM silver_public_transfer_legs leg
            LEFT JOIN silver_balance_history entry
              ON entry.account_id = leg.account_id
             AND (
                 (leg.token_standard <> 'native' AND entry.entry_key = leg.leg_key)
                 OR (
                     leg.token_standard = 'native'
                     AND leg.receipt_id IS NOT NULL
                     AND entry.entry_key = 'native:' || leg.account_id || ':' || leg.receipt_id
                 )
             )
            WHERE leg.account_id = $1
        )
        INSERT INTO gold_treasury_ledger_events (
            gold_event_key, dao_id, source_kind,
            history_visible, transaction_type, status,
            event_time, block_height, source_order,
            token_in, amount_in, amount_in_usd,
            token_in_user_balance_after,
            token_out, amount_out, amount_out_usd,
            token_out_user_balance_after,
            usd_change, recipient, counterparty,
            transaction_hash, receipt_id,
            proposal_id, proposal_created_at,
            proposal_executed_at, proposal_execution_block_height,
            proposal_execution_transaction_hash,
            primary_transfer_leg_id, counter_transfer_leg_id
        )
        SELECT
            event.gold_event_key, event.dao_id, 'public_silver_leg',
            TRUE, event.transaction_type, event.status,
            event.event_time, event.block_height,
            COALESCE(in_leg.intra_block_seq, out_leg.intra_block_seq, 0),
            event.token_in, event.amount_in, event.amount_in_usd,
            in_leg.user_balance_after,
            event.token_out, event.amount_out, event.amount_out_usd,
            out_leg.user_balance_after,
            event.usd_change, event.recipient, event.counterparty,
            event.transaction_hash, event.receipt_id,
            event.proposal_id, event.proposal_created_at,
            event.proposal_executed_at, event.proposal_execution_block_height,
            event.proposal_execution_transaction_hash,
            event.primary_transfer_leg_id, event.counter_transfer_leg_id
        FROM gold_public_history_events event
        JOIN monitored_accounts classification
          ON classification.account_id = event.dao_id
         AND NOT COALESCE(classification.is_confidential_account, false)
        LEFT JOIN leg_entry in_leg
          ON in_leg.direction = 'incoming'
         AND in_leg.leg_id IN (event.primary_transfer_leg_id, event.counter_transfer_leg_id)
        LEFT JOIN leg_entry out_leg
          ON out_leg.direction = 'outgoing'
         AND out_leg.leg_id IN (event.primary_transfer_leg_id, event.counter_transfer_leg_id)
        WHERE event.dao_id = $1
          AND event.event_time >= $2
        ON CONFLICT (gold_event_key) DO UPDATE SET
            transaction_type = EXCLUDED.transaction_type,
            status = EXCLUDED.status,
            event_time = EXCLUDED.event_time,
            block_height = EXCLUDED.block_height,
            source_order = EXCLUDED.source_order,
            token_in = EXCLUDED.token_in,
            amount_in = EXCLUDED.amount_in,
            amount_in_usd = EXCLUDED.amount_in_usd,
            token_in_user_balance_after = EXCLUDED.token_in_user_balance_after,
            token_out = EXCLUDED.token_out,
            amount_out = EXCLUDED.amount_out,
            amount_out_usd = EXCLUDED.amount_out_usd,
            token_out_user_balance_after = EXCLUDED.token_out_user_balance_after,
            usd_change = EXCLUDED.usd_change,
            recipient = EXCLUDED.recipient,
            counterparty = EXCLUDED.counterparty,
            transaction_hash = EXCLUDED.transaction_hash,
            receipt_id = EXCLUDED.receipt_id,
            proposal_id = EXCLUDED.proposal_id,
            proposal_created_at = EXCLUDED.proposal_created_at,
            proposal_executed_at = EXCLUDED.proposal_executed_at,
            proposal_execution_block_height = EXCLUDED.proposal_execution_block_height,
            proposal_execution_transaction_hash = EXCLUDED.proposal_execution_transaction_hash,
            primary_transfer_leg_id = EXCLUDED.primary_transfer_leg_id,
            counter_transfer_leg_id = EXCLUDED.counter_transfer_leg_id,
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

/// Standalone hidden-row sync for writers that add ledger entries outside a
/// gold projection cycle.
pub async fn sync_hidden_ledger_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    from: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    upsert_hidden_ledger_rows(tx, account_id, from).await
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
              JOIN gold_public_history_events event
                ON leg.id IN (event.primary_transfer_leg_id, event.counter_transfer_leg_id)
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

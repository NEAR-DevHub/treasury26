use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use sqlx::PgPool;

use super::cursors::clear_gold_dirty_if_not_advanced;
use super::models::{GoldLedger, GoldProjectionCycleStats, GoldProjectionResult, GoldPublicHistoryEvent};
use super::repository::{
    clear_projection_error, delete_stale_gold_rows, earliest_silver_time, has_gold_before,
    load_dirty_accounts, load_silver_suffix, seed_ledger_before, upsert_gold_event,
    upsert_projection_error,
};
use crate::AppState;
use crate::handlers::public_history::silver::models::{
    PublicTransactionType, PublicTransferDirection, PublicTransferLegKind, SilverTransferLegRow,
};

const PUBLIC_GOLD_SCHEDULER_TICK: Duration = Duration::from_secs(10);
const PUBLIC_GOLD_WORKERS: usize = 4;

fn public_gold_event_from_leg(
    leg: &SilverTransferLegRow,
    ledger: &mut GoldLedger,
) -> Result<Option<GoldPublicHistoryEvent>, String> {
    let direction = PublicTransferDirection::from_db(&leg.direction)?;
    let leg_kind = PublicTransferLegKind::from_db(&leg.leg_kind)?;

    if direction == PublicTransferDirection::Internal
        || matches!(
            leg_kind,
            PublicTransferLegKind::Mint | PublicTransferLegKind::Burn
        )
    {
        return Ok(None);
    }

    let event_time = leg.proposal_executed_at.unwrap_or(leg.block_time);
    let gold_event_key = format!("silver-leg:{}", leg.leg_key);

    match direction {
        PublicTransferDirection::Incoming => {
            let (before, after) = ledger.apply_in(&leg.token_id, &leg.amount);
            Ok(Some(GoldPublicHistoryEvent {
                gold_event_key,
                primary_transfer_leg_id: leg.id,
                counter_transfer_leg_id: None,
                proposal_ref: leg.proposal_ref,
                dao_id: leg.account_id.clone(),
                transaction_type: PublicTransactionType::Deposit,
                token_in: Some(leg.token_id.clone()),
                token_out: None,
                amount_in: Some(leg.amount.clone()),
                amount_out: None,
                amount_in_usd: None,
                amount_out_usd: None,
                usd_change: None,
                token_in_balance_before: Some(before),
                token_in_balance_after: Some(after),
                token_out_balance_before: None,
                token_out_balance_after: None,
                recipient: None,
                counterparty: leg.counterparty.clone(),
                refund_to: None,
                transaction_hash: leg.transaction_hash.clone(),
                receipt_id: leg.receipt_id.clone(),
                block_height: Some(leg.block_height),
                event_time,
                proposal_id: leg.proposal_id,
                proposal_status: leg.proposal_status.clone(),
                proposal_created_at: leg.proposal_created_at,
                proposal_executed_at: leg.proposal_executed_at,
                proposal_execution_block_height: leg.proposal_execution_block_height,
                proposal_execution_transaction_hash: leg
                    .proposal_execution_transaction_hash
                    .clone(),
                swap_correlation_id: None,
                swap_status: None,
                raw_payload: leg.raw_payload.clone(),
            }))
        }
        PublicTransferDirection::Outgoing => {
            let (before, after) = ledger.apply_out(&leg.token_id, &leg.amount);
            Ok(Some(GoldPublicHistoryEvent {
                gold_event_key,
                primary_transfer_leg_id: leg.id,
                counter_transfer_leg_id: None,
                proposal_ref: leg.proposal_ref,
                dao_id: leg.account_id.clone(),
                transaction_type: PublicTransactionType::Sent,
                token_in: None,
                token_out: Some(leg.token_id.clone()),
                amount_in: None,
                amount_out: Some(leg.amount.clone()),
                amount_in_usd: None,
                amount_out_usd: None,
                usd_change: None,
                token_in_balance_before: None,
                token_in_balance_after: None,
                token_out_balance_before: Some(before),
                token_out_balance_after: Some(after),
                recipient: leg.counterparty.clone(),
                counterparty: leg.counterparty.clone(),
                refund_to: None,
                transaction_hash: leg.transaction_hash.clone(),
                receipt_id: leg.receipt_id.clone(),
                block_height: Some(leg.block_height),
                event_time,
                proposal_id: leg.proposal_id,
                proposal_status: leg.proposal_status.clone(),
                proposal_created_at: leg.proposal_created_at,
                proposal_executed_at: leg.proposal_executed_at,
                proposal_execution_block_height: leg.proposal_execution_block_height,
                proposal_execution_transaction_hash: leg
                    .proposal_execution_transaction_hash
                    .clone(),
                swap_correlation_id: None,
                swap_status: None,
                raw_payload: leg.raw_payload.clone(),
            }))
        }
        PublicTransferDirection::Internal => Ok(None),
    }
}

pub async fn project_public_gold_for_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<GoldProjectionResult, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let got_lock: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1))")
        .bind(format!("public-gold:{}", account_id))
        .fetch_one(&mut *tx)
        .await?;
    if !got_lock {
        tx.commit().await?;
        return Ok(GoldProjectionResult {
            skipped_locked: true,
            ..GoldProjectionResult::default()
        });
    }

    let cursor = sqlx::query_as::<
        _,
        (
            chrono::DateTime<chrono::Utc>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        r#"
        SELECT gold_dirty_since, gold_recompute_from
        FROM gold_public_history_cursors
        WHERE account_id = $1
          AND gold_dirty_since IS NOT NULL
        FOR UPDATE
        "#,
    )
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((dirty_since, cursor_recompute_from)) = cursor else {
        tx.commit().await?;
        return Ok(GoldProjectionResult::default());
    };

    let earliest = earliest_silver_time(&mut tx, account_id).await?;
    let Some(earliest) = earliest else {
        clear_gold_dirty_if_not_advanced(&mut tx, account_id, dirty_since).await?;
        tx.commit().await?;
        return Ok(GoldProjectionResult::default());
    };

    let mut recompute_from = cursor_recompute_from.unwrap_or(earliest);
    if earliest < recompute_from && !has_gold_before(&mut tx, account_id, recompute_from).await? {
        recompute_from = earliest;
    }

    let seed_rows = seed_ledger_before(&mut tx, account_id, recompute_from).await?;
    let mut ledger = GoldLedger::from_seed(seed_rows);
    let rows = load_silver_suffix(&mut tx, account_id, recompute_from).await?;
    let mut preserve_keys: HashSet<String> = HashSet::new();
    let mut stats = GoldProjectionResult::default();

    for leg in rows {
        match public_gold_event_from_leg(&leg, &mut ledger) {
            Ok(Some(event)) => {
                preserve_keys.insert(event.gold_event_key.clone());
                upsert_gold_event(&mut tx, &event).await?;
                clear_projection_error(&mut tx, leg.id).await?;
                stats.rows_projected += 1;
            }
            Ok(None) => {
                clear_projection_error(&mut tx, leg.id).await?;
            }
            Err(reason) => {
                upsert_projection_error(
                    &mut tx,
                    leg.id,
                    account_id,
                    &reason,
                    &leg.raw_payload,
                )
                .await?;
                stats.errors_written += 1;
            }
        }
    }

    let preserve_keys = preserve_keys.into_iter().collect::<Vec<_>>();
    stats.rows_deleted =
        delete_stale_gold_rows(&mut tx, account_id, recompute_from, &preserve_keys).await?;

    clear_gold_dirty_if_not_advanced(&mut tx, account_id, dirty_since).await?;
    tx.commit().await?;

    Ok(stats)
}

pub async fn project_public_gold_for_dirty_accounts(
    pool: &PgPool,
) -> Result<GoldProjectionCycleStats, sqlx::Error> {
    let dirty_accounts = load_dirty_accounts(pool).await?;
    let accounts_seen = dirty_accounts.len();

    let mut stream = futures::stream::iter(dirty_accounts.into_iter().map(|account| {
        let pool = pool.clone();
        async move {
            let account_id = account.account_id;
            let result = project_public_gold_for_account(&pool, &account_id).await;
            (account_id, result)
        }
    }))
    .buffer_unordered(PUBLIC_GOLD_WORKERS);

    let mut stats = GoldProjectionCycleStats {
        accounts_seen,
        ..GoldProjectionCycleStats::default()
    };

    while let Some((account_id, result)) = stream.next().await {
        match result {
            Ok(account_stats) if account_stats.skipped_locked => {
                stats.accounts_skipped_locked += 1;
            }
            Ok(account_stats) => {
                stats.accounts_projected += 1;
                stats.rows_projected += account_stats.rows_projected;
                stats.rows_deleted += account_stats.rows_deleted;
                stats.errors_written += account_stats.errors_written;
            }
            Err(e) => {
                stats.accounts_failed += 1;
                tracing::warn!(
                    account_id = account_id,
                    error = %e,
                    "public gold projection failed"
                );
            }
        }
    }

    Ok(stats)
}

pub fn spawn_public_gold_projection_worker(state: Arc<AppState>) {
    tokio::spawn(async move {
        tracing::info!(
            "Starting public gold worker ({:?} scheduler tick)",
            PUBLIC_GOLD_SCHEDULER_TICK
        );

        let mut timer = tokio::time::interval(PUBLIC_GOLD_SCHEDULER_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            let started_at = Instant::now();
            match project_public_gold_for_dirty_accounts(&state.db_pool).await {
                Ok(stats) if stats.accounts_seen > 0 => {
                    tracing::info!(
                        elapsed_secs = started_at.elapsed().as_secs_f64(),
                        accounts_seen = stats.accounts_seen,
                        accounts_projected = stats.accounts_projected,
                        accounts_skipped_locked = stats.accounts_skipped_locked,
                        accounts_failed = stats.accounts_failed,
                        rows_projected = stats.rows_projected,
                        rows_deleted = stats.rows_deleted,
                        errors_written = stats.errors_written,
                        "public gold cycle finished"
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::error!(error = %e, "public gold cycle failed");
                }
            }
        }
    });
}

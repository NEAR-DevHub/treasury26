//! Counterparty Correction for Native NEAR Transfers
//!
//! Fixes balance_changes records where the counterparty was incorrectly set to
//! the meta-tx delegate target or transaction receiver instead of the actual
//! sender/recipient DAO.
//!
//! This is a standalone correction process that queries the app database and
//! resolves correct counterparties via NEAR RPC — no Goldsky data needed.
//!
//! ## Cursor-based backward scan
//!
//! Progress is tracked in `maintenance_jobs` (row `counterparty_correction`).
//! On the first invocation the cursor is initialised to the highest block
//! height of any matching record. On each subsequent call, after processing
//! a batch, the cursor is moved to **one below the smallest `block_height`**
//! among the records in that batch. This can advance the cursor by more than
//! the batch size when matching records are sparse. The job stops naturally
//! once no matching records remain at or below the cursor.
//!
//! The cursor is only advanced when all records in the batch were resolved
//! without transient RPC errors, so a temporary network outage will not
//! permanently skip records.
//!
//! When no records remain at or below the cursor the cursor is set to `-1`
//! as a terminal sentinel.  Subsequent calls short-circuit immediately
//! (`last_processed_block < 0`) making completed jobs effectively O(1).

use crate::utils::jsonrpc::create_rpc_client;
use bigdecimal::Zero;
use near_api::NetworkConfig;
use near_jsonrpc_client::methods;
use near_primitives::views::FinalExecutionOutcomeViewEnum;
use sqlx::PgPool;

use super::utils::with_transport_retry;

const JOB_NAME: &str = "counterparty_correction";

/// Maximum number of records to examine per run.
const MAX_RECORDS_PER_RUN: i64 = 20;

/// A balance_changes record with a potentially wrong counterparty.
#[derive(Debug, sqlx::FromRow)]
struct WrongCounterpartyRecord {
    id: i64,
    account_id: String,
    block_height: i64,
    amount: bigdecimal::BigDecimal,
    transaction_hashes: Vec<String>,
    counterparty: String,
    signer_id: Option<String>,
}

/// Find and correct balance_changes records where the counterparty is likely wrong.
///
/// Identifies records where `token_id IS NULL OR token_id IN ('near', 'NEAR')`,
/// `method_name = 'act_proposal'`,
/// and `counterparty = receiver_id` (the meta-tx delegate target was used instead of
/// the actual sender/recipient DAO). Only processes records with `ABS(amount) > 0.01`
/// to skip gas cost records where the voter is the correct counterparty.
///
/// Progress is tracked in `maintenance_jobs`.  The scan works **backwards**
/// through block history so that the most-recent (most visible) records are
/// fixed first.  Once no matching records exist at or below the cursor the
/// cursor is set to `-1` (sentinel) and the function becomes a no-op on all
/// subsequent calls.
///
/// The cursor is only advanced when the batch completed without transient RPC
/// errors, so a temporary network outage will not permanently skip records.
///
/// Returns the number of records corrected.
pub async fn correct_near_counterparties(
    pool: &PgPool,
    network: &NetworkConfig,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // --- Resolve the cursor --------------------------------------------------

    let cursor: Option<i64> =
        sqlx::query_scalar("SELECT last_processed_block FROM maintenance_jobs WHERE job_name = $1")
            .bind(JOB_NAME)
            .fetch_optional(pool)
            .await?;

    let from_block: i64 = match cursor {
        // Sentinel: job already completed — skip without scanning `balance_changes`.
        Some(b) if b < 0 => {
            return Ok(0);
        }
        Some(b) => b,
        None => {
            // First run: seed the cursor at the highest matching block so the
            // scan starts at the most recent records and works backwards.
            let max_block: Option<i64> = sqlx::query_scalar(
                r#"
                SELECT MAX(block_height)
                FROM balance_changes
                WHERE (token_id IS NULL OR token_id IN ('near', 'NEAR'))
                  AND method_name = 'act_proposal'
                  AND counterparty = receiver_id
                  AND ABS(amount) > 0.01
                "#,
            )
            .fetch_optional(pool)
            .await?
            .flatten();

            match max_block {
                Some(b) => {
                    // ON CONFLICT DO NOTHING handles a concurrent first-run race
                    // from multiple replicas; we then re-fetch to get whichever
                    // replica's value won (they all use the same max_block, so
                    // the result is identical regardless).
                    sqlx::query(
                        "INSERT INTO maintenance_jobs (job_name, last_processed_block)
                         VALUES ($1, $2)
                         ON CONFLICT (job_name) DO NOTHING",
                    )
                    .bind(JOB_NAME)
                    .bind(b)
                    .execute(pool)
                    .await?;

                    let actual: i64 = sqlx::query_scalar(
                        "SELECT last_processed_block FROM maintenance_jobs WHERE job_name = $1",
                    )
                    .bind(JOB_NAME)
                    .fetch_one(pool)
                    .await?;

                    tracing::info!("Initialised cursor at block {}", actual);
                    actual
                }
                None => {
                    tracing::info!("No records to correct");
                    return Ok(0);
                }
            }
        }
    };

    // --- Fetch the next batch (backwards from cursor) -----------------------

    let records: Vec<WrongCounterpartyRecord> = sqlx::query_as(
        r#"
        SELECT id, account_id, block_height, amount, transaction_hashes,
               counterparty, signer_id
        FROM balance_changes
        WHERE (token_id IS NULL OR token_id IN ('near', 'NEAR'))
          AND method_name = 'act_proposal'
          AND counterparty = receiver_id
          AND ABS(amount) > 0.01
          AND block_height <= $1
        ORDER BY block_height DESC
        LIMIT $2
        "#,
    )
    .bind(from_block)
    .bind(MAX_RECORDS_PER_RUN)
    .fetch_all(pool)
    .await?;

    if records.is_empty() {
        // No more records — mark job complete with sentinel -1 so future
        // calls short-circuit at the cursor check above (O(1) per cycle).
        sqlx::query(
            "UPDATE maintenance_jobs
             SET last_processed_block = -1, updated_at = NOW()
             WHERE job_name = $1",
        )
        .bind(JOB_NAME)
        .execute(pool)
        .await?;
        tracing::info!("Job complete; cursor set to sentinel -1");
        return Ok(0);
    }

    tracing::info!(
        "Processing {} records at or below block {}",
        records.len(),
        from_block,
    );

    // --- Resolve counterparties via RPC -------------------------------------

    let client = create_rpc_client(network)?;
    let mut corrected = 0usize;
    let mut had_rpc_error = false;

    for record in &records {
        let tx_hash = match record.transaction_hashes.first() {
            Some(h) => h,
            None => continue,
        };

        let signer = match record.signer_id.as_deref() {
            Some(s) => s,
            None => {
                tracing::warn!(
                    "Skipping record {} for tx {}: missing signer_id",
                    record.id,
                    tx_hash
                );
                continue;
            }
        };

        let parsed_tx_hash: near_primitives::hash::CryptoHash = match tx_hash.parse() {
            Ok(h) => h,
            Err(_) => continue,
        };
        let parsed_sender: near_primitives::types::AccountId = match signer.parse() {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Use EXPERIMENTAL_tx_status to get full receipt data including predecessor_id
        let tx_response = match with_transport_retry("tx_status_correction", || {
            let req = methods::EXPERIMENTAL_tx_status::RpcTransactionStatusRequest {
                transaction_info: methods::EXPERIMENTAL_tx_status::TransactionInfo::TransactionId {
                    tx_hash: parsed_tx_hash,
                    sender_account_id: parsed_sender.clone(),
                },
                wait_until: near_primitives::views::TxExecutionStatus::Final,
            };
            client.call(req)
        })
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Failed to fetch tx {}: {}", tx_hash, e);
                had_rpc_error = true;
                continue;
            }
        };

        let (receipts_outcome, receipts) = match &tx_response.final_execution_outcome {
            Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(o)) => {
                (&o.receipts_outcome, None)
            }
            Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(o)) => {
                (&o.final_outcome.receipts_outcome, Some(&o.receipts))
            }
            None => continue,
        };

        // Find the receipt that executed on this account
        let our_receipt = match receipts_outcome
            .iter()
            .find(|ro| ro.outcome.executor_id.as_str() == record.account_id)
        {
            Some(r) => r,
            None => {
                tracing::warn!("No receipt for {} in tx {}", record.account_id, tx_hash);
                continue;
            }
        };

        let new_counterparty = if record.amount > bigdecimal::BigDecimal::zero() {
            // Incoming: get predecessor from full receipt data
            receipts
                .and_then(|rs| rs.iter().find(|r| r.receipt_id == our_receipt.id))
                .map(|r| r.predecessor_id.to_string())
                .filter(|p| *p != record.account_id)
        } else {
            // Outgoing: find child receipt with different executor
            let child_ids: std::collections::HashSet<near_primitives::hash::CryptoHash> =
                our_receipt.outcome.receipt_ids.iter().cloned().collect();

            receipts_outcome
                .iter()
                .find(|ro| {
                    child_ids.contains(&ro.id)
                        && ro.outcome.executor_id.as_str() != record.account_id
                })
                .map(|ro| ro.outcome.executor_id.to_string())
        };

        if let Some(ref new_cp) = new_counterparty
            && *new_cp != record.counterparty
        {
            sqlx::query(
                "UPDATE balance_changes SET counterparty = $1, updated_at = NOW()
                 WHERE id = $2",
            )
            .bind(new_cp)
            .bind(record.id)
            .execute(pool)
            .await?;

            tracing::info!(
                "id={}: {} → {} (tx={}, amount={})",
                record.id,
                record.counterparty,
                new_cp,
                tx_hash,
                record.amount,
            );
            corrected += 1;
        }
    }

    // --- Advance cursor ------------------------------------------------------
    //
    // Only advance if the batch completed without transient RPC errors.
    // A temporary network outage must not permanently skip unresolved records.
    // Permanent skips (missing signer_id, unparseable hash) are not counted as
    // RPC errors and do not block cursor advancement.
    if had_rpc_error {
        tracing::warn!(
            "Skipping cursor advance due to RPC errors; \
             will retry this batch next cycle (cursor stays at {})",
            from_block
        );
        return Ok(corrected);
    }

    let min_block = records
        .iter()
        .map(|r| r.block_height)
        .min()
        .expect("records is non-empty");
    let next_cursor = min_block - 1;

    // LEAST() ensures the cursor only ever decreases, even under concurrent
    // runs from multiple replicas that may have read the same from_block.
    sqlx::query(
        "UPDATE maintenance_jobs
         SET last_processed_block = LEAST(last_processed_block, $1), updated_at = NOW()
         WHERE job_name = $2",
    )
    .bind(next_cursor)
    .bind(JOB_NAME)
    .execute(pool)
    .await?;

    tracing::info!(
        "Corrected {}/{} records; cursor advanced to block {}",
        corrected,
        records.len(),
        next_cursor,
    );

    Ok(corrected)
}

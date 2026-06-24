//! DAO event detection worker.
//!
//! Scans `balance_changes` and `detected_swaps` for notable events and writes
//! them to the generic `dao_notifications` queue.
//!
//! Only DAOs with at least one notification destination (currently: Telegram)
//! produce notifications. Zero RPC calls — reads from the app DB only.

use bigdecimal::Zero;
use sqlx::PgPool;

use super::payload_decoder::decode_add_proposal_payload;

const CONSUMER_BC: &str = "notifications:balance_changes";
const CONSUMER_SWAPS: &str = "notifications:detected_swaps";
const BATCH_SIZE: i64 = 100;

// ---------------------------------------------------------------------------
// Cursor helpers (reuse goldsky_cursors table)
// ---------------------------------------------------------------------------

/// Return the last-processed id for `consumer_name`.
///
/// On first run (no cursor row yet), seed the cursor from the latest row in
/// `seed_table` so we don't flood connected chats with every historical event.
/// The seeded position is persisted immediately so subsequent calls return it.
async fn get_cursor(
    pool: &PgPool,
    consumer_name: &str,
    seed_table: &str,
) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT last_processed_block FROM goldsky_cursors WHERE consumer_name = $1",
    )
    .bind(consumer_name)
    .fetch_optional(pool)
    .await?;

    if let Some(id) = row {
        return Ok(id);
    }

    // No cursor yet — seed from the latest row in the source table so we only
    // notify about events that arrive after this fresh deployment.
    let latest: Option<i64> = sqlx::query_scalar(&format!("SELECT MAX(id) FROM {seed_table}"))
        .fetch_optional(pool)
        .await?
        .flatten();

    let seed = latest.unwrap_or(0);
    tracing::info!("No cursor for {consumer_name}, seeding from latest {seed_table} id={seed}");
    update_cursor(pool, consumer_name, seed).await?;
    Ok(seed)
}

async fn update_cursor(
    pool: &PgPool,
    consumer_name: &str,
    last_id: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    sqlx::query!(
        "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (consumer_name) DO UPDATE SET
           last_processed_id = EXCLUDED.last_processed_id,
           last_processed_block = EXCLUDED.last_processed_block,
           updated_at = NOW()",
        consumer_name,
        last_id.to_string(),
        last_id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// balance_changes detection
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct BalanceChangeRow {
    id: i64,
    account_id: String,
    token_id: String,
    amount: bigdecimal::BigDecimal,
    counterparty: Option<String>,
    method_name: Option<String>,
    action_kind: Option<String>,
    actions: Option<serde_json::Value>,
    usd_value: Option<bigdecimal::BigDecimal>,
    block_height: i64,
    transaction_hashes: Vec<String>,
}

#[tracing::instrument(
    level = "debug",
    skip_all,
    fields(job = "notification_detection", step = "balance_changes")
)]
async fn detect_balance_change_events(
    pool: &PgPool,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let last_id = get_cursor(pool, CONSUMER_BC, "balance_changes").await?;

    // Only scan events for DAOs that have at least one notification destination
    // registered (currently: Telegram). This keeps dao_notifications small.
    let rows: Vec<BalanceChangeRow> = sqlx::query_as(
        r#"
        SELECT bc.id, bc.account_id, bc.token_id, bc.amount, bc.counterparty,
               bc.method_name, bc.action_kind, bc.actions, bc.usd_value, bc.block_height,
               bc.transaction_hashes
        FROM balance_changes bc
        WHERE bc.id > $1
          AND bc.account_id IN (SELECT dao_id FROM telegram_treasury_connections)
        ORDER BY bc.id ASC
        LIMIT $2
        "#,
    )
    .bind(last_id)
    .bind(BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    let mut inserted = 0usize;
    let mut max_id = last_id;

    for row in &rows {
        max_id = max_id.max(row.id);

        let method = row.method_name.as_deref().unwrap_or("");
        let kind = row.action_kind.as_deref().unwrap_or("");

        let is_proposal = method == "add_proposal";

        let is_payment = row.amount < 0
            && ((kind == "TRANSFER" && !row.token_id.eq_ignore_ascii_case("near"))
                || (row.token_id.eq_ignore_ascii_case("near")
                    && matches!(method, "on_proposal_callback" | "ft_transfer")));

        if !is_proposal && !is_payment {
            continue;
        }

        let event_type = if is_proposal {
            "add_proposal"
        } else {
            "payment"
        };
        let proposal_tx_hash = if is_proposal {
            row.transaction_hashes
                .first()
                .cloned()
                .filter(|hash| !hash.is_empty())
        } else {
            None
        };

        // For proposal transactions that fan out into multiple balance_changes rows,
        // prefer the row with a non-zero amount (bond/gas debit) when present.
        if is_proposal
            && row.amount.is_zero()
            && let Some(tx_hash) = proposal_tx_hash.as_deref()
        {
            let has_nonzero_sibling: bool = sqlx::query_scalar!(
                r#"
                SELECT EXISTS(
                    SELECT 1
                    FROM balance_changes
                    WHERE account_id = $1
                      AND method_name = 'add_proposal'
                      AND action_kind = 'FUNCTION_CALL'
                      AND transaction_hashes[1] = $2
                      AND amount <> 0
                )
                "#,
                &row.account_id,
                tx_hash,
            )
            .fetch_one(pool)
            .await?
            .unwrap_or(false);

            if has_nonzero_sibling {
                continue;
            }
        }

        let payload = if is_proposal {
            let decoded = decode_add_proposal_payload(row.actions.as_ref());
            let submitter = decoded
                .delegate_sender_id
                .as_deref()
                .or(row.counterparty.as_deref());

            serde_json::json!({
                "counterparty": submitter,
                "block_height": row.block_height,
                "description": decoded.description,
                "proposal_kind": decoded.proposal_kind,
                "tx_hash": proposal_tx_hash,
            })
        } else {
            serde_json::json!({
                "token_id": row.token_id,
                "amount": row.amount.to_string(),
                "counterparty": row.counterparty,
                "usd_value": row.usd_value.as_ref().map(|v| v.to_string()),
            })
        };

        let rows_inserted = if is_proposal {
            if let Some(tx_hash) = proposal_tx_hash.as_deref() {
                sqlx::query!(
                    r#"
                    INSERT INTO dao_notifications (dao_id, event_type, source_id, source_table, payload)
                    SELECT $1, $2, $3, 'balance_changes', $4
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM dao_notifications n
                        WHERE n.dao_id = $1
                          AND n.event_type = $2
                          AND n.source_table = 'balance_changes'
                          AND n.payload->>'tx_hash' = $5
                    )
                    ON CONFLICT (source_table, source_id, dao_id, event_type) DO NOTHING
                    "#,
                    &row.account_id,
                    event_type,
                    row.id,
                    &payload,
                    tx_hash,
                )
                .execute(pool)
                .await?
                .rows_affected()
            } else {
                sqlx::query!(
                    r#"
                    INSERT INTO dao_notifications (dao_id, event_type, source_id, source_table, payload)
                    VALUES ($1, $2, $3, 'balance_changes', $4)
                    ON CONFLICT (source_table, source_id, dao_id, event_type) DO NOTHING
                    "#,
                    &row.account_id,
                    event_type,
                    row.id,
                    &payload,
                )
                .execute(pool)
                .await?
                .rows_affected()
            }
        } else {
            sqlx::query!(
                r#"
                INSERT INTO dao_notifications (dao_id, event_type, source_id, source_table, payload)
                VALUES ($1, $2, $3, 'balance_changes', $4)
                ON CONFLICT (source_table, source_id, dao_id, event_type) DO NOTHING
                "#,
                &row.account_id,
                event_type,
                row.id,
                &payload,
            )
            .execute(pool)
            .await?
            .rows_affected()
        };

        inserted += rows_inserted as usize;
    }

    update_cursor(pool, CONSUMER_BC, max_id).await?;

    Ok(inserted)
}

// ---------------------------------------------------------------------------
// detected_swaps detection
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct DetectedSwapRow {
    id: i64,
    account_id: String,
    solver_transaction_hash: String,
    deposit_balance_change_id: Option<i64>,
    fulfillment_balance_change_id: i64,
    fulfillment_receipt_id: Option<String>,
    sent_token_id: Option<String>,
    sent_amount: Option<bigdecimal::BigDecimal>,
    received_token_id: String,
    received_amount: Option<bigdecimal::BigDecimal>,
}

#[tracing::instrument(
    level = "debug",
    skip_all,
    fields(job = "notification_detection", step = "swaps")
)]
async fn detect_swap_events(
    pool: &PgPool,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let last_id = get_cursor(pool, CONSUMER_SWAPS, "detected_swaps").await?;

    // Only emit notifications once the fulfillment leg is known. Confidential
    // swaps pre-insert a detected_swaps row at the outgoing (deposit) step
    // with a NULL fulfillment_balance_change_id; we must not notify for those
    // yet — nor advance the cursor past them, otherwise we would never
    // revisit them once the poller fills fulfillment_* in place.
    let rows: Vec<DetectedSwapRow> = sqlx::query_as(
        r#"
        SELECT id, account_id, solver_transaction_hash, deposit_balance_change_id,
               fulfillment_balance_change_id, fulfillment_receipt_id,
               sent_token_id, sent_amount, received_token_id, received_amount
        FROM detected_swaps
        WHERE id > $1
          AND fulfillment_balance_change_id IS NOT NULL
          AND account_id IN (SELECT dao_id FROM telegram_treasury_connections)
        ORDER BY id ASC
        LIMIT $2
        "#,
    )
    .bind(last_id)
    .bind(BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    let mut inserted = 0usize;
    let batch_max_id = rows.iter().map(|r| r.id).max().unwrap_or(last_id);

    for row in &rows {
        // Proposal-deposit synthetic rows are pre-seeded for quote context and can
        // appear swap-like even when actual fulfillment has not happened yet.
        // Notify only when they have a distinct fulfillment leg or an explicit
        // fulfillment receipt recorded.
        let is_synthetic_proposal_deposit =
            row.solver_transaction_hash.starts_with("proposal-deposit-");
        let has_same_deposit_and_fulfillment = row
            .deposit_balance_change_id
            .is_some_and(|deposit_id| deposit_id == row.fulfillment_balance_change_id);
        if is_synthetic_proposal_deposit
            && row.fulfillment_receipt_id.is_none()
            && has_same_deposit_and_fulfillment
        {
            continue;
        }

        let received = match &row.received_amount {
            Some(v) => v.to_string(),
            None => {
                tracing::warn!(
                    "detected_swap id={} has fulfillment but NULL received_amount; skipping",
                    row.id
                );
                continue;
            }
        };

        let payload = serde_json::json!({
            "sent_token_id": row.sent_token_id,
            "sent_amount": row.sent_amount.as_ref().map(|a| a.to_string()),
            "received_token_id": row.received_token_id,
            "received_amount": received,
        });

        let rows_inserted = sqlx::query!(
            r#"
            INSERT INTO dao_notifications (dao_id, event_type, source_id, source_table, payload)
            VALUES ($1, 'swap_fulfilled', $2, 'detected_swaps', $3)
            ON CONFLICT (source_table, source_id, dao_id, event_type) DO NOTHING
            "#,
            &row.account_id,
            row.id,
            &payload,
        )
        .execute(pool)
        .await?
        .rows_affected();

        inserted += rows_inserted as usize;
    }

    // Advance the cursor only up to (min-unfulfilled-id - 1) within the scanned
    // window, so pre-seeded rows that are still waiting for their fulfillment
    // remain reachable in subsequent cycles.
    let min_unfulfilled: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT MIN(id) FROM detected_swaps
        WHERE id > $1
          AND id <= $2
          AND fulfillment_balance_change_id IS NULL
        "#,
    )
    .bind(last_id)
    .bind(batch_max_id)
    .fetch_one(pool)
    .await?;

    let new_cursor = match min_unfulfilled {
        Some(min_id) => min_id - 1,
        None => batch_max_id,
    };
    if new_cursor > last_id {
        update_cursor(pool, CONSUMER_SWAPS, new_cursor).await?;
    }

    Ok(inserted)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Scan `balance_changes` and `detected_swaps` for new events and write them
/// to `dao_notifications`. Zero RPC calls — reads from the app DB only.
///
/// Returns the total number of new notification rows inserted.
#[tracing::instrument(level = "info", skip_all, fields(job = "notification_detection"))]
pub async fn run_detection_cycle(
    pool: &PgPool,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let bc = detect_balance_change_events(pool).await?;
    let sw = detect_swap_events(pool).await?;
    Ok(bc + sw)
}

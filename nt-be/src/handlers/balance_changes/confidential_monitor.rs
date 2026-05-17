//! Confidential Treasury Balance Monitoring
//!
//! Polls the 1Click API for confidential treasury balances and records
//! **incoming** balance changes (deposits and solver swap fulfillments).
//! Outgoing legs are owned by Goldsky enrichment
//! (`confidential_enrichment::handle_confidential_outgoing`), so decreases
//! seen here are ignored to avoid double-counting.
//!
//! When an increase matches a pending confidential swap quote stored in
//! `confidential_intents.quote_metadata`, a row is inserted into
//! `detected_swaps` linking the Goldsky-written outgoing `balance_change`
//! to this newly-written fulfillment row — reusing the same linkage the
//! public intents pipeline already uses.

use bigdecimal::BigDecimal;
use chrono::Utc;
use near_api::{Chain, NetworkConfig};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

use crate::AppState;
use crate::handlers::intents::confidential::balances::fetch_confidential_balances;

use super::counterparty::{convert_raw_to_decimal, ensure_ft_metadata};

/// Tolerance for matching a polling-detected balance increase against the
/// stored `quote_metadata.quote.amountOut`. 1% absorbs solver slippage;
/// `minAmountOut` is already guarded on the quote side.
const SWAP_MATCH_TOLERANCE: f64 = 0.01;

/// Convert a raw 1Click token_id to the format stored in `balance_changes`.
///
/// 1Click returns e.g. `nep141:wrap.near`; `balance_changes.token_id` stores
/// intents tokens as `intents.near:nep141:wrap.near`.
fn to_storage_token_id(raw_token_id: &str) -> String {
    format!("intents.near:{}", raw_token_id)
}

/// Decimal-adjust a raw balance string using the token's metadata decimals.
async fn adjust_balance(
    pool: &PgPool,
    network: &NetworkConfig,
    storage_token_id: &str,
    raw_balance: &str,
) -> Result<BigDecimal, Box<dyn std::error::Error>> {
    let decimals = ensure_ft_metadata(pool, network, storage_token_id).await?;
    convert_raw_to_decimal(raw_balance, decimals)
}

/// A pending confidential swap intent that could match an observed deposit.
struct PendingIntent {
    payload_hash: String,
    correlation_id: Option<String>,
    destination_raw_token_id: String,
    expected_amount_out: BigDecimal,
}

/// Load pending shield intents for a DAO and decimal-adjust their expected
/// `amountOut` so they can be compared against observed balance increases.
async fn load_pending_intents(
    pool: &PgPool,
    network: &NetworkConfig,
    dao_id: &str,
) -> Result<Vec<PendingIntent>, Box<dyn std::error::Error>> {
    let rows = sqlx::query!(
        r#"
        SELECT payload_hash, correlation_id, quote_metadata
        FROM confidential_intents
        WHERE dao_id = $1
          AND status = 'submitted'
          AND intent_type = 'shield'
          AND updated_at >= NOW() - INTERVAL '24 hours'
        "#,
        dao_id,
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::new();
    for row in rows {
        let quote_metadata = match row.quote_metadata {
            Some(v) => v,
            None => continue,
        };
        let destination_raw = quote_metadata
            .get("quoteRequest")
            .and_then(|q| q.get("destinationAsset"))
            .and_then(|v| v.as_str());
        let recipient = quote_metadata
            .get("quoteRequest")
            .and_then(|q| q.get("recipient"))
            .and_then(|v| v.as_str());
        let amount_out_raw = quote_metadata
            .get("quote")
            .and_then(|q| q.get("amountOut"))
            .and_then(|v| v.as_str());

        let (Some(destination_raw), Some(recipient), Some(amount_out_raw)) =
            (destination_raw, recipient, amount_out_raw)
        else {
            continue;
        };
        if recipient != dao_id {
            continue;
        }

        let storage_id = to_storage_token_id(destination_raw);
        let decimals = match ensure_ft_metadata(pool, network, &storage_id).await {
            Ok(d) => d,
            Err(e) => {
                log::warn!(
                    "[confidential] {}: ensure_ft_metadata({}) failed: {}",
                    dao_id,
                    storage_id,
                    e
                );
                continue;
            }
        };
        let expected = match convert_raw_to_decimal(amount_out_raw, decimals) {
            Ok(a) => a,
            Err(e) => {
                log::warn!(
                    "[confidential] {}: convert_raw_to_decimal failed for {}: {}",
                    dao_id,
                    amount_out_raw,
                    e
                );
                continue;
            }
        };

        out.push(PendingIntent {
            payload_hash: row.payload_hash,
            correlation_id: row.correlation_id,
            destination_raw_token_id: destination_raw.to_string(),
            expected_amount_out: expected,
        });
    }
    Ok(out)
}

/// Find a pending intent whose destination token and expected `amountOut`
/// match the observed increase within `SWAP_MATCH_TOLERANCE`.
fn find_matching_intent<'a>(
    intents: &'a [PendingIntent],
    raw_token_id: &str,
    delta: &BigDecimal,
) -> Option<&'a PendingIntent> {
    use bigdecimal::ToPrimitive;
    let delta_f = delta.to_f64()?;
    if delta_f <= 0.0 {
        return None;
    }
    intents.iter().find(|intent| {
        if intent.destination_raw_token_id != raw_token_id {
            return false;
        }
        let Some(expected) = intent.expected_amount_out.to_f64() else {
            return false;
        };
        if expected <= 0.0 {
            return false;
        }
        ((delta_f - expected) / expected).abs() <= SWAP_MATCH_TOLERANCE
    })
}

/// Find the Goldsky-written outgoing balance_change for a matched payload_hash.
/// Returns `(id, receipt_id_first, tx_hash_first)` if present.
async fn lookup_deposit_leg(
    pool: &PgPool,
    account_id: &str,
    payload_hash: &str,
) -> Result<Option<(i64, Option<String>, Option<String>)>, sqlx::Error> {
    let row = sqlx::query!(
        r#"
        SELECT id, receipt_id, transaction_hashes
        FROM balance_changes
        WHERE account_id = $1
          AND raw_data->>'payload_hash' = $2
          AND amount < 0
        ORDER BY block_height DESC, id DESC
        LIMIT 1
        "#,
        account_id,
        payload_hash,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| {
        let receipt = r.receipt_id.into_iter().next();
        let tx = r.transaction_hashes.into_iter().next();
        (r.id, receipt, tx)
    }))
}

#[allow(clippy::too_many_arguments)]
async fn insert_detected_swap(
    pool: &PgPool,
    account_id: &str,
    solver_transaction_hash: &str,
    deposit_balance_change_id: Option<i64>,
    deposit_receipt_id: Option<&str>,
    fulfillment_balance_change_id: i64,
    fulfillment_receipt_id: &str,
    sent_token_storage_id: Option<&str>,
    sent_amount: Option<&BigDecimal>,
    received_token_storage_id: &str,
    received_amount: &BigDecimal,
    block_height: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        INSERT INTO detected_swaps (
            account_id,
            solver_transaction_hash,
            deposit_receipt_id,
            deposit_balance_change_id,
            fulfillment_receipt_id,
            fulfillment_balance_change_id,
            sent_token_id,
            sent_amount,
            received_token_id,
            received_amount,
            block_height
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (account_id, solver_transaction_hash) DO UPDATE SET
            deposit_balance_change_id     = COALESCE(detected_swaps.deposit_balance_change_id, EXCLUDED.deposit_balance_change_id),
            deposit_receipt_id            = COALESCE(detected_swaps.deposit_receipt_id, EXCLUDED.deposit_receipt_id),
            sent_token_id                 = COALESCE(detected_swaps.sent_token_id, EXCLUDED.sent_token_id),
            sent_amount                   = COALESCE(detected_swaps.sent_amount, EXCLUDED.sent_amount),
            fulfillment_balance_change_id = EXCLUDED.fulfillment_balance_change_id,
            fulfillment_receipt_id        = EXCLUDED.fulfillment_receipt_id,
            received_amount               = EXCLUDED.received_amount,
            block_height                  = EXCLUDED.block_height
        "#,
        account_id,
        solver_transaction_hash,
        deposit_receipt_id,
        deposit_balance_change_id,
        fulfillment_receipt_id,
        fulfillment_balance_change_id,
        sent_token_storage_id,
        sent_amount,
        received_token_storage_id,
        received_amount,
        block_height,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Poll confidential balances and record any **increases** as balance_change rows.
///
/// Decreases are ignored (Goldsky owns outgoing legs). When an increase matches
/// a pending `confidential_intents` quote (same destination token, `amountOut`
/// within 1%), a `detected_swaps` row is created linking this fulfillment to
/// the Goldsky-written deposit leg.
///
/// Returns the number of balance_change rows inserted.
pub async fn poll_confidential_balances(
    state: &AppState,
    account_id: &str,
    block_height: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    let account_id_ref: &near_account_id::AccountIdRef = account_id.try_into()?;
    let current_balances = match fetch_confidential_balances(state, account_id_ref).await {
        Ok(b) => b,
        Err((status, msg)) => {
            log::warn!(
                "[confidential] {}: fetch balances failed ({}): {}",
                account_id,
                status,
                msg
            );
            return Ok(0);
        }
    };

    let mut current_map: HashMap<String, (String, BigDecimal)> = HashMap::new();
    for (raw_id, raw_bal) in &current_balances {
        let storage_id = to_storage_token_id(raw_id);
        match adjust_balance(&state.db_pool, &state.network, &storage_id, raw_bal).await {
            Ok(adjusted) => {
                current_map.insert(storage_id, (raw_id.clone(), adjusted));
            }
            Err(e) => {
                log::warn!(
                    "[confidential] {}: adjust_balance({}): {}",
                    account_id,
                    raw_id,
                    e
                );
            }
        }
    }

    let known_tokens: Vec<(String, BigDecimal)> = sqlx::query_as(
        r#"
        SELECT DISTINCT ON (token_id) token_id, balance_after
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
        ORDER BY token_id, block_height DESC, id DESC
        "#,
    )
    .bind(account_id)
    .fetch_all(&state.db_pool)
    .await?;
    let known_map: HashMap<String, BigDecimal> = known_tokens.into_iter().collect();

    let pending_intents = match load_pending_intents(&state.db_pool, &state.network, account_id)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "[confidential] {}: load_pending_intents failed: {} — continuing without swap match",
                account_id,
                e
            );
            Vec::new()
        }
    };

    let now = Utc::now();
    let block_timestamp = now.timestamp_nanos_opt().unwrap_or(0);
    let zero = BigDecimal::from(0);
    let mut inserted = 0usize;

    for (storage_token_id, (raw_token_id, current_balance)) in &current_map {
        let last_balance = known_map.get(storage_token_id).unwrap_or(&zero);

        if current_balance <= last_balance {
            if current_balance < last_balance {
                log::debug!(
                    "[confidential] {}/{}: ignoring decrease {} → {} (Goldsky owns outgoing)",
                    account_id,
                    storage_token_id,
                    last_balance,
                    current_balance,
                );
            }
            continue;
        }

        let delta = current_balance - last_balance;

        let matched = find_matching_intent(&pending_intents, raw_token_id, &delta);

        // Counterparty convention:
        //   - matched swap fulfillment → "intents.near" (mirrors the public
        //     intents pipeline in swap_detector.rs so the UI treats public
        //     and confidential swaps the same way)
        //   - unmatched direct deposit → NULL (unknown external source)
        let (counterparty, raw_data): (Option<&str>, Value) = match &matched {
            Some(intent) => (
                Some("intents.near"),
                serde_json::json!({
                    "payload_hash": intent.payload_hash,
                    "correlation_id": intent.correlation_id,
                    "source": "1click-poll",
                }),
            ),
            None => (None, serde_json::json!({ "source": "1click-poll" })),
        };

        let new_id = insert_confidential_balance_change(
            &state.db_pool,
            account_id,
            storage_token_id,
            block_height,
            block_timestamp,
            now,
            &delta,
            last_balance,
            current_balance,
            counterparty,
            &raw_data,
        )
        .await?;
        inserted += 1;

        log::info!(
            "[confidential] {}/{}: {} → {} (Δ{}) {}",
            account_id,
            storage_token_id,
            last_balance,
            current_balance,
            delta,
            if matched.is_some() {
                "SWAP_IN"
            } else {
                "DEPOSIT"
            },
        );

        if let Some(intent) = matched {
            let deposit_leg =
                lookup_deposit_leg(&state.db_pool, account_id, &intent.payload_hash).await?;
            let (deposit_id, deposit_receipt, deposit_tx) = match deposit_leg {
                Some((id, r, t)) => (Some(id), r, t),
                None => (None, None, None),
            };

            let sent_token_storage = deposit_tx.as_ref().and({
                // Look up the Goldsky row's token_id for accuracy
                None::<String>
            });
            // The solver_transaction_hash field is UNIQUE per (account_id, hash).
            // With no on-chain tx for the solver settlement, use the correlation_id
            // as a synthetic key so the unique constraint still discriminates.
            let synthetic_tx_hash = intent
                .correlation_id
                .clone()
                .unwrap_or_else(|| format!("1click:{}", intent.payload_hash));
            let fulfillment_receipt = format!("1click:{}", intent.payload_hash);

            // Resolve the sent-token storage id from the Goldsky row, if available.
            let sent_token_resolved = if let Some(id) = deposit_id {
                sqlx::query_scalar!("SELECT token_id FROM balance_changes WHERE id = $1", id)
                    .fetch_optional(&state.db_pool)
                    .await
                    .ok()
                    .flatten()
                    .flatten()
            } else {
                None
            };
            let sent_amount_resolved = if let Some(id) = deposit_id {
                sqlx::query_scalar!("SELECT amount FROM balance_changes WHERE id = $1", id)
                    .fetch_optional(&state.db_pool)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };

            if let Err(e) = insert_detected_swap(
                &state.db_pool,
                account_id,
                &synthetic_tx_hash,
                deposit_id,
                deposit_receipt.as_deref(),
                new_id,
                &fulfillment_receipt,
                sent_token_resolved
                    .as_deref()
                    .or(sent_token_storage.as_deref()),
                sent_amount_resolved.as_ref(),
                storage_token_id,
                &delta,
                block_height,
            )
            .await
            {
                log::warn!(
                    "[confidential] {}: insert_detected_swap for payload_hash={}: {}",
                    account_id,
                    intent.payload_hash,
                    e
                );
            }
        }
    }

    if inserted > 0 {
        log::info!(
            "[confidential] {}: Recorded {} balance changes",
            account_id,
            inserted
        );
    }

    Ok(inserted)
}

/// Insert a single balance_change row for a confidential deposit or swap fulfillment.
#[allow(clippy::too_many_arguments)]
async fn insert_confidential_balance_change(
    pool: &PgPool,
    account_id: &str,
    token_id: &str,
    block_height: i64,
    block_timestamp: i64,
    block_time: chrono::DateTime<Utc>,
    amount: &BigDecimal,
    balance_before: &BigDecimal,
    balance_after: &BigDecimal,
    counterparty: Option<&str>,
    raw_data: &Value,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time,
         amount, balance_before, balance_after,
         transaction_hashes, receipt_id, signer_id, receiver_id,
         counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (account_id, block_height, token_id) DO UPDATE SET
          amount = EXCLUDED.amount,
          balance_before = EXCLUDED.balance_before,
          balance_after = EXCLUDED.balance_after,
          counterparty = EXCLUDED.counterparty,
          raw_data = EXCLUDED.raw_data,
          updated_at = NOW()
        RETURNING id
        "#,
        account_id,
        token_id,
        block_height,
        block_timestamp,
        block_time,
        amount,
        balance_before,
        balance_after,
        &Vec::<String>::new() as &[String],
        &Vec::<String>::new() as &[String],
        None::<String>,
        None::<String>,
        counterparty.unwrap_or(""),
        serde_json::json!({}),
        raw_data,
        "TRANSFER",
        None::<String>,
    )
    .fetch_one(pool)
    .await?;
    Ok(row.id)
}

/// Run one poll cycle: fetch the current chain head, then poll every
/// enabled confidential DAO's 1Click balances once.
pub async fn run_confidential_poll_cycle(
    state: &AppState,
) -> Result<(), Box<dyn std::error::Error>> {
    let accounts: Vec<(String,)> = sqlx::query_as(
        "SELECT account_id FROM monitored_accounts WHERE enabled = true AND is_confidential_account = true",
    )
    .fetch_all(&state.db_pool)
    .await?;

    if accounts.is_empty() {
        return Ok(());
    }

    let block_height = match Chain::block().fetch_from(&state.network).await {
        Ok(b) => b.header.height as i64,
        Err(e) => {
            log::warn!(
                "[confidential-poll] could not fetch chain head: {} — using 0",
                e
            );
            0
        }
    };

    for (account_id,) in &accounts {
        match poll_confidential_balances(state, account_id, block_height).await {
            Ok(n) if n > 0 => {
                log::info!(
                    "[confidential-poll] {}: recorded {} balance changes",
                    account_id,
                    n
                );
            }
            Err(e) => {
                log::warn!("[confidential-poll] {}: poll failed: {}", account_id, e);
            }
            _ => {}
        }
    }

    Ok(())
}

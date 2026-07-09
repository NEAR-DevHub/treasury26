use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use bigdecimal::BigDecimal;
use futures::StreamExt;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::cursors::clear_gold_dirty_if_not_advanced;
use super::models::{
    GoldLedger, GoldProjectionCycleStats, GoldProjectionResult, GoldPublicHistoryEvent,
    PublicHistoryEventStatus,
};
use super::repository::{
    clear_projection_error, delete_stale_gold_rows, earliest_pending_exchange_time,
    earliest_silver_time, has_gold_before, load_dirty_accounts, load_silver_suffix,
    seed_ledger_before, upsert_gold_event, upsert_projection_error,
};
use crate::handlers::public_history::silver::models::{
    PublicTransactionType, PublicTransferDirection, PublicTransferLegKind, SilverTransferLegRow,
};
use crate::services::TokenPriceService;

const PUBLIC_GOLD_WORKERS: usize = 4;

/// The NEAR runtime's implicit account; sender of gas-fee reward refunds
/// credited to contract accounts (~0.0001 NEAR per contract call).
const SYSTEM_ACCOUNT: &str = "system";

struct ExchangePairs {
    outgoing_to_incoming: HashMap<i64, i64>,
    incoming_to_outgoing: HashMap<i64, i64>,
}

#[derive(Debug, Clone, Default)]
struct ParsedQuoteStatus {
    near_tx_hashes: HashSet<String>,
    destination_chain_tx_hashes: HashSet<String>,
    origin_asset: Option<String>,
    destination_asset: Option<String>,
    amount_in_raw: Option<BigDecimal>,
    amount_out_raw: Option<BigDecimal>,
    amount_sent_usd: Option<BigDecimal>,
    amount_received_usd: Option<BigDecimal>,
    status: Option<String>,
}

impl ParsedQuoteStatus {
    fn fulfillment_hashes(&self) -> impl Iterator<Item = &String> {
        self.near_tx_hashes
            .iter()
            .chain(self.destination_chain_tx_hashes.iter())
    }

    fn has_fulfillment_hashes(&self) -> bool {
        !self.near_tx_hashes.is_empty() || !self.destination_chain_tx_hashes.is_empty()
    }

    fn is_failed_terminal(&self) -> bool {
        matches!(
            self.status.as_deref(),
            Some("failed") | Some("refunded") | Some("failure")
        )
    }
}

struct PendingExchange {
    outgoing: SilverTransferLegRow,
    token_out_balance_before: BigDecimal,
    token_out_balance_after: BigDecimal,
}

fn choose_recompute_from(
    earliest: chrono::DateTime<chrono::Utc>,
    cursor_recompute_from: Option<chrono::DateTime<chrono::Utc>>,
    has_prior_gold: bool,
) -> chrono::DateTime<chrono::Utc> {
    let recompute_from = cursor_recompute_from.unwrap_or(earliest);
    // If this account has no earlier gold seed, start at bronze/silver origin
    // so balances do not silently begin from zero mid-history.
    if earliest < recompute_from && !has_prior_gold {
        earliest
    } else {
        recompute_from
    }
}

fn widen_for_pending_exchange(
    recompute_from: chrono::DateTime<chrono::Utc>,
    earliest_pending: Option<chrono::DateTime<chrono::Utc>>,
) -> chrono::DateTime<chrono::Utc> {
    // Pending exchanges can complete after the dirty window. Recompute from the
    // outgoing leg so the final exchange row can replace the pending row.
    match earliest_pending {
        Some(earliest_pending) if earliest_pending < recompute_from => earliest_pending,
        _ => recompute_from,
    }
}

fn collect_string_array(value: &Value, key: &str, out: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            for (item_key, item_value) in map {
                if item_key == key
                    && let Some(values) = item_value.as_array()
                {
                    for value in values {
                        if let Some(value) = value.as_str() {
                            out.insert(value.to_string());
                        } else if let Some(value) = value.get("hash").and_then(Value::as_str) {
                            out.insert(value.to_string());
                        }
                    }
                }
                collect_string_array(item_value, key, out);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_string_array(value, key, out);
            }
        }
        _ => {}
    }
}

fn find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(value) = map.get(key).and_then(Value::as_str) {
                return Some(value.to_string());
            }
            for value in map.values() {
                if let Some(value) = find_string(value, key) {
                    return Some(value);
                }
            }
            None
        }
        Value::Array(values) => values.iter().find_map(|value| find_string(value, key)),
        _ => None,
    }
}

fn find_path_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_str().map(ToString::to_string)
}

fn find_path_decimal(value: &Value, path: &[&str]) -> Option<BigDecimal> {
    find_path_string(value, path).and_then(|value| value.parse().ok())
}

fn quote_usd_change(quote: Option<&ParsedQuoteStatus>) -> Option<BigDecimal> {
    let quote = quote?;
    Some(quote.amount_received_usd.as_ref()? - quote.amount_sent_usd.as_ref()?)
}

fn parse_quote_status(raw: Option<&Value>) -> Option<ParsedQuoteStatus> {
    let raw = raw?;
    let mut near_tx_hashes = HashSet::new();
    let mut destination_chain_tx_hashes = HashSet::new();
    collect_string_array(raw, "nearTxHashes", &mut near_tx_hashes);
    collect_string_array(
        raw,
        "destinationChainTxHashes",
        &mut destination_chain_tx_hashes,
    );

    Some(ParsedQuoteStatus {
        near_tx_hashes,
        destination_chain_tx_hashes,
        origin_asset: find_string(raw, "originAsset"),
        destination_asset: find_string(raw, "destinationAsset"),
        amount_in_raw: find_path_string(raw, &["swapDetails", "amountIn"])
            .or_else(|| find_string(raw, "amountIn"))
            .and_then(|value| value.parse().ok()),
        // Only use fulfilled amountOut when 1Click reports actual swap details. Quote amountOut
        // can differ from the final received amount because of slippage.
        amount_out_raw: find_path_string(raw, &["swapDetails", "amountOut"])
            .and_then(|value| value.parse().ok()),
        amount_sent_usd: find_path_decimal(raw, &["swapDetails", "amountInUsd"])
            .or_else(|| find_path_decimal(raw, &["quoteResponse", "quote", "amountInUsd"])),
        amount_received_usd: find_path_decimal(raw, &["swapDetails", "amountOutUsd"])
            .or_else(|| find_path_decimal(raw, &["quoteResponse", "quote", "amountOutUsd"])),
        status: find_string(raw, "status").map(|status| status.to_ascii_lowercase()),
    })
}

fn quote_asset_matches_token(quote_asset: &str, token_id: &str) -> bool {
    if quote_asset == token_id {
        return true;
    }

    let quote_asset = quote_asset.trim();
    let token_id = token_id.trim();

    if quote_asset.eq_ignore_ascii_case("near") {
        return matches!(
            token_id,
            "near" | "wrap.near" | "intents.near:nep141:wrap.near"
        );
    }

    if let Some(raw_nep141) = quote_asset.strip_prefix("nep141:") {
        if raw_nep141 == token_id || format!("intents.near:{quote_asset}") == token_id {
            return true;
        }
        if raw_nep141 == "wrap.near" {
            return matches!(
                token_id,
                "near" | "wrap.near" | "intents.near:nep141:wrap.near"
            );
        }
    }

    token_id
        .strip_prefix("intents.near:")
        .is_some_and(|suffix| suffix == quote_asset)
}

fn quote_amount_matches(expected: Option<&BigDecimal>, actual_raw: &BigDecimal) -> bool {
    expected.is_none_or(|expected| expected == actual_raw)
}

fn leg_direction(leg: &SilverTransferLegRow) -> Result<PublicTransferDirection, String> {
    PublicTransferDirection::from_db(&leg.direction)
}

fn leg_kind(leg: &SilverTransferLegRow) -> Result<PublicTransferLegKind, String> {
    PublicTransferLegKind::from_db(&leg.leg_kind)
}

/// Native NEAR movements that are relayer/protocol noise, never real
/// treasury activity: proposal-storage top-ups & bonds fronted by the
/// sponsor, and gas-fee rewards credited by `system`. Hidden from the
/// public history feed to match `balance_changes`.
fn is_noise_native_movement(leg: &SilverTransferLegRow, relayer_account: &str) -> bool {
    if leg.token_standard != "native" {
        return false;
    }
    matches!(
        leg.counterparty.as_deref(),
        Some(cp) if cp == relayer_account || cp == SYSTEM_ACCOUNT
    )
}

fn is_projectable_transfer(
    leg: &SilverTransferLegRow,
    relayer_account: &str,
) -> Result<bool, String> {
    if is_noise_native_movement(leg, relayer_account) {
        return Ok(false);
    }
    let direction = leg_direction(leg)?;
    let kind = leg_kind(leg)?;
    let is_nep245 = leg.token_standard == "nep245";
    Ok(direction != PublicTransferDirection::Internal
        && (is_nep245
            || !matches!(
                kind,
                PublicTransferLegKind::Mint | PublicTransferLegKind::Burn
            )))
}

fn is_quote_matched_exchange_deposit(
    leg: &SilverTransferLegRow,
    quote: Option<&ParsedQuoteStatus>,
    relayer_account: &str,
) -> Result<bool, String> {
    if !is_projectable_transfer(leg, relayer_account)?
        || leg_direction(leg)? != PublicTransferDirection::Outgoing
    {
        return Ok(false);
    }
    let Some(quote_deposit_address) = leg.quote_deposit_address.as_deref() else {
        return Ok(false);
    };
    // A quote-linked exchange starts as a proposal payment to the quote deposit
    // address; ordinary transfers to intents.near should stay regular sends.
    if leg.proposal_ref.is_none() || leg.counterparty.as_deref() != Some(quote_deposit_address) {
        return Ok(false);
    }
    if let Some(origin_asset) = quote.and_then(|quote| quote.origin_asset.as_deref())
        && !quote_asset_matches_token(origin_asset, &leg.token_id)
    {
        return Ok(false);
    }
    if let Some(quote) = quote
        && !quote_amount_matches(quote.amount_in_raw.as_ref(), &leg.amount_raw)
    {
        return Ok(false);
    }
    Ok(true)
}

fn is_exchange_fulfillment_candidate(
    leg: &SilverTransferLegRow,
    relayer_account: &str,
) -> Result<bool, String> {
    if !is_projectable_transfer(leg, relayer_account)?
        || leg_direction(leg)? != PublicTransferDirection::Incoming
    {
        return Ok(false);
    }
    Ok(leg.counterparty.as_deref() == Some("intents.near")
        || leg.token_id.starts_with("intents.near:"))
}

fn incoming_matches_quote(
    incoming: &SilverTransferLegRow,
    quote: Option<&ParsedQuoteStatus>,
) -> bool {
    let Some(quote) = quote else {
        return true;
    };
    if let Some(destination_asset) = quote.destination_asset.as_deref()
        && !quote_asset_matches_token(destination_asset, &incoming.token_id)
    {
        return false;
    }
    quote_amount_matches(quote.amount_out_raw.as_ref(), &incoming.amount_raw)
}

fn build_quote_map(rows: &[SilverTransferLegRow]) -> HashMap<i64, ParsedQuoteStatus> {
    let mut quotes = HashMap::new();
    for row in rows {
        let Some(proposal_ref) = row.proposal_ref else {
            continue;
        };
        if quotes.contains_key(&proposal_ref) {
            continue;
        }
        if let Some(quote) = parse_quote_status(row.quote_metadata.as_ref()) {
            quotes.insert(proposal_ref, quote);
        }
    }
    quotes
}

fn plan_exchange_pairs(
    rows: &[SilverTransferLegRow],
    relayer_account: &str,
) -> Result<ExchangePairs, String> {
    let quote_by_proposal_ref = build_quote_map(rows);
    let mut incoming_by_tx_hash: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        if is_exchange_fulfillment_candidate(row, relayer_account)?
            && let Some(tx_hash) = row.transaction_hash.as_ref()
        {
            incoming_by_tx_hash
                .entry(tx_hash.clone())
                .or_default()
                .push(index);
        }
    }

    let mut fallback_pending_outgoing: VecDeque<i64> = VecDeque::new();
    let mut by_id: HashMap<i64, &SilverTransferLegRow> = HashMap::new();
    let mut outgoing_to_incoming = HashMap::new();
    let mut incoming_to_outgoing = HashMap::new();
    let mut matched_incoming_ids = HashSet::new();

    for row in rows {
        by_id.insert(row.id, row);
        let quote = row
            .proposal_ref
            .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
        if !is_quote_matched_exchange_deposit(row, quote, relayer_account)? {
            continue;
        }

        // Prefer explicit fulfillment hashes from the quote payload; they avoid
        // pairing a deposit with an unrelated incoming intents transfer.
        if let Some(quote) = quote
            && quote.has_fulfillment_hashes()
        {
            let matched_incoming = quote.fulfillment_hashes().find_map(|tx_hash| {
                incoming_by_tx_hash.get(tx_hash).and_then(|indices| {
                    indices.iter().find_map(|index| {
                        let incoming = rows.get(*index)?;
                        (!matched_incoming_ids.contains(&incoming.id)
                            && incoming.account_id == row.account_id
                            && incoming.block_time >= row.block_time
                            && incoming_matches_quote(incoming, Some(quote)))
                        .then_some(incoming.id)
                    })
                })
            });

            if let Some(incoming_id) = matched_incoming {
                outgoing_to_incoming.insert(row.id, incoming_id);
                incoming_to_outgoing.insert(incoming_id, row.id);
                matched_incoming_ids.insert(incoming_id);
            }
            continue;
        }

        // Some historical quote payloads lack fulfillment hashes. Keep them as
        // pending candidates and match by account/time/asset/amount later.
        fallback_pending_outgoing.push_back(row.id);
    }

    for row in rows {
        if matched_incoming_ids.contains(&row.id)
            || !is_exchange_fulfillment_candidate(row, relayer_account)?
        {
            continue;
        }
        let matched =
            fallback_pending_outgoing
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, outgoing_id)| {
                    let outgoing = by_id.get(outgoing_id)?;
                    let quote = outgoing
                        .proposal_ref
                        .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
                    (outgoing.account_id == row.account_id
                        && outgoing.block_time <= row.block_time
                        && incoming_matches_quote(row, quote))
                    .then_some((index, *outgoing_id))
                });
        if let Some((index, outgoing_id)) = matched {
            fallback_pending_outgoing.remove(index);
            outgoing_to_incoming.insert(outgoing_id, row.id);
            incoming_to_outgoing.insert(row.id, outgoing_id);
            matched_incoming_ids.insert(row.id);
        }
    }

    Ok(ExchangePairs {
        outgoing_to_incoming,
        incoming_to_outgoing,
    })
}

/// USD value of a leg's decimal-adjusted amount at the event time. Lookup
/// failures degrade to None (NULL in gold) rather than failing projection.
async fn leg_amount_usd(
    token_prices: &TokenPriceService,
    leg: &SilverTransferLegRow,
    event_time: chrono::DateTime<chrono::Utc>,
) -> Option<BigDecimal> {
    match token_prices
        .price_for_valuation(&leg.token_id, event_time)
        .await
    {
        Ok(price) => price.map(|price| &leg.amount * price),
        Err(e) => {
            tracing::warn!(
                token_id = %leg.token_id,
                error = %e,
                "price lookup failed for gold usd valuation"
            );
            None
        }
    }
}

async fn public_gold_event_from_leg(
    leg: &SilverTransferLegRow,
    ledger: &mut GoldLedger,
    token_prices: &TokenPriceService,
    relayer_account: &str,
) -> Result<Option<GoldPublicHistoryEvent>, String> {
    let direction = leg_direction(leg)?;
    if !is_projectable_transfer(leg, relayer_account)? {
        return Ok(None);
    }

    let event_time = leg.proposal_executed_at.unwrap_or(leg.block_time);
    let gold_event_key = format!("silver-leg:{}", leg.leg_key);

    match direction {
        PublicTransferDirection::Incoming => {
            let amount_in_usd = leg_amount_usd(token_prices, leg, event_time).await;
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
                amount_in_usd,
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
                status: PublicHistoryEventStatus::Success,
                raw_payload: leg.raw_payload.clone(),
            }))
        }
        PublicTransferDirection::Outgoing => {
            let amount_out_usd = leg_amount_usd(token_prices, leg, event_time).await;
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
                amount_out_usd,
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
                status: PublicHistoryEventStatus::Success,
                raw_payload: leg.raw_payload.clone(),
            }))
        }
        PublicTransferDirection::Internal => Ok(None),
    }
}

fn pending_exchange_event_from_leg(
    pending: &PendingExchange,
    quote: Option<&ParsedQuoteStatus>,
) -> Result<GoldPublicHistoryEvent, String> {
    let leg = &pending.outgoing;
    let status = if quote.is_some_and(ParsedQuoteStatus::is_failed_terminal) {
        PublicHistoryEventStatus::Failed
    } else {
        PublicHistoryEventStatus::Pending
    };
    let amount_in_usd = quote.and_then(|quote| quote.amount_received_usd.clone());
    let amount_out_usd = quote.and_then(|quote| quote.amount_sent_usd.clone());
    let usd_change = quote_usd_change(quote);

    Ok(GoldPublicHistoryEvent {
        gold_event_key: format!("silver-leg:{}", leg.leg_key),
        primary_transfer_leg_id: leg.id,
        counter_transfer_leg_id: None,
        proposal_ref: leg.proposal_ref,
        dao_id: leg.account_id.clone(),
        transaction_type: PublicTransactionType::Exchange,
        token_in: None,
        token_out: Some(leg.token_id.clone()),
        amount_in: None,
        amount_out: Some(leg.amount.clone()),
        amount_in_usd,
        amount_out_usd,
        usd_change,
        token_in_balance_before: None,
        token_in_balance_after: None,
        token_out_balance_before: Some(pending.token_out_balance_before.clone()),
        token_out_balance_after: Some(pending.token_out_balance_after.clone()),
        recipient: leg.counterparty.clone(),
        counterparty: leg.counterparty.clone(),
        refund_to: None,
        transaction_hash: leg.transaction_hash.clone(),
        receipt_id: leg.receipt_id.clone(),
        block_height: Some(leg.block_height),
        event_time: leg.proposal_executed_at.unwrap_or(leg.block_time),
        proposal_id: leg.proposal_id,
        proposal_status: leg.proposal_status.clone(),
        proposal_created_at: leg.proposal_created_at,
        proposal_executed_at: leg.proposal_executed_at,
        proposal_execution_block_height: leg.proposal_execution_block_height,
        proposal_execution_transaction_hash: leg.proposal_execution_transaction_hash.clone(),
        status,
        raw_payload: serde_json::json!({
            "classification": "quote_matched_exchange_pending",
            "quote_metadata": leg.quote_metadata.clone(),
            "outgoing_leg": leg.raw_payload.clone(),
        }),
    })
}

fn completed_exchange_event_from_legs(
    pending: &PendingExchange,
    incoming: &SilverTransferLegRow,
    quote: Option<&ParsedQuoteStatus>,
    ledger: &mut GoldLedger,
) -> GoldPublicHistoryEvent {
    let outgoing = &pending.outgoing;
    let (token_in_balance_before, token_in_balance_after) =
        ledger.apply_in(&incoming.token_id, &incoming.amount);
    let amount_in_usd = quote.and_then(|quote| quote.amount_received_usd.clone());
    let amount_out_usd = quote.and_then(|quote| quote.amount_sent_usd.clone());
    let usd_change = quote_usd_change(quote);

    GoldPublicHistoryEvent {
        gold_event_key: format!("silver-leg:{}", outgoing.leg_key),
        primary_transfer_leg_id: outgoing.id,
        counter_transfer_leg_id: Some(incoming.id),
        proposal_ref: outgoing.proposal_ref,
        dao_id: outgoing.account_id.clone(),
        transaction_type: PublicTransactionType::Exchange,
        token_in: Some(incoming.token_id.clone()),
        token_out: Some(outgoing.token_id.clone()),
        amount_in: Some(incoming.amount.clone()),
        amount_out: Some(outgoing.amount.clone()),
        amount_in_usd,
        amount_out_usd,
        usd_change,
        token_in_balance_before: Some(token_in_balance_before),
        token_in_balance_after: Some(token_in_balance_after),
        token_out_balance_before: Some(pending.token_out_balance_before.clone()),
        token_out_balance_after: Some(pending.token_out_balance_after.clone()),
        recipient: Some(incoming.account_id.clone()),
        counterparty: outgoing.counterparty.clone(),
        refund_to: None,
        transaction_hash: outgoing.transaction_hash.clone(),
        receipt_id: outgoing.receipt_id.clone(),
        block_height: Some(outgoing.block_height),
        event_time: outgoing.proposal_executed_at.unwrap_or(outgoing.block_time),
        proposal_id: outgoing.proposal_id,
        proposal_status: outgoing.proposal_status.clone(),
        proposal_created_at: outgoing.proposal_created_at,
        proposal_executed_at: outgoing.proposal_executed_at,
        proposal_execution_block_height: outgoing.proposal_execution_block_height,
        proposal_execution_transaction_hash: outgoing.proposal_execution_transaction_hash.clone(),
        status: PublicHistoryEventStatus::Success,
        raw_payload: serde_json::json!({
            "classification": "quote_matched_exchange_success",
            "quote_metadata": outgoing.quote_metadata.clone(),
            "outgoing_leg": outgoing.raw_payload.clone(),
            "incoming_leg": incoming.raw_payload.clone(),
        }),
    }
}

async fn persist_completed_exchange(
    tx: &mut Transaction<'_, Postgres>,
    pending: PendingExchange,
    incoming: &SilverTransferLegRow,
    quote_by_proposal_ref: &HashMap<i64, ParsedQuoteStatus>,
    ledger: &mut GoldLedger,
    preserve_keys: &mut HashSet<String>,
    stats: &mut GoldProjectionResult,
) -> Result<(), sqlx::Error> {
    let quote = pending
        .outgoing
        .proposal_ref
        .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
    let outgoing_id = pending.outgoing.id;
    let event = completed_exchange_event_from_legs(&pending, incoming, quote, ledger);
    preserve_keys.insert(event.gold_event_key.clone());
    upsert_gold_event(tx, &event).await?;
    clear_projection_error(tx, outgoing_id).await?;
    clear_projection_error(tx, incoming.id).await?;
    stats.rows_projected += 1;
    Ok(())
}

pub async fn project_public_gold_for_account(
    pool: &PgPool,
    token_prices: &TokenPriceService,
    account_id: &str,
    relayer_account: &str,
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

    let initial_recompute_from = cursor_recompute_from.unwrap_or(earliest);
    let has_prior_gold = if earliest < initial_recompute_from {
        has_gold_before(&mut tx, account_id, initial_recompute_from).await?
    } else {
        true
    };
    let recompute_from = choose_recompute_from(earliest, cursor_recompute_from, has_prior_gold);
    let earliest_pending = earliest_pending_exchange_time(&mut tx, account_id).await?;
    let widened_recompute_from = widen_for_pending_exchange(recompute_from, earliest_pending);
    if widened_recompute_from < recompute_from {
        tracing::debug!(
            account_id = account_id,
            recompute_from = %widened_recompute_from,
            previous_recompute_from = %recompute_from,
            "public gold recompute widened for pending exchange"
        );
    }
    let recompute_from = widened_recompute_from;

    let seed_rows = seed_ledger_before(&mut tx, account_id, recompute_from).await?;
    let mut ledger = GoldLedger::from_seed(seed_rows);
    let rows = load_silver_suffix(&mut tx, account_id, recompute_from).await?;
    let quote_by_proposal_ref = build_quote_map(&rows);
    let exchange_pairs = match plan_exchange_pairs(&rows, relayer_account) {
        Ok(pairs) => pairs,
        Err(reason) => {
            for row in &rows {
                upsert_projection_error(&mut tx, row.id, account_id, &reason, &row.raw_payload)
                    .await?;
            }
            clear_gold_dirty_if_not_advanced(&mut tx, account_id, dirty_since).await?;
            tx.commit().await?;
            return Ok(GoldProjectionResult {
                errors_written: rows.len() as u64,
                ..GoldProjectionResult::default()
            });
        }
    };
    let mut preserve_keys: HashSet<String> = HashSet::new();
    let mut pending_exchanges: HashMap<i64, PendingExchange> = HashMap::new();
    let mut deferred_incoming: HashMap<i64, SilverTransferLegRow> = HashMap::new();
    let mut stats = GoldProjectionResult::default();

    for leg in rows {
        let quote = leg
            .proposal_ref
            .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
        if is_quote_matched_exchange_deposit(&leg, quote, relayer_account).unwrap_or(false) {
            let (before, after) = ledger.apply_out(&leg.token_id, &leg.amount);
            let pending = PendingExchange {
                outgoing: leg.clone(),
                token_out_balance_before: before,
                token_out_balance_after: after,
            };

            if exchange_pairs.outgoing_to_incoming.contains_key(&leg.id) {
                pending_exchanges.insert(leg.id, pending);
                if let Some(incoming) = deferred_incoming.remove(&leg.id)
                    && let Some(pending) = pending_exchanges.remove(&leg.id)
                {
                    persist_completed_exchange(
                        &mut tx,
                        pending,
                        &incoming,
                        &quote_by_proposal_ref,
                        &mut ledger,
                        &mut preserve_keys,
                        &mut stats,
                    )
                    .await?;
                }
            } else {
                match pending_exchange_event_from_leg(&pending, quote) {
                    Ok(event) => {
                        preserve_keys.insert(event.gold_event_key.clone());
                        upsert_gold_event(&mut tx, &event).await?;
                        clear_projection_error(&mut tx, leg.id).await?;
                        stats.rows_projected += 1;
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
            continue;
        }

        if let Some(outgoing_id) = exchange_pairs.incoming_to_outgoing.get(&leg.id) {
            if let Some(pending) = pending_exchanges.remove(outgoing_id) {
                persist_completed_exchange(
                    &mut tx,
                    pending,
                    &leg,
                    &quote_by_proposal_ref,
                    &mut ledger,
                    &mut preserve_keys,
                    &mut stats,
                )
                .await?;
            } else {
                deferred_incoming.insert(*outgoing_id, leg);
            }
            continue;
        }

        match public_gold_event_from_leg(&leg, &mut ledger, token_prices, relayer_account).await {
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
                upsert_projection_error(&mut tx, leg.id, account_id, &reason, &leg.raw_payload)
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
    token_prices: &Arc<TokenPriceService>,
    relayer_account: &str,
) -> Result<GoldProjectionCycleStats, sqlx::Error> {
    let dirty_accounts = load_dirty_accounts(pool).await?;
    let accounts_seen = dirty_accounts.len();

    let mut stream = futures::stream::iter(dirty_accounts.into_iter().map(|account| {
        let pool = pool.clone();
        let token_prices = Arc::clone(token_prices);
        let relayer_account = relayer_account.to_string();
        async move {
            let account_id = account.account_id;
            let result = project_public_gold_for_account(
                &pool,
                &token_prices,
                &account_id,
                &relayer_account,
            )
            .await;
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
                if account_stats.rows_projected > 0 || account_stats.rows_deleted > 0 {
                    stats.changed_accounts.push(account_id);
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_RELAYER_ACCOUNT: &str = "relayer.test.near";

    fn decimal(value: &str) -> BigDecimal {
        value.parse().expect("valid decimal")
    }

    fn leg(token_standard: &str, counterparty: Option<&str>, amount: &str) -> SilverTransferLegRow {
        SilverTransferLegRow {
            id: 1,
            account_id: "dao.near".to_string(),
            leg_key: "leg-1".to_string(),
            proposal_ref: None,
            proposal_id: None,
            transaction_hash: None,
            receipt_id: None,
            block_height: 1,
            block_time: chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap(),
            token_standard: token_standard.to_string(),
            token_id: if token_standard == "native" {
                "near".to_string()
            } else {
                "usdt.tether-token.near".to_string()
            },
            direction: "incoming".to_string(),
            counterparty: counterparty.map(str::to_string),
            amount_raw: decimal(amount),
            amount: decimal(amount),
            decimals: 24,
            leg_kind: "transfer".to_string(),
            raw_payload: serde_json::json!({}),
            proposal_status: None,
            proposal_created_at: None,
            proposal_executed_at: None,
            proposal_execution_block_height: None,
            proposal_execution_transaction_hash: None,
            quote_metadata: None,
            quote_deposit_address: None,
        }
    }

    #[test]
    fn sponsor_storage_topup_is_noise() {
        // ~0.03 NEAR storage top-up from the relayer.
        let row = leg("native", Some(TEST_RELAYER_ACCOUNT), "0.03");
        assert!(is_noise_native_movement(&row, TEST_RELAYER_ACCOUNT));
        assert!(!is_projectable_transfer(&row, TEST_RELAYER_ACCOUNT).unwrap());
    }

    #[test]
    fn sponsor_bond_is_noise_regardless_of_amount() {
        // Legacy proposal bond fronted by the relayer, well above any dust threshold.
        let row = leg("native", Some(TEST_RELAYER_ACCOUNT), "1.1");
        assert!(is_noise_native_movement(&row, TEST_RELAYER_ACCOUNT));
        assert!(!is_projectable_transfer(&row, TEST_RELAYER_ACCOUNT).unwrap());
    }

    #[test]
    fn system_gas_reward_is_noise() {
        let row = leg("native", Some(SYSTEM_ACCOUNT), "0.0001");
        assert!(is_noise_native_movement(&row, TEST_RELAYER_ACCOUNT));
        assert!(!is_projectable_transfer(&row, TEST_RELAYER_ACCOUNT).unwrap());
    }

    #[test]
    fn real_user_native_deposit_is_kept() {
        let row = leg("native", Some("alice.near"), "0.001");
        assert!(!is_noise_native_movement(&row, TEST_RELAYER_ACCOUNT));
        assert!(is_projectable_transfer(&row, TEST_RELAYER_ACCOUNT).unwrap());
    }

    #[test]
    fn non_native_leg_from_sponsor_is_kept() {
        // Native-only guard: FT legs are never treated as native noise.
        let row = leg("nep141", Some(TEST_RELAYER_ACCOUNT), "5");
        assert!(!is_noise_native_movement(&row, TEST_RELAYER_ACCOUNT));
        assert!(is_projectable_transfer(&row, TEST_RELAYER_ACCOUNT).unwrap());
    }

    #[test]
    fn nep245_mint_is_projectable() {
        let mut row = leg("nep245", None, "0.1");
        row.direction = "incoming".to_string();
        row.leg_kind = "mint".to_string();
        assert!(is_projectable_transfer(&row, TEST_RELAYER_ACCOUNT).unwrap());
    }

    #[test]
    fn recompute_from_stays_incremental_when_prior_gold_exists() {
        let earliest = chrono::DateTime::<chrono::Utc>::from_timestamp(10, 0).unwrap();
        let cursor = chrono::DateTime::<chrono::Utc>::from_timestamp(20, 0).unwrap();

        assert_eq!(choose_recompute_from(earliest, Some(cursor), true), cursor);
    }

    #[test]
    fn recompute_from_collapses_to_earliest_for_first_projection() {
        let earliest = chrono::DateTime::<chrono::Utc>::from_timestamp(10, 0).unwrap();
        let cursor = chrono::DateTime::<chrono::Utc>::from_timestamp(20, 0).unwrap();

        assert_eq!(
            choose_recompute_from(earliest, Some(cursor), false),
            earliest
        );
    }

    #[test]
    fn pending_exchange_widen_keeps_current_without_pending() {
        let recompute_from = chrono::DateTime::<chrono::Utc>::from_timestamp(20, 0).unwrap();

        assert_eq!(
            widen_for_pending_exchange(recompute_from, None),
            recompute_from
        );
    }

    #[test]
    fn pending_exchange_widen_uses_older_pending_time() {
        let recompute_from = chrono::DateTime::<chrono::Utc>::from_timestamp(20, 0).unwrap();
        let pending = chrono::DateTime::<chrono::Utc>::from_timestamp(10, 0).unwrap();

        assert_eq!(
            widen_for_pending_exchange(recompute_from, Some(pending)),
            pending
        );
    }

    #[test]
    fn pending_exchange_widen_ignores_newer_pending_time() {
        let recompute_from = chrono::DateTime::<chrono::Utc>::from_timestamp(20, 0).unwrap();
        let pending = chrono::DateTime::<chrono::Utc>::from_timestamp(30, 0).unwrap();

        assert_eq!(
            widen_for_pending_exchange(recompute_from, Some(pending)),
            recompute_from
        );
    }

    #[test]
    fn same_block_incoming_before_outgoing_is_deferred_until_exchange_completion() {
        let mut incoming = leg("nep245", Some("intents.near"), "2");
        incoming.id = 1;
        incoming.leg_key = "incoming".to_string();
        incoming.direction = "incoming".to_string();
        incoming.transaction_hash = Some("fulfillment-tx".to_string());
        incoming.token_id = "intents.near:nep141:usdt.near".to_string();
        incoming.amount_raw = decimal("2000000");
        incoming.amount = decimal("2");

        let mut outgoing = leg("nep245", Some("deposit-address"), "1");
        outgoing.id = 2;
        outgoing.leg_key = "outgoing".to_string();
        outgoing.direction = "outgoing".to_string();
        outgoing.proposal_ref = Some(7);
        outgoing.quote_deposit_address = Some("deposit-address".to_string());
        outgoing.transaction_hash = Some("proposal-tx".to_string());
        outgoing.token_id = "intents.near:nep141:usdc.near".to_string();
        outgoing.amount_raw = decimal("1000000");
        outgoing.amount = decimal("1");
        outgoing.quote_metadata = Some(serde_json::json!({
            "status": "SUCCESS",
            "nearTxHashes": ["fulfillment-tx"],
            "quoteResponse": {
                "quoteRequest": {
                    "originAsset": "nep141:usdc.near",
                    "destinationAsset": "nep141:usdt.near"
                },
                "quote": {
                    "amountIn": "1000000"
                }
            },
            "swapDetails": {
                "amountIn": "1000000",
                "amountOut": "2000000"
            }
        }));

        let rows = vec![incoming.clone(), outgoing.clone()];
        let quote_by_proposal_ref = build_quote_map(&rows);
        let exchange_pairs =
            plan_exchange_pairs(&rows, TEST_RELAYER_ACCOUNT).expect("exchange pair plan");
        let mut pending_exchanges: HashMap<i64, PendingExchange> = HashMap::new();
        let mut deferred_incoming: HashMap<i64, SilverTransferLegRow> = HashMap::new();
        let mut ledger = GoldLedger::default();
        let mut emitted = Vec::new();

        for leg in rows {
            let quote = leg
                .proposal_ref
                .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
            if is_quote_matched_exchange_deposit(&leg, quote, TEST_RELAYER_ACCOUNT).unwrap_or(false)
            {
                let (before, after) = ledger.apply_out(&leg.token_id, &leg.amount);
                let pending = PendingExchange {
                    outgoing: leg.clone(),
                    token_out_balance_before: before,
                    token_out_balance_after: after,
                };
                pending_exchanges.insert(leg.id, pending);
                if let Some(incoming) = deferred_incoming.remove(&leg.id)
                    && let Some(pending) = pending_exchanges.remove(&leg.id)
                {
                    let quote = pending
                        .outgoing
                        .proposal_ref
                        .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
                    let event =
                        completed_exchange_event_from_legs(&pending, &incoming, quote, &mut ledger);
                    emitted.push(event.transaction_type.as_str());
                }
                continue;
            }

            if let Some(outgoing_id) = exchange_pairs.incoming_to_outgoing.get(&leg.id) {
                if let Some(pending) = pending_exchanges.remove(outgoing_id) {
                    let quote = pending
                        .outgoing
                        .proposal_ref
                        .and_then(|proposal_ref| quote_by_proposal_ref.get(&proposal_ref));
                    let event =
                        completed_exchange_event_from_legs(&pending, &leg, quote, &mut ledger);
                    emitted.push(event.transaction_type.as_str());
                } else {
                    deferred_incoming.insert(*outgoing_id, leg);
                }
                continue;
            }

            if leg_direction(&leg).unwrap() == PublicTransferDirection::Incoming {
                emitted.push("deposit");
            }
        }

        assert_eq!(emitted, vec!["exchange"]);
        assert!(deferred_incoming.is_empty());
        assert!(pending_exchanges.is_empty());
    }

    #[test]
    fn parse_quote_status_uses_swap_details_usd_when_successful() {
        let raw = serde_json::json!({
            "status": "SUCCESS",
            "swapDetails": {
                "amountIn": "100",
                "amountOut": "200",
                "amountInUsd": "1.23",
                "amountOutUsd": "1.25"
            },
            "quoteResponse": {
                "quote": {
                    "amountInUsd": "1.00",
                    "amountOutUsd": "1.01"
                }
            }
        });

        let quote = parse_quote_status(Some(&raw)).expect("quote status");

        assert_eq!(quote.amount_sent_usd, Some(decimal("1.23")));
        assert_eq!(quote.amount_received_usd, Some(decimal("1.25")));
        assert_eq!(quote_usd_change(Some(&quote)), Some(decimal("0.02")));
    }

    #[test]
    fn parse_quote_status_falls_back_to_quote_response_usd_when_pending() {
        let raw = serde_json::json!({
            "status": "PENDING_DEPOSIT",
            "swapDetails": {
                "amountInUsd": null,
                "amountOutUsd": null
            },
            "quoteResponse": {
                "quote": {
                    "amountInUsd": "2.10",
                    "amountOutUsd": "2.08"
                }
            }
        });

        let quote = parse_quote_status(Some(&raw)).expect("quote status");

        assert_eq!(quote.amount_sent_usd, Some(decimal("2.10")));
        assert_eq!(quote.amount_received_usd, Some(decimal("2.08")));
        assert_eq!(quote_usd_change(Some(&quote)), Some(decimal("-0.02")));
    }

    #[test]
    fn parse_quote_status_ignores_missing_or_malformed_usd_fields() {
        let raw = serde_json::json!({
            "status": "SUCCESS",
            "swapDetails": {
                "amountInUsd": "not-a-number"
            },
            "quoteResponse": {
                "quote": {
                    "amountOutUsd": null
                }
            }
        });

        let quote = parse_quote_status(Some(&raw)).expect("quote status");

        assert_eq!(quote.amount_sent_usd, None);
        assert_eq!(quote.amount_received_usd, None);
        assert_eq!(quote_usd_change(Some(&quote)), None);
    }
}

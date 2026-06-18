//! Swap Detection for NEAR Intents
//!
//! Detects token swap fulfillments using the Intents Explorer API.
//!
//! ## How NEAR Intents Swaps Work
//!
//! 1. User deposits token A to an intents deposit address (from DAO proposal callback)
//! 2. Solver fulfills the intent in a separate transaction:
//!    - Debits token A from the deposit address
//!    - Credits token B to the user's account
//!
//! ## Detection Strategy
//!
//! We query the Intents Explorer API for successful swaps where the account is the recipient,
//! then match those to balance_changes records by transaction hash.
//!
//! ## Data Model
//!
//! Detected swaps are stored in the `detected_swaps` table, linking:
//! - The fulfillment balance_change (the receive leg)
//! - The deposit balance_change (the send leg, if found)

use reqwest::Client;
use serde::Deserialize;
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use std::collections::HashSet;
use std::error::Error;
use std::str::FromStr;
use std::time::Duration;

/// Token ID prefix for NEAR Intents tokens
const INTENTS_PREFIX: &str = "intents.near:";

/// A detected swap fulfillment
#[derive(Debug, Clone)]
pub struct DetectedSwap {
    /// The solver transaction hash that fulfilled this swap
    pub solver_transaction_hash: String,
    /// The solver account that fulfilled
    pub solver_account_id: Option<String>,
    /// The account that performed the swap
    pub account_id: String,
    /// Token sent (deposit leg)
    pub sent_token_id: Option<String>,
    /// Amount sent (negative)
    pub sent_amount: Option<BigDecimal>,
    /// Block height of deposit
    pub deposit_block_height: Option<i64>,
    /// Balance change ID for deposit leg
    pub deposit_balance_change_id: Option<i64>,
    /// Receipt ID for deposit
    pub deposit_receipt_id: Option<String>,
    /// Token received (fulfillment leg)
    pub received_token_id: String,
    /// Amount received (positive)
    pub received_amount: BigDecimal,
    /// Block height of fulfillment
    pub fulfillment_block_height: i64,
    /// Balance change ID for fulfillment leg
    pub fulfillment_balance_change_id: i64,
    /// Receipt ID for fulfillment
    pub fulfillment_receipt_id: Option<String>,
}

/// Response from the Intents Explorer API
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct IntentsTransaction {
    origin_asset: String,
    destination_asset: String,
    recipient: String,
    status: String,
    amount_in_formatted: String,
    amount_out_formatted: String,
    near_tx_hashes: Vec<String>,
    #[serde(default)]
    origin_chain_tx_hashes: Vec<String>,
}

/// A balance change record from the database
#[derive(Debug, Clone)]
struct BalanceChangeRecord {
    id: i64,
    #[allow(dead_code)]
    account_id: String,
    token_id: Option<String>,
    block_height: i64,
    #[allow(dead_code)]
    block_timestamp: i64,
    amount: BigDecimal,
    transaction_hashes: Vec<String>,
    receipt_ids: Vec<String>,
    #[allow(dead_code)]
    counterparty: String,
}

impl BalanceChangeRecord {
    fn token_id_str(&self) -> &str {
        self.token_id.as_deref().unwrap_or("NEAR")
    }

    fn is_positive(&self) -> bool {
        self.amount > BigDecimal::from_str("0").unwrap()
    }

    fn is_negative(&self) -> bool {
        self.amount < BigDecimal::from_str("0").unwrap()
    }
}

/// Detect swap fulfillments for an account using the Intents Explorer API
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - Account to detect swaps for
/// * `api_key` - Optional Intents Explorer API key
/// * `api_url` - Intents Explorer API base URL
///
/// # Returns
/// Vector of detected swaps
pub async fn detect_swaps_from_api(
    pool: &PgPool,
    account_id: &str,
    api_key: Option<&str>,
    api_url: &str,
) -> Result<Vec<DetectedSwap>, Box<dyn Error + Send + Sync>> {
    let client = Client::new();
    detect_swaps_from_api_with_client(&client, pool, account_id, api_key, api_url).await
}

pub async fn detect_swaps_from_api_with_client(
    client: &Client,
    pool: &PgPool,
    account_id: &str,
    api_key: Option<&str>,
    api_url: &str,
) -> Result<Vec<DetectedSwap>, Box<dyn Error + Send + Sync>> {
    let Some(api_key) = api_key else {
        tracing::debug!(
            "No INTENTS_EXPLORER_API_KEY configured, skipping API-based swap detection"
        );
        return Ok(vec![]);
    };

    // Query the Intents Explorer API for successful transactions where this account is recipient
    let url = format!(
        "{}/transactions?search={}&numberOfTransactions=1000&statuses=SUCCESS",
        api_url, account_id
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Intents Explorer API error {}: {}", status, body).into());
    }

    let api_transactions: Vec<IntentsTransaction> = response.json().await?;

    tracing::info!(
        "Intents Explorer API returned {} successful transactions for {}",
        api_transactions.len(),
        account_id
    );

    // Filter to only include transactions where this account is the recipient
    let api_transactions: Vec<_> = api_transactions
        .into_iter()
        .filter(|t| t.recipient == account_id && t.status == "SUCCESS")
        .collect();

    if api_transactions.is_empty() {
        return Ok(vec![]);
    }

    // Collect all transaction hashes from the API response
    let api_tx_hashes: HashSet<String> = api_transactions
        .iter()
        .flat_map(|t| t.near_tx_hashes.clone())
        .collect();

    // Query balance changes that have matching transaction hashes
    let records = sqlx::query_as!(
        BalanceChangeRecord,
        r#"
        SELECT id, account_id, token_id, block_height, block_timestamp,
               amount, transaction_hashes, receipt_id as "receipt_ids", counterparty
        FROM balance_changes
        WHERE account_id = $1
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT')
        ORDER BY block_height ASC
        "#,
        account_id
    )
    .fetch_all(pool)
    .await?;

    // Build a map from transaction hash to balance change records
    let mut tx_to_records: std::collections::HashMap<String, Vec<&BalanceChangeRecord>> =
        std::collections::HashMap::new();
    for record in &records {
        for tx_hash in &record.transaction_hashes {
            tx_to_records
                .entry(tx_hash.clone())
                .or_default()
                .push(record);
        }
    }

    // Find deposit records (negative intents token transfers)
    let deposits: Vec<&BalanceChangeRecord> = records
        .iter()
        .filter(|r| r.token_id_str().starts_with(INTENTS_PREFIX) && r.is_negative())
        .collect();

    let mut swaps = Vec::new();
    let mut matched_deposit_ids: HashSet<i64> = HashSet::new();

    // For each API transaction, find the matching fulfillment balance change
    for api_tx in &api_transactions {
        // The fulfillment tx hash is usually the second one in nearTxHashes
        let fulfillment_tx = api_tx
            .near_tx_hashes
            .get(1)
            .or(api_tx.near_tx_hashes.first());

        let Some(fulfillment_tx) = fulfillment_tx else {
            continue;
        };

        // Check if this transaction hash exists in our API response set
        if !api_tx_hashes.contains(fulfillment_tx) {
            continue;
        }

        // Find matching balance change records for this fulfillment
        let Some(matching_records) = tx_to_records.get(fulfillment_tx) else {
            tracing::debug!(
                "No balance change found for fulfillment tx {} for {}",
                fulfillment_tx,
                account_id
            );
            continue;
        };

        // Find the receive (positive) record that matches the destination asset.
        // Exclude records whose token matches the origin asset (e.g. USDC fee refunds)
        // since the fulfillment should be the destination token (e.g. SOL).
        let origin_intents_token = format!("intents.near:{}", api_tx.origin_asset);
        let fulfillment_record = matching_records
            .iter()
            .find(|r| {
                r.is_positive()
                    && r.token_id_str().starts_with(INTENTS_PREFIX)
                    && r.token_id_str() != origin_intents_token
            })
            .or_else(|| {
                // Fallback: if no non-origin match (e.g. same-token bridge), pick any positive intents record
                matching_records
                    .iter()
                    .find(|r| r.is_positive() && r.token_id_str().starts_with(INTENTS_PREFIX))
            });

        let Some(fulfillment) = fulfillment_record else {
            tracing::debug!(
                "No positive intents token balance change for tx {} for {}",
                fulfillment_tx,
                account_id
            );
            continue;
        };

        // Use API data for sent side (origin_asset and amount_in_formatted)
        let sent_token_id = format!("intents.near:{}", api_tx.origin_asset);
        let sent_amount = BigDecimal::from_str(&api_tx.amount_in_formatted).ok();

        // Try to find a matching deposit balance change.
        // The deposit can be either:
        // 1. An intents-prefixed negative transfer (intents.near:nep141:contract.near)
        // 2. A raw FT transfer to the deposit address (e.g. DAO ft_transfer via proposal)
        //    In this case token_id is the raw contract address, and the deposit
        //    tx hash is near_tx_hashes[0] (the first hash in the intents API response).
        // 3. A raw NEAR Transfer via DAO proposal (token_id = "near", origin_asset = "nep141:wrap.near")
        //    In this case the deposit tx hash is in origin_chain_tx_hashes.
        let raw_token_id = api_tx
            .origin_asset
            .strip_prefix("nep141:")
            .unwrap_or(&api_tx.origin_asset);

        // For wrap.near swaps, the balance change may have token_id "near" or "NEAR"
        // ("NEAR" is the fallback when token_id is NULL in the DB)
        let deposit_token_aliases: Vec<&str> = if raw_token_id == "wrap.near" {
            vec!["wrap.near", "near", "NEAR"]
        } else {
            vec![raw_token_id]
        };

        // First try: match intents-prefixed deposits
        let mut matching_deposit = deposits
            .iter()
            .filter(|d| {
                !matched_deposit_ids.contains(&d.id)
                    && d.block_height < fulfillment.block_height
                    && d.token_id_str() == sent_token_id
            })
            .max_by_key(|d| d.block_height)
            .copied();

        // Collect candidate deposit tx hashes: nearTxHashes[0] + originChainTxHashes
        let deposit_tx_candidates: Vec<&str> = api_tx
            .near_tx_hashes
            .first()
            .into_iter()
            .chain(api_tx.origin_chain_tx_hashes.iter())
            .map(|s| s.as_str())
            .collect();

        // Second try: match by deposit tx hash + raw token ID (or "near" alias for wrap.near)
        if matching_deposit.is_none() {
            for deposit_tx in &deposit_tx_candidates {
                if let Some(deposit_records) = tx_to_records.get(*deposit_tx) {
                    matching_deposit = deposit_records
                        .iter()
                        .filter(|d| {
                            !matched_deposit_ids.contains(&d.id)
                                && d.is_negative()
                                && deposit_token_aliases.contains(&d.token_id_str())
                        })
                        .max_by_key(|d| d.block_height)
                        .copied();
                    if matching_deposit.is_some() {
                        break;
                    }
                }
            }
        }

        if let Some(deposit) = matching_deposit {
            matched_deposit_ids.insert(deposit.id);
        }

        let fulfillment_receipt = fulfillment.receipt_ids.first().cloned();

        swaps.push(DetectedSwap {
            solver_transaction_hash: fulfillment_tx.clone(),
            solver_account_id: None, // API doesn't provide solver account
            account_id: account_id.to_string(),
            sent_token_id: Some(sent_token_id),
            sent_amount,
            deposit_block_height: matching_deposit.map(|d| d.block_height),
            deposit_balance_change_id: matching_deposit.map(|d| d.id),
            deposit_receipt_id: matching_deposit.and_then(|d| d.receipt_ids.first().cloned()),
            received_token_id: fulfillment.token_id_str().to_string(),
            received_amount: fulfillment.amount.clone(),
            fulfillment_block_height: fulfillment.block_height,
            fulfillment_balance_change_id: fulfillment.id,
            fulfillment_receipt_id: fulfillment_receipt,
        });
    }

    // Sort by fulfillment block height
    swaps.sort_by_key(|s| s.fulfillment_block_height);

    tracing::info!(
        "Matched {} swaps from API for {} (from {} API transactions, {} balance changes)",
        swaps.len(),
        account_id,
        api_transactions.len(),
        records.len()
    );

    Ok(swaps)
}

/// Store detected swaps in the database
pub async fn store_detected_swaps(
    pool: &PgPool,
    swaps: &[DetectedSwap],
) -> Result<usize, Box<dyn Error + Send + Sync>> {
    let mut inserted = 0;

    for swap in swaps {
        let result = sqlx::query!(
            r#"
            INSERT INTO detected_swaps (
                account_id,
                solver_transaction_hash,
                solver_account_id,
                deposit_receipt_id,
                deposit_balance_change_id,
                fulfillment_receipt_id,
                fulfillment_balance_change_id,
                sent_token_id,
                sent_amount,
                received_token_id,
                received_amount,
                block_height
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (account_id, solver_transaction_hash) DO UPDATE SET
                sent_token_id = EXCLUDED.sent_token_id,
                sent_amount = EXCLUDED.sent_amount,
                deposit_balance_change_id = EXCLUDED.deposit_balance_change_id,
                deposit_receipt_id = EXCLUDED.deposit_receipt_id,
                fulfillment_receipt_id = EXCLUDED.fulfillment_receipt_id,
                fulfillment_balance_change_id = EXCLUDED.fulfillment_balance_change_id,
                received_token_id = EXCLUDED.received_token_id,
                received_amount = EXCLUDED.received_amount
            "#,
            swap.account_id,
            swap.solver_transaction_hash,
            swap.solver_account_id,
            swap.deposit_receipt_id,
            swap.deposit_balance_change_id,
            swap.fulfillment_receipt_id,
            swap.fulfillment_balance_change_id,
            swap.sent_token_id,
            swap.sent_amount,
            swap.received_token_id,
            swap.received_amount,
            swap.fulfillment_block_height,
        )
        .execute(pool)
        .await?;

        if result.rows_affected() > 0 {
            inserted += 1;
        }
    }

    Ok(inserted)
}

/// Classify DAO proposal-based swap deposits by inspecting proposal descriptions.
///
/// For balance changes with method_name='on_proposal_callback' or 'act_proposal'
/// that aren't already linked in detected_swaps, this fetches the transaction to
/// extract the proposal ID, then fetches the proposal and checks if it's an
/// asset-exchange.
///
/// This handles both fulfilled swaps (where the intents API didn't link the deposit)
/// and unfulfilled swaps (where no intents API data exists yet).
/// It also handles Transfer-type proposals (act_proposal with token_id='near')
/// where NEAR is wrapped to wNEAR and deposited to intents.
pub async fn classify_proposal_swap_deposits(
    pool: &PgPool,
    network: &near_api::NetworkConfig,
    account_id: &str,
) -> Result<usize, Box<dyn Error + Send + Sync>> {
    use crate::handlers::proposals::scraper::{AssetExchangeInfo, ProposalType, fetch_proposal};

    // Find on_proposal_callback/act_proposal balance changes not yet linked as deposits
    let unlinked_deposits = sqlx::query!(
        r#"
        SELECT bc.id, bc.account_id, bc.block_height, bc.token_id,
               bc.amount, bc.transaction_hashes, bc.signer_id, bc.receipt_id
        FROM balance_changes bc
        WHERE bc.account_id = $1
          AND bc.method_name IN ('on_proposal_callback', 'act_proposal')
          AND bc.amount < 0
          AND NOT EXISTS (
              SELECT 1 FROM detected_swaps ds
              WHERE ds.account_id = bc.account_id
                AND ds.deposit_balance_change_id = bc.id
          )
        ORDER BY bc.block_height DESC
        LIMIT 20
        "#,
        account_id
    )
    .fetch_all(pool)
    .await?;

    if unlinked_deposits.is_empty() {
        return Ok(0);
    }

    tracing::info!(
        "{}: Found {} unlinked on_proposal_callback deposits to check",
        account_id,
        unlinked_deposits.len()
    );

    let dao_account_id: near_api::AccountId = account_id.parse()?;
    let mut classified = 0;

    for deposit in &unlinked_deposits {
        let tx_hash = match deposit.transaction_hashes.first() {
            Some(h) => h.clone(),
            None => continue,
        };
        let signer_id = match &deposit.signer_id {
            Some(s) => s.clone(),
            None => account_id.to_string(),
        };

        // Extract proposal ID from the transaction
        let proposal_id = match extract_proposal_id(network, &tx_hash, &signer_id).await {
            Some(id) => id,
            None => {
                tracing::debug!(
                    "Could not extract proposal ID from tx {} for {}",
                    tx_hash,
                    account_id
                );
                continue;
            }
        };

        // Fetch proposal from DAO contract
        let proposal = match fetch_proposal(network, &dao_account_id, proposal_id).await {
            Ok(p) => p,
            Err(e) => {
                tracing::debug!(
                    "Failed to fetch proposal {} for {}: {}",
                    proposal_id,
                    account_id,
                    e
                );
                continue;
            }
        };

        // Check if it's an asset-exchange proposal
        let Some(exchange_info) = AssetExchangeInfo::from_proposal(&proposal) else {
            continue;
        };

        let deposit_receipt_id = deposit.receipt_id.first().cloned();
        let token_id = deposit.token_id.clone().unwrap_or_default();

        // First, try to link to an existing intents API row that has NULL deposit_balance_change_id.
        // Match by account + sent token (intents-prefixed version) + amount.
        // For NEAR Transfer proposals, token_id is "near" but intents uses "wrap.near".
        let intents_raw_token = if token_id == "near" {
            "wrap.near"
        } else {
            &token_id
        };
        let intents_token_id = format!("intents.near:nep141:{}", intents_raw_token);
        let linked = sqlx::query!(
            r#"
            UPDATE detected_swaps
            SET deposit_balance_change_id = $1,
                deposit_receipt_id = $2
            WHERE account_id = $3
              AND deposit_balance_change_id IS NULL
              AND sent_token_id = $4
              AND sent_amount = $5
            "#,
            deposit.id,
            deposit_receipt_id,
            account_id,
            intents_token_id,
            deposit.amount.abs(),
        )
        .execute(pool)
        .await;

        if let Ok(r) = &linked
            && r.rows_affected() > 0
        {
            classified += 1;
            tracing::info!(
                "{}: Linked deposit bc_id={} to existing intents swap",
                account_id,
                deposit.id
            );
            continue;
        }

        // Fallback: for NEAR transfers the balance change amount doesn't exactly match
        // the intents sent_amount (due to gas/storage). Try matching by token only.
        if token_id == "near" {
            let linked_approx = sqlx::query!(
                r#"
                UPDATE detected_swaps
                SET deposit_balance_change_id = $1,
                    deposit_receipt_id = $2
                WHERE id = (
                    SELECT id FROM detected_swaps
                    WHERE account_id = $3
                      AND deposit_balance_change_id IS NULL
                      AND sent_token_id = $4
                      AND block_height >= $5
                    ORDER BY block_height ASC, id ASC
                    LIMIT 1
                )
                "#,
                deposit.id,
                deposit_receipt_id,
                account_id,
                intents_token_id,
                deposit.block_height,
            )
            .execute(pool)
            .await;

            if let Ok(r) = &linked_approx
                && r.rows_affected() > 0
            {
                classified += 1;
                tracing::info!(
                    "{}: Linked NEAR deposit bc_id={} to existing intents swap (approx)",
                    account_id,
                    deposit.id
                );
                continue;
            }
        }

        // No existing intents row — create a new row for unfulfilled swaps.
        let received_amount = BigDecimal::from_str(&exchange_info.amount_out).unwrap_or_default();

        // Normalize received_token_id: proposal descriptions use "nep141:sol.omft.near"
        // but the frontend needs "intents.near:nep141:..." to resolve token metadata.
        let received_token_id = if exchange_info.token_out_symbol.starts_with("nep141:") {
            format!("intents.near:{}", exchange_info.token_out_symbol)
        } else {
            exchange_info.token_out_symbol.clone()
        };

        let result = sqlx::query!(
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
                deposit_balance_change_id = COALESCE(detected_swaps.deposit_balance_change_id, EXCLUDED.deposit_balance_change_id),
                deposit_receipt_id = COALESCE(detected_swaps.deposit_receipt_id, EXCLUDED.deposit_receipt_id)
            "#,
            account_id,
            format!("proposal-deposit-{}", tx_hash),
            deposit_receipt_id,
            Some(deposit.id),
            None::<String>,
            deposit.id,
            Some(token_id),
            Some(deposit.amount.abs()),
            received_token_id,
            received_amount,
            deposit.block_height,
        )
        .execute(pool)
        .await;

        match result {
            Ok(r) if r.rows_affected() > 0 => {
                classified += 1;
                tracing::info!(
                    "{}: Classified proposal {} as asset-exchange deposit (bc_id={})",
                    account_id,
                    proposal_id,
                    deposit.id
                );
            }
            Err(e) => {
                tracing::debug!(
                    "{}: Error inserting proposal swap for bc_id={}: {}",
                    account_id,
                    deposit.id,
                    e
                );
            }
            _ => {}
        }
    }

    Ok(classified)
}

/// Extract proposal ID from a transaction by inspecting act_proposal args.
/// Handles both direct FunctionCall and Delegate-wrapped actions.
async fn extract_proposal_id(
    network: &near_api::NetworkConfig,
    tx_hash: &str,
    signer_id: &str,
) -> Option<u64> {
    use crate::handlers::balance_changes::block_info::get_transaction;

    let tx_response = get_transaction(network, tx_hash, signer_id).await.ok()?;
    let outcome = tx_response.final_execution_outcome?.into_outcome();
    let transaction = &outcome.transaction;

    fn extract_from_action(action: &near_primitives::views::ActionView) -> Option<u64> {
        if let near_primitives::views::ActionView::FunctionCall {
            method_name, args, ..
        } = action
            && method_name == "act_proposal"
        {
            let json: serde_json::Value = serde_json::from_slice(args).ok()?;
            return json.get("id").and_then(|v| v.as_u64());
        }
        None
    }

    for action in &transaction.actions {
        if let Some(id) = extract_from_action(action) {
            return Some(id);
        }
        if let near_primitives::views::ActionView::Delegate {
            delegate_action, ..
        } = action
        {
            for inner in &delegate_action.actions {
                if let near_primitives::action::Action::FunctionCall(fc) = inner.clone().into()
                    && fc.method_name == "act_proposal"
                {
                    let json: serde_json::Value = serde_json::from_slice(&fc.args).ok()?;
                    return json.get("id").and_then(|v| v.as_u64());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_balance_change_record_helpers() {
        let record = BalanceChangeRecord {
            id: 1,
            account_id: "test.near".to_string(),
            token_id: Some("intents.near:nep141:usdc.near".to_string()),
            block_height: 100,
            block_timestamp: 1000,
            amount: BigDecimal::from(10),
            transaction_hashes: vec!["tx1".to_string()],
            receipt_ids: vec!["receipt1".to_string()],
            counterparty: "solver.near".to_string(),
        };

        assert_eq!(record.token_id_str(), "intents.near:nep141:usdc.near");
        assert!(record.is_positive());
        assert!(!record.is_negative());
    }

    #[test]
    fn test_balance_change_record_negative() {
        let record = BalanceChangeRecord {
            id: 1,
            account_id: "test.near".to_string(),
            token_id: Some("intents.near:nep141:usdc.near".to_string()),
            block_height: 100,
            block_timestamp: 1000,
            amount: BigDecimal::from(-10),
            transaction_hashes: vec![],
            receipt_ids: vec![],
            counterparty: "intents.near".to_string(),
        };

        assert!(!record.is_positive());
        assert!(record.is_negative());
    }

    #[test]
    fn test_balance_change_record_no_token() {
        let record = BalanceChangeRecord {
            id: 1,
            account_id: "test.near".to_string(),
            token_id: None,
            block_height: 100,
            block_timestamp: 1000,
            amount: BigDecimal::from(10),
            transaction_hashes: vec![],
            receipt_ids: vec![],
            counterparty: "other.near".to_string(),
        };

        assert_eq!(record.token_id_str(), "NEAR");
    }
}

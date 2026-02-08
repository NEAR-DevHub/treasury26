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
    pub fulfillment_receipt_id: String,
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
    let Some(api_key) = api_key else {
        log::debug!("No INTENTS_EXPLORER_API_KEY configured, skipping API-based swap detection");
        return Ok(vec![]);
    };

    // Query the Intents Explorer API for successful transactions where this account is recipient
    let client = Client::new();
    let url = format!(
        "{}/transactions?search={}&numberOfTransactions=1000&statuses=SUCCESS",
        api_url, account_id
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Intents Explorer API error {}: {}", status, body).into());
    }

    let api_transactions: Vec<IntentsTransaction> = response.json().await?;

    log::info!(
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
            log::debug!(
                "No balance change found for fulfillment tx {} for {}",
                fulfillment_tx,
                account_id
            );
            continue;
        };

        // Find the receive (positive) record that matches the destination asset
        let fulfillment_record = matching_records
            .iter()
            .find(|r| r.is_positive() && r.token_id_str().starts_with(INTENTS_PREFIX));

        let Some(fulfillment) = fulfillment_record else {
            log::debug!(
                "No positive intents token balance change for tx {} for {}",
                fulfillment_tx,
                account_id
            );
            continue;
        };

        // Try to find a matching deposit (different token, sent before this fulfillment)
        let matching_deposit = deposits
            .iter()
            .filter(|d| {
                !matched_deposit_ids.contains(&d.id)
                    && d.block_height < fulfillment.block_height
                    && d.token_id_str() != fulfillment.token_id_str()
            })
            .max_by_key(|d| d.block_height);

        let (deposit_info, deposit_id) = if let Some(deposit) = matching_deposit {
            matched_deposit_ids.insert(deposit.id);
            (
                Some((
                    deposit.token_id_str().to_string(),
                    deposit.amount.clone(),
                    deposit.block_height,
                    deposit.id,
                    deposit.receipt_ids.first().cloned(),
                )),
                Some(deposit.id),
            )
        } else {
            (None, None)
        };

        let fulfillment_receipt = fulfillment.receipt_ids.first().cloned().unwrap_or_default();

        swaps.push(DetectedSwap {
            solver_transaction_hash: fulfillment_tx.clone(),
            solver_account_id: None, // API doesn't provide solver account
            account_id: account_id.to_string(),
            sent_token_id: deposit_info.as_ref().map(|(t, _, _, _, _)| t.clone()),
            sent_amount: deposit_info.as_ref().map(|(_, a, _, _, _)| a.clone()),
            deposit_block_height: deposit_info.as_ref().map(|(_, _, b, _, _)| *b),
            deposit_balance_change_id: deposit_id,
            deposit_receipt_id: deposit_info.as_ref().and_then(|(_, _, _, _, r)| r.clone()),
            received_token_id: fulfillment.token_id_str().to_string(),
            received_amount: fulfillment.amount.clone(),
            fulfillment_block_height: fulfillment.block_height,
            fulfillment_balance_change_id: fulfillment.id,
            fulfillment_receipt_id: fulfillment_receipt,
        });
    }

    // Sort by fulfillment block height
    swaps.sort_by_key(|s| s.fulfillment_block_height);

    log::info!(
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
            ON CONFLICT (account_id, fulfillment_receipt_id) DO NOTHING
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

//! Swap Detection
//!
//! Detects token swaps by grouping balance changes that trace back to the same
//! originating transaction. When an account's balance changes in multiple tokens
//! as part of a single transaction (e.g., USDC decreases and wNEAR increases),
//! this constitutes a swap rather than independent payments.
//!
//! # How it works
//!
//! 1. Query balance changes that have receipt_ids but missing transaction_hashes
//! 2. Resolve each receipt to its originating transaction using `resolve_receipt_to_transaction`
//! 3. Group balance changes by their originating transaction hash
//! 4. Groups with multiple different tokens form a swap
//!
//! # Data Model
//!
//! Balance changes already store `receipt_id` and `transaction_hashes` as TEXT[] arrays.
//! Swaps are detected by finding balance changes with different tokens that share the
//! same originating transaction hash.

use near_api::NetworkConfig;
use sqlx::PgPool;
use std::collections::HashMap;
use std::error::Error;

use super::transfer_hints::tx_resolver;

/// A detected swap: multiple token balance changes from the same transaction
#[derive(Debug, Clone)]
pub struct DetectedSwap {
    /// The originating transaction hash that caused all legs of the swap
    pub transaction_hash: String,
    /// The account that performed the swap
    pub account_id: String,
    /// Individual legs of the swap (one per token)
    pub legs: Vec<SwapLeg>,
}

/// A single leg of a swap (one token's balance change)
#[derive(Debug, Clone)]
pub struct SwapLeg {
    /// Token identifier (e.g., "intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near")
    pub token_id: String,
    /// Block height where this leg's balance changed
    pub block_height: i64,
    /// Amount of the balance change (positive = received, negative = sent)
    pub amount: sqlx::types::BigDecimal,
    /// Receipt IDs associated with this leg
    pub receipt_ids: Vec<String>,
}

/// A balance change record from the database with the fields needed for swap detection
#[derive(Debug, Clone)]
struct BalanceChangeRecord {
    id: i64,
    account_id: String,
    token_id: Option<String>,
    block_height: i64,
    amount: sqlx::types::BigDecimal,
    transaction_hashes: Vec<String>,
    receipt_ids: Vec<String>,
}

impl BalanceChangeRecord {
    fn token_id_str(&self) -> &str {
        self.token_id.as_deref().unwrap_or("NEAR")
    }
}

/// Backfill transaction hashes for balance changes that have receipt_ids but empty transaction_hashes
///
/// This resolves each receipt to its originating transaction and updates the database record.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - Account to backfill transaction hashes for
///
/// # Returns
/// Number of records updated
pub async fn backfill_transaction_hashes(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
) -> Result<usize, Box<dyn Error + Send + Sync>> {
    // Find balance changes with receipt_ids but empty transaction_hashes
    let records = sqlx::query_as!(
        BalanceChangeRecord,
        r#"
        SELECT id, account_id, token_id, block_height,
               amount, transaction_hashes, receipt_id as "receipt_ids"
        FROM balance_changes
        WHERE account_id = $1
          AND array_length(receipt_id, 1) > 0
          AND (transaction_hashes = '{}' OR transaction_hashes IS NULL)
        ORDER BY block_height ASC
        "#,
        account_id
    )
    .fetch_all(pool)
    .await?;

    if records.is_empty() {
        log::debug!(
            "No balance changes need transaction hash backfill for {}",
            account_id
        );
        return Ok(0);
    }

    log::info!(
        "Found {} balance changes to backfill transaction hashes for {}",
        records.len(),
        account_id
    );

    let mut updated_count = 0;

    for record in &records {
        let Some(receipt_id) = record.receipt_ids.first() else {
            continue;
        };

        match tx_resolver::resolve_receipt_to_transaction(
            network,
            receipt_id,
            record.block_height as u64,
        )
        .await
        {
            Ok(result) => {
                // Update the database record with the resolved transaction hash
                sqlx::query!(
                    r#"
                    UPDATE balance_changes
                    SET transaction_hashes = array_append(transaction_hashes, $1)
                    WHERE id = $2
                    "#,
                    result.transaction_hash,
                    record.id
                )
                .execute(pool)
                .await?;

                log::debug!(
                    "Backfilled tx hash {} for receipt {} at block {} ({}/{})",
                    result.transaction_hash,
                    receipt_id,
                    record.block_height,
                    record.account_id,
                    record.token_id_str()
                );

                updated_count += 1;
            }
            Err(e) => {
                log::warn!(
                    "Failed to resolve receipt {} at block {} for {}/{}: {}",
                    receipt_id,
                    record.block_height,
                    record.account_id,
                    record.token_id_str(),
                    e
                );
            }
        }
    }

    log::info!(
        "Backfilled {} of {} transaction hashes for {}",
        updated_count,
        records.len(),
        account_id
    );

    Ok(updated_count)
}

/// Detect swaps for an account by grouping balance changes that share the same transaction hash
///
/// A swap is identified when:
/// 1. Two or more balance changes for different tokens share the same originating transaction
/// 2. The changes have opposite signs (one token goes up, another goes down)
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - Account to detect swaps for
///
/// # Returns
/// Vector of detected swaps
pub async fn detect_swaps(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<DetectedSwap>, Box<dyn Error + Send + Sync>> {
    // Query balance changes that have transaction hashes
    let records = sqlx::query_as!(
        BalanceChangeRecord,
        r#"
        SELECT id, account_id, token_id, block_height,
               amount, transaction_hashes, receipt_id as "receipt_ids"
        FROM balance_changes
        WHERE account_id = $1
          AND array_length(transaction_hashes, 1) > 0
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT')
        ORDER BY block_height ASC
        "#,
        account_id
    )
    .fetch_all(pool)
    .await?;

    let swaps = group_into_swaps(&records, account_id);

    log::info!(
        "Detected {} swaps for {} (from {} balance changes with tx hashes)",
        swaps.len(),
        account_id,
        records.len()
    );

    Ok(swaps)
}

/// Detect swaps within a specific block range
///
/// Same as `detect_swaps` but limited to a block range, useful for testing
/// with known swap data.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - Account to detect swaps for
/// * `from_block` - Start of block range (inclusive)
/// * `to_block` - End of block range (inclusive)
///
/// # Returns
/// Vector of detected swaps within the range
pub async fn detect_swaps_in_range(
    pool: &PgPool,
    account_id: &str,
    from_block: i64,
    to_block: i64,
) -> Result<Vec<DetectedSwap>, Box<dyn Error + Send + Sync>> {
    let records = sqlx::query_as!(
        BalanceChangeRecord,
        r#"
        SELECT id, account_id, token_id, block_height,
               amount, transaction_hashes, receipt_id as "receipt_ids"
        FROM balance_changes
        WHERE account_id = $1
          AND block_height >= $2
          AND block_height <= $3
          AND array_length(transaction_hashes, 1) > 0
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT')
        ORDER BY block_height ASC
        "#,
        account_id,
        from_block,
        to_block
    )
    .fetch_all(pool)
    .await?;

    Ok(group_into_swaps(&records, account_id))
}

/// Group balance change records into swaps based on shared transaction hashes
fn group_into_swaps(records: &[BalanceChangeRecord], account_id: &str) -> Vec<DetectedSwap> {
    // Group by transaction hash
    let mut tx_groups: HashMap<String, Vec<&BalanceChangeRecord>> = HashMap::new();
    for record in records {
        for tx_hash in &record.transaction_hashes {
            tx_groups
                .entry(tx_hash.clone())
                .or_default()
                .push(record);
        }
    }

    // Find groups with multiple different tokens (these are swaps)
    let mut swaps = Vec::new();

    for (tx_hash, group) in &tx_groups {
        // Collect unique tokens in this group
        let unique_tokens: Vec<&str> = {
            let mut tokens: Vec<&str> = group.iter().map(|r| r.token_id_str()).collect();
            tokens.sort();
            tokens.dedup();
            tokens
        };

        // A swap requires at least 2 different tokens
        if unique_tokens.len() < 2 {
            continue;
        }

        let legs: Vec<SwapLeg> = group
            .iter()
            .map(|r| SwapLeg {
                token_id: r.token_id_str().to_string(),
                block_height: r.block_height,
                amount: r.amount.clone(),
                receipt_ids: r.receipt_ids.clone(),
            })
            .collect();

        swaps.push(DetectedSwap {
            transaction_hash: tx_hash.clone(),
            account_id: account_id.to_string(),
            legs,
        });
    }

    // Sort by earliest block height in each swap
    swaps.sort_by_key(|s| s.legs.iter().map(|l| l.block_height).min().unwrap_or(0));

    swaps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_detection_requires_multiple_tokens() {
        let records = vec![BalanceChangeRecord {
            id: 1,
            account_id: "test.near".to_string(),
            token_id: Some("near".to_string()),
            block_height: 100,
            amount: sqlx::types::BigDecimal::from(1),
            transaction_hashes: vec!["tx1".to_string()],
            receipt_ids: vec!["r1".to_string()],
        }];

        let swaps = group_into_swaps(&records, "test.near");
        assert!(swaps.is_empty(), "Single-token group should not be a swap");
    }

    #[test]
    fn test_swap_detection_groups_by_tx_hash() {
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some("near".to_string()),
                block_height: 100,
                amount: sqlx::types::BigDecimal::from(-5),
                transaction_hashes: vec!["tx_swap".to_string()],
                receipt_ids: vec!["r1".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some("usdc.near".to_string()),
                block_height: 102,
                amount: sqlx::types::BigDecimal::from(10),
                transaction_hashes: vec!["tx_swap".to_string()],
                receipt_ids: vec!["r2".to_string()],
            },
        ];

        let swaps = group_into_swaps(&records, "test.near");
        assert_eq!(swaps.len(), 1, "Two tokens with same tx_hash should form one swap");

        let swap = &swaps[0];
        assert_eq!(swap.transaction_hash, "tx_swap");
        assert_eq!(swap.legs.len(), 2, "Swap should have 2 legs");

        // Verify tokens are different
        let tokens: Vec<&str> = swap.legs.iter().map(|l| l.token_id.as_str()).collect();
        assert!(tokens.contains(&"near"), "Should contain 'near' token");
        assert!(tokens.contains(&"usdc.near"), "Should contain 'usdc.near' token");
    }

    #[test]
    fn test_swap_detection_ignores_same_token() {
        // Two balance changes for the same token with the same tx_hash are NOT a swap
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some("near".to_string()),
                block_height: 100,
                amount: sqlx::types::BigDecimal::from(-5),
                transaction_hashes: vec!["tx1".to_string()],
                receipt_ids: vec!["r1".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some("near".to_string()),
                block_height: 102,
                amount: sqlx::types::BigDecimal::from(3),
                transaction_hashes: vec!["tx1".to_string()],
                receipt_ids: vec!["r2".to_string()],
            },
        ];

        let swaps = group_into_swaps(&records, "test.near");
        assert!(
            swaps.is_empty(),
            "Same token with same tx_hash should not be a swap"
        );
    }

    #[test]
    fn test_three_token_swap() {
        // A complex swap involving three tokens
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some("near".to_string()),
                block_height: 100,
                amount: sqlx::types::BigDecimal::from(-10),
                transaction_hashes: vec!["tx_complex".to_string()],
                receipt_ids: vec!["r1".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some("wrap.near".to_string()),
                block_height: 101,
                amount: sqlx::types::BigDecimal::from(10),
                transaction_hashes: vec!["tx_complex".to_string()],
                receipt_ids: vec!["r2".to_string()],
            },
            BalanceChangeRecord {
                id: 3,
                account_id: "test.near".to_string(),
                token_id: Some("usdc.near".to_string()),
                block_height: 103,
                amount: sqlx::types::BigDecimal::from(50),
                transaction_hashes: vec!["tx_complex".to_string()],
                receipt_ids: vec!["r3".to_string()],
            },
        ];

        let swaps = group_into_swaps(&records, "test.near");
        assert_eq!(swaps.len(), 1, "Should detect one complex swap");
        assert_eq!(swaps[0].legs.len(), 3, "Swap should have 3 legs");
    }
}

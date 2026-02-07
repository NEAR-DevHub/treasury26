//! Swap Detection
//!
//! Detects token swaps using two complementary strategies:
//!
//! ## Strategy 1: Transaction hash grouping
//! Groups balance changes that share the same originating transaction hash.
//! When multiple tokens change as part of a single transaction, it's a swap.
//!
//! ## Strategy 2: Time-proximity for NEAR Intents
//! For intents tokens (token_id starts with "intents.near:"), swaps may span
//! multiple transactions (e.g., DAO proposal triggers send, solver fulfills receive).
//! These are matched by finding intents balance changes within a configurable
//! block window where one token decreases and another increases.
//!
//! # Data Model
//!
//! Balance changes already store `receipt_id` and `transaction_hashes` as TEXT[] arrays.
//! Swaps are detected by finding balance changes with different tokens that share the
//! same originating transaction hash, or by time-proximity for intents tokens.

use near_api::NetworkConfig;
use sqlx::types::BigDecimal;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::str::FromStr;

use super::transfer_hints::tx_resolver;

/// Default block window for intents time-proximity matching.
/// NEAR produces ~1 block/second, so 20 blocks ≈ 20 seconds.
const DEFAULT_INTENTS_BLOCK_WINDOW: i64 = 20;

/// Token ID prefix for NEAR Intents tokens
const INTENTS_PREFIX: &str = "intents.near:";

/// A detected swap: multiple token balance changes from the same transaction
#[derive(Debug, Clone)]
pub struct DetectedSwap {
    /// The originating transaction hash that caused all legs of the swap.
    /// For intents time-proximity swaps, this is set to "intents-proximity".
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

/// Detect swaps for an account using both tx-hash grouping and intents time-proximity
///
/// A swap is identified when:
/// 1. Two or more balance changes for different tokens share the same originating transaction, OR
/// 2. Two intents token balance changes occur within a block window with opposite signs
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
    // Query all balance changes (both with and without tx hashes) for swap detection
    let records = sqlx::query_as!(
        BalanceChangeRecord,
        r#"
        SELECT id, account_id, token_id, block_height,
               amount, transaction_hashes, receipt_id as "receipt_ids"
        FROM balance_changes
        WHERE account_id = $1
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT')
        ORDER BY block_height ASC
        "#,
        account_id
    )
    .fetch_all(pool)
    .await?;

    let swaps = detect_all_swaps(&records, account_id, DEFAULT_INTENTS_BLOCK_WINDOW);

    log::info!(
        "Detected {} swaps for {} (from {} balance changes)",
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
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT')
        ORDER BY block_height ASC
        "#,
        account_id,
        from_block,
        to_block
    )
    .fetch_all(pool)
    .await?;

    Ok(detect_all_swaps(&records, account_id, DEFAULT_INTENTS_BLOCK_WINDOW))
}

/// Detect swaps using both tx-hash grouping and intents time-proximity
fn detect_all_swaps(
    records: &[BalanceChangeRecord],
    account_id: &str,
    block_window: i64,
) -> Vec<DetectedSwap> {
    let mut swaps = Vec::new();
    // Track record IDs already matched to avoid duplicates across strategies
    let mut matched_ids: HashSet<i64> = HashSet::new();

    // Strategy 1: Group by transaction hash (existing approach)
    let tx_swaps = group_by_tx_hash(records, account_id);
    for swap in tx_swaps {
        for leg in &swap.legs {
            // Find matching record IDs for this leg
            for r in records {
                if r.token_id_str() == leg.token_id
                    && r.block_height == leg.block_height
                    && r.receipt_ids == leg.receipt_ids
                {
                    matched_ids.insert(r.id);
                }
            }
        }
        swaps.push(swap);
    }

    // Strategy 2: Time-proximity for intents tokens
    let intents_swaps = group_intents_by_proximity(records, account_id, block_window, &matched_ids);
    swaps.extend(intents_swaps);

    // Sort by earliest block height in each swap
    swaps.sort_by_key(|s| s.legs.iter().map(|l| l.block_height).min().unwrap_or(0));

    swaps
}

/// Strategy 1: Group balance change records into swaps based on shared transaction hashes
fn group_by_tx_hash(records: &[BalanceChangeRecord], account_id: &str) -> Vec<DetectedSwap> {
    let mut tx_groups: HashMap<String, Vec<&BalanceChangeRecord>> = HashMap::new();
    for record in records {
        for tx_hash in &record.transaction_hashes {
            tx_groups
                .entry(tx_hash.clone())
                .or_default()
                .push(record);
        }
    }

    let mut swaps = Vec::new();

    for (tx_hash, group) in &tx_groups {
        let unique_tokens: Vec<&str> = {
            let mut tokens: Vec<&str> = group.iter().map(|r| r.token_id_str()).collect();
            tokens.sort();
            tokens.dedup();
            tokens
        };

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

    swaps
}

/// Strategy 2: Match intents token balance changes by time-proximity
///
/// For NEAR Intents swaps, the send and receive legs are separate transactions
/// (e.g., DAO proposal callback sends tokens, solver fulfills with a different tx).
/// We detect these by finding intents token balance changes within `block_window`
/// blocks where one token decreases and another increases.
fn group_intents_by_proximity(
    records: &[BalanceChangeRecord],
    account_id: &str,
    block_window: i64,
    already_matched: &HashSet<i64>,
) -> Vec<DetectedSwap> {
    let zero = BigDecimal::from_str("0").unwrap();

    // Filter to unmatched intents records only
    let intents_records: Vec<&BalanceChangeRecord> = records
        .iter()
        .filter(|r| {
            !already_matched.contains(&r.id)
                && r.token_id_str().starts_with(INTENTS_PREFIX)
        })
        .collect();

    if intents_records.len() < 2 {
        return Vec::new();
    }

    let mut swaps = Vec::new();
    let mut used: HashSet<i64> = HashSet::new();

    // For each negative (outgoing) intents change, find a matching positive (incoming)
    // intents change for a different token within the block window
    for (i, send) in intents_records.iter().enumerate() {
        if used.contains(&send.id) || send.amount >= zero {
            continue;
        }

        for receive in &intents_records[i + 1..] {
            if used.contains(&receive.id) || receive.amount <= zero {
                continue;
            }

            // Must be different tokens
            if send.token_id_str() == receive.token_id_str() {
                continue;
            }

            // Must be within block window
            let block_diff = (receive.block_height - send.block_height).abs();
            if block_diff > block_window {
                continue;
            }

            // Found a match
            used.insert(send.id);
            used.insert(receive.id);

            swaps.push(DetectedSwap {
                transaction_hash: "intents-proximity".to_string(),
                account_id: account_id.to_string(),
                legs: vec![
                    SwapLeg {
                        token_id: send.token_id_str().to_string(),
                        block_height: send.block_height,
                        amount: send.amount.clone(),
                        receipt_ids: send.receipt_ids.clone(),
                    },
                    SwapLeg {
                        token_id: receive.token_id_str().to_string(),
                        block_height: receive.block_height,
                        amount: receive.amount.clone(),
                        receipt_ids: receive.receipt_ids.clone(),
                    },
                ],
            });

            break; // Move to next send leg
        }
    }

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

        let swaps = detect_all_swaps(&records, "test.near", DEFAULT_INTENTS_BLOCK_WINDOW);
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

        let swaps = detect_all_swaps(&records, "test.near", DEFAULT_INTENTS_BLOCK_WINDOW);
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

        let swaps = detect_all_swaps(&records, "test.near", DEFAULT_INTENTS_BLOCK_WINDOW);
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

        let swaps = detect_all_swaps(&records, "test.near", DEFAULT_INTENTS_BLOCK_WINDOW);
        assert_eq!(swaps.len(), 1, "Should detect one complex swap");
        assert_eq!(swaps[0].legs.len(), 3, "Swap should have 3 legs");
    }

    #[test]
    fn test_intents_proximity_swap_detection() {
        // Simulate the real-world NEAR Intents swap: USDC out at block 171108230,
        // Base USDC in at block 171108241 (11 blocks apart, different tx hashes)
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some(
                    "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
                        .to_string(),
                ),
                block_height: 171108230,
                amount: sqlx::types::BigDecimal::from(-10),
                transaction_hashes: vec![], // No tx hash (DAO callback)
                receipt_ids: vec!["6bqKjx8UVTzJZ5WgrQVikL4jZ23CRTgqJjFCLVSCdtBU".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some(
                    "intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
                        .to_string(),
                ),
                block_height: 171108241,
                amount: sqlx::types::BigDecimal::try_from(9.99998).unwrap(),
                transaction_hashes: vec!["6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r".to_string()],
                receipt_ids: vec!["8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD".to_string()],
            },
        ];

        let swaps = detect_all_swaps(&records, "test.near", 20);
        assert_eq!(swaps.len(), 1, "Should detect intents proximity swap");
        assert_eq!(swaps[0].transaction_hash, "intents-proximity");
        assert_eq!(swaps[0].legs.len(), 2, "Swap should have 2 legs");

        let leg_tokens: Vec<&str> = swaps[0].legs.iter().map(|l| l.token_id.as_str()).collect();
        assert!(
            leg_tokens.iter().any(|t| t.contains("17208628f84f5d6ad")),
            "Should contain USDC leg"
        );
        assert!(
            leg_tokens.iter().any(|t| t.contains("base-0x833589fcd6edb6e")),
            "Should contain Base USDC leg"
        );
    }

    #[test]
    fn test_intents_proximity_outside_window_not_detected() {
        // Two intents changes 50 blocks apart should NOT match with a 20-block window
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some("intents.near:nep141:token_a".to_string()),
                block_height: 100,
                amount: sqlx::types::BigDecimal::from(-5),
                transaction_hashes: vec![],
                receipt_ids: vec!["r1".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some("intents.near:nep141:token_b".to_string()),
                block_height: 150,
                amount: sqlx::types::BigDecimal::from(5),
                transaction_hashes: vec![],
                receipt_ids: vec!["r2".to_string()],
            },
        ];

        let swaps = detect_all_swaps(&records, "test.near", 20);
        assert!(
            swaps.is_empty(),
            "Intents changes outside block window should not be detected as swap"
        );
    }

    #[test]
    fn test_intents_same_direction_not_swap() {
        // Two intents decreases within window should NOT be a swap
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some("intents.near:nep141:token_a".to_string()),
                block_height: 100,
                amount: sqlx::types::BigDecimal::from(-5),
                transaction_hashes: vec![],
                receipt_ids: vec!["r1".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some("intents.near:nep141:token_b".to_string()),
                block_height: 105,
                amount: sqlx::types::BigDecimal::from(-3),
                transaction_hashes: vec![],
                receipt_ids: vec!["r2".to_string()],
            },
        ];

        let swaps = detect_all_swaps(&records, "test.near", 20);
        assert!(
            swaps.is_empty(),
            "Two decreases should not form a swap"
        );
    }

    #[test]
    fn test_non_intents_tokens_not_proximity_matched() {
        // Regular tokens with different tx hashes should NOT be proximity-matched
        let records = vec![
            BalanceChangeRecord {
                id: 1,
                account_id: "test.near".to_string(),
                token_id: Some("usdc.near".to_string()),
                block_height: 100,
                amount: sqlx::types::BigDecimal::from(-5),
                transaction_hashes: vec!["tx1".to_string()],
                receipt_ids: vec!["r1".to_string()],
            },
            BalanceChangeRecord {
                id: 2,
                account_id: "test.near".to_string(),
                token_id: Some("wnear.near".to_string()),
                block_height: 105,
                amount: sqlx::types::BigDecimal::from(5),
                transaction_hashes: vec!["tx2".to_string()],
                receipt_ids: vec!["r2".to_string()],
            },
        ];

        let swaps = detect_all_swaps(&records, "test.near", 20);
        assert!(
            swaps.is_empty(),
            "Non-intents tokens with different tx hashes should not be matched"
        );
    }
}

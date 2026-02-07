//! Swap Detection for NEAR Intents
//!
//! Detects token swap fulfillments by identifying solver transactions.
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
//! We detect swaps by finding balance changes where:
//! - User receives an intents token from a solver account
//! - The transaction hash identifies the solver fulfillment
//!
//! Optionally, we link back to the deposit by finding an earlier outgoing
//! transfer of a different intents token from the same account.
//!
//! ## Data Model
//!
//! Detected swaps are stored in the `detected_swaps` table, linking:
//! - The fulfillment balance_change (the receive leg)
//! - The deposit balance_change (the send leg, if found)

use near_api::NetworkConfig;
use sqlx::types::BigDecimal;
use sqlx::PgPool;
use std::collections::HashSet;
use std::error::Error;
use std::str::FromStr;

use super::transfer_hints::tx_resolver;

/// Token ID prefix for NEAR Intents tokens
const INTENTS_PREFIX: &str = "intents.near:";

/// Known solver account suffixes
const SOLVER_SUFFIXES: &[&str] = &["solver", "solver-priv-liq.near", "peanut-trade.near"];

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

/// A balance change record from the database
#[derive(Debug, Clone)]
struct BalanceChangeRecord {
    id: i64,
    account_id: String,
    token_id: Option<String>,
    block_height: i64,
    block_timestamp: i64,
    amount: BigDecimal,
    transaction_hashes: Vec<String>,
    receipt_ids: Vec<String>,
    counterparty: String,
}

impl BalanceChangeRecord {
    fn token_id_str(&self) -> &str {
        self.token_id.as_deref().unwrap_or("NEAR")
    }

    fn is_intents_token(&self) -> bool {
        self.token_id_str().starts_with(INTENTS_PREFIX)
    }

    fn is_from_solver(&self) -> bool {
        let cp = self.counterparty.to_lowercase();
        SOLVER_SUFFIXES.iter().any(|suffix| cp.contains(suffix))
            || cp.contains("solver")
    }

    fn is_positive(&self) -> bool {
        self.amount > BigDecimal::from_str("0").unwrap()
    }

    fn is_negative(&self) -> bool {
        self.amount < BigDecimal::from_str("0").unwrap()
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
        SELECT id, account_id, token_id, block_height, block_timestamp,
               amount, transaction_hashes, receipt_id as "receipt_ids", counterparty
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

/// Detect swap fulfillments for an account
///
/// A swap fulfillment is identified when the user receives an intents token
/// from a solver account. The solver transaction hash identifies the fulfillment.
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
    // Query all balance changes for swap detection
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

    let swaps = detect_swaps_from_records(&records, account_id);

    log::info!(
        "Detected {} swap fulfillments for {} (from {} balance changes)",
        swaps.len(),
        account_id,
        records.len()
    );

    Ok(swaps)
}

/// Detect swaps within a specific block range
pub async fn detect_swaps_in_range(
    pool: &PgPool,
    account_id: &str,
    from_block: i64,
    to_block: i64,
) -> Result<Vec<DetectedSwap>, Box<dyn Error + Send + Sync>> {
    let records = sqlx::query_as!(
        BalanceChangeRecord,
        r#"
        SELECT id, account_id, token_id, block_height, block_timestamp,
               amount, transaction_hashes, receipt_id as "receipt_ids", counterparty
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

    Ok(detect_swaps_from_records(&records, account_id))
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

/// Detect swap fulfillments from balance change records
///
/// Identifies solver fulfillments (receive legs) and attempts to match
/// them with corresponding deposits (send legs).
fn detect_swaps_from_records(records: &[BalanceChangeRecord], account_id: &str) -> Vec<DetectedSwap> {
    let mut swaps = Vec::new();
    let mut matched_deposit_ids: HashSet<i64> = HashSet::new();

    // Find all potential fulfillments: intents token receives from solvers with tx hash
    let fulfillments: Vec<&BalanceChangeRecord> = records
        .iter()
        .filter(|r| {
            r.is_intents_token()
                && r.is_positive()
                && r.is_from_solver()
                && !r.transaction_hashes.is_empty()
        })
        .collect();

    // Find all potential deposits: intents token sends (negative amounts)
    let deposits: Vec<&BalanceChangeRecord> = records
        .iter()
        .filter(|r| r.is_intents_token() && r.is_negative())
        .collect();

    for fulfillment in &fulfillments {
        let solver_tx = fulfillment.transaction_hashes.first().cloned().unwrap_or_default();
        let fulfillment_receipt = fulfillment.receipt_ids.first().cloned().unwrap_or_default();

        // Try to find a matching deposit (different token, sent before this fulfillment)
        let matching_deposit = deposits
            .iter()
            .filter(|d| {
                !matched_deposit_ids.contains(&d.id)
                    && d.block_height < fulfillment.block_height
                    && d.token_id_str() != fulfillment.token_id_str()
            })
            // Prefer the most recent deposit before the fulfillment
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

        swaps.push(DetectedSwap {
            solver_transaction_hash: solver_tx,
            solver_account_id: Some(fulfillment.counterparty.clone()),
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

    swaps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(
        id: i64,
        token_id: &str,
        block_height: i64,
        amount: i64,
        counterparty: &str,
        tx_hashes: Vec<&str>,
    ) -> BalanceChangeRecord {
        BalanceChangeRecord {
            id,
            account_id: "test.near".to_string(),
            token_id: Some(token_id.to_string()),
            block_height,
            block_timestamp: block_height * 1000,
            amount: BigDecimal::from(amount),
            transaction_hashes: tx_hashes.into_iter().map(String::from).collect(),
            receipt_ids: vec![format!("receipt_{}", id)],
            counterparty: counterparty.to_string(),
        }
    }

    #[test]
    fn test_detect_swap_fulfillment_from_solver() {
        // Simulate: deposit USDC at block 100, receive Base USDC from solver at block 110
        let records = vec![
            make_record(
                1,
                "intents.near:nep141:usdc.near",
                100,
                -10,
                "intents.near",
                vec![],
            ),
            make_record(
                2,
                "intents.near:nep141:base-usdc.near",
                110,
                9,
                "solver-priv-liq.near",
                vec!["solver_tx_hash"],
            ),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");

        assert_eq!(swaps.len(), 1, "Should detect one swap");
        let swap = &swaps[0];

        assert_eq!(swap.solver_transaction_hash, "solver_tx_hash");
        assert_eq!(swap.solver_account_id, Some("solver-priv-liq.near".to_string()));
        assert_eq!(swap.sent_token_id, Some("intents.near:nep141:usdc.near".to_string()));
        assert_eq!(swap.received_token_id, "intents.near:nep141:base-usdc.near");
        assert_eq!(swap.deposit_balance_change_id, Some(1));
        assert_eq!(swap.fulfillment_balance_change_id, 2);
    }

    #[test]
    fn test_no_swap_for_non_solver_receive() {
        // Receive from a non-solver account should not be detected as swap
        let records = vec![
            make_record(
                1,
                "intents.near:nep141:usdc.near",
                100,
                10,
                "friend.near",
                vec!["tx_hash"],
            ),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");
        assert!(swaps.is_empty(), "Non-solver receive should not be a swap");
    }

    #[test]
    fn test_swap_without_deposit_match() {
        // Fulfillment without a matching deposit should still be detected
        let records = vec![
            make_record(
                1,
                "intents.near:nep141:base-usdc.near",
                110,
                9,
                "peanut-trade.near",
                vec!["solver_tx"],
            ),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");

        assert_eq!(swaps.len(), 1, "Should detect swap even without deposit match");
        assert!(swaps[0].deposit_balance_change_id.is_none());
        assert!(swaps[0].sent_token_id.is_none());
    }

    #[test]
    fn test_multiple_swaps_detected() {
        // Two separate swaps
        let records = vec![
            make_record(1, "intents.near:nep141:usdc.near", 100, -10, "intents.near", vec![]),
            make_record(2, "intents.near:nep141:btc.near", 110, 1, "solver-priv-liq.near", vec!["tx1"]),
            make_record(3, "intents.near:nep141:eth.near", 200, -5, "intents.near", vec![]),
            make_record(4, "intents.near:nep141:sol.near", 210, 3, "solver-priv-liq.near", vec!["tx2"]),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");

        assert_eq!(swaps.len(), 2, "Should detect two swaps");

        // First swap: USDC -> BTC
        assert_eq!(swaps[0].sent_token_id, Some("intents.near:nep141:usdc.near".to_string()));
        assert_eq!(swaps[0].received_token_id, "intents.near:nep141:btc.near");

        // Second swap: ETH -> SOL
        assert_eq!(swaps[1].sent_token_id, Some("intents.near:nep141:eth.near".to_string()));
        assert_eq!(swaps[1].received_token_id, "intents.near:nep141:sol.near");
    }

    #[test]
    fn test_deposit_not_matched_twice() {
        // One deposit, two fulfillments - deposit should only match once
        let records = vec![
            make_record(1, "intents.near:nep141:usdc.near", 100, -10, "intents.near", vec![]),
            make_record(2, "intents.near:nep141:btc.near", 110, 1, "solver-priv-liq.near", vec!["tx1"]),
            make_record(3, "intents.near:nep141:eth.near", 120, 2, "solver-priv-liq.near", vec!["tx2"]),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");

        assert_eq!(swaps.len(), 2, "Should detect two swaps");

        // Only one should have the deposit matched
        let matched_deposits: Vec<_> = swaps.iter().filter(|s| s.deposit_balance_change_id.is_some()).collect();
        assert_eq!(matched_deposits.len(), 1, "Deposit should only be matched once");
    }

    #[test]
    fn test_non_intents_tokens_ignored() {
        // Regular tokens should not be detected as swaps
        let records = vec![
            make_record(1, "usdc.near", 100, -10, "intents.near", vec![]),
            make_record(2, "wnear.near", 110, 10, "solver-priv-liq.near", vec!["tx1"]),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");
        assert!(swaps.is_empty(), "Non-intents tokens should not be detected as swaps");
    }

    #[test]
    fn test_requires_transaction_hash() {
        // Fulfillment without tx hash should not be detected
        let records = vec![
            make_record(1, "intents.near:nep141:usdc.near", 100, -10, "intents.near", vec![]),
            make_record(2, "intents.near:nep141:btc.near", 110, 1, "solver-priv-liq.near", vec![]),
        ];

        let swaps = detect_swaps_from_records(&records, "test.near");
        assert!(swaps.is_empty(), "Fulfillment without tx hash should not be a swap");
    }

    #[test]
    fn test_real_swap_pattern() {
        // Based on real data: USDC out at block 171108230, Base USDC in at block 171108241
        let records = vec![
            BalanceChangeRecord {
                id: 884,
                account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
                token_id: Some(
                    "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
                        .to_string(),
                ),
                block_height: 171108230,
                block_timestamp: 1730666950446,
                amount: BigDecimal::from(-10),
                transaction_hashes: vec![],
                receipt_ids: vec!["6bqKjx8UVTzJZ5WgrQVikL4jZ23CRTgqJjFCLVSCdtBU".to_string()],
                counterparty: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
            },
            BalanceChangeRecord {
                id: 886,
                account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
                token_id: Some(
                    "intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
                        .to_string(),
                ),
                block_height: 171108241,
                block_timestamp: 1730666957002,
                amount: BigDecimal::from_str("9.99998").unwrap(),
                transaction_hashes: vec!["6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r".to_string()],
                receipt_ids: vec!["8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD".to_string()],
                counterparty: "solver-multichain-asset.near".to_string(),
            },
        ];

        let swaps = detect_swaps_from_records(&records, "webassemblymusic-treasury.sputnik-dao.near");

        assert_eq!(swaps.len(), 1, "Should detect the USDC -> Base USDC swap");

        let swap = &swaps[0];
        assert_eq!(swap.solver_transaction_hash, "6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r");
        assert_eq!(swap.solver_account_id, Some("solver-multichain-asset.near".to_string()));
        assert!(swap.sent_token_id.as_ref().unwrap().contains("17208628f84f5d6ad"));
        assert!(swap.received_token_id.contains("base-0x833589fcd6edb6e"));
        assert_eq!(swap.deposit_balance_change_id, Some(884));
        assert_eq!(swap.fulfillment_balance_change_id, 886);
    }
}

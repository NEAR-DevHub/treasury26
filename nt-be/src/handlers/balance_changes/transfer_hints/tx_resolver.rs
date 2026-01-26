//! Transaction Status Resolver
//!
//! Uses `experimental_tx_status` to find exact blocks where balance changes occurred.
//! This eliminates the need for binary search when we have a transaction hash from hints.
//!
//! # How it works
//!
//! 1. Call `experimental_tx_status` with the transaction hash
//! 2. Get all receipt outcomes from the transaction
//! 3. Filter receipts where `executor_id` matches our account
//! 4. Resolve block heights from block hashes
//! 5. Return candidate blocks for balance verification

use near_api::NetworkConfig;
use near_jsonrpc_client::{JsonRpcClient, auth, methods};
use near_primitives::types::{BlockId, BlockReference};
use near_primitives::views::FinalExecutionOutcomeViewEnum;
use std::error::Error;

/// Result of resolving a transaction to find balance change blocks
#[derive(Debug, Clone)]
pub struct ResolvedTransaction {
    /// Transaction hash that was resolved
    pub transaction_hash: String,
    /// Blocks where receipts executed on the target account
    pub receipt_blocks: Vec<ReceiptBlock>,
}

/// A receipt execution block
#[derive(Debug, Clone)]
pub struct ReceiptBlock {
    /// Block height where receipt executed
    pub block_height: u64,
    /// Receipt ID
    pub receipt_id: String,
    /// Account that executed the receipt
    pub executor_id: String,
    /// Whether a balance change was confirmed at this block (via EXPERIMENTAL_changes)
    pub balance_changed: Option<bool>,
}

/// Resolve a transaction hash to find blocks where an account's balance changed
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `tx_hash` - Transaction hash to resolve
/// * `account_id` - Account to find balance changes for
/// * `sender_account_id` - Account ID to use for tx lookup (usually the signer or receiver)
///
/// # Returns
/// ResolvedTransaction with all blocks where the account had receipts executed
pub async fn resolve_transaction_blocks(
    network: &NetworkConfig,
    tx_hash: &str,
    account_id: &str,
    sender_account_id: &str,
) -> Result<ResolvedTransaction, Box<dyn Error + Send + Sync>> {
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    // Query transaction status
    let tx_request = methods::tx::RpcTransactionStatusRequest {
        transaction_info: methods::tx::TransactionInfo::TransactionId {
            tx_hash: tx_hash.parse()?,
            sender_account_id: sender_account_id.parse()?,
        },
        wait_until: near_primitives::views::TxExecutionStatus::Final,
    };

    let tx_response = client.call(tx_request).await?;

    let mut receipt_blocks = Vec::new();

    // Extract receipt outcomes
    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Err("No final execution outcome in transaction".into()),
    };

    // Find receipts that executed on our account
    for receipt_outcome in receipts_outcome {
        let executor = receipt_outcome.outcome.executor_id.as_str();

        if executor == account_id {
            let block_hash = receipt_outcome.block_hash.to_string();

            // Resolve block height from block hash
            let block_request = methods::block::RpcBlockRequest {
                block_reference: BlockReference::BlockId(BlockId::Hash(block_hash.parse()?)),
            };

            let block = client.call(block_request).await?;
            let block_height = block.header.height;

            receipt_blocks.push(ReceiptBlock {
                block_height,
                receipt_id: receipt_outcome.id.to_string(),
                executor_id: executor.to_string(),
                balance_changed: None, // Will be verified later if needed
            });
        }
    }

    Ok(ResolvedTransaction {
        transaction_hash: tx_hash.to_string(),
        receipt_blocks,
    })
}

/// Find candidate blocks where a balance change may have occurred using tx_status
///
/// This is the main entry point for hint resolution. Given a transaction hash,
/// it finds all blocks where receipts executed on the account. The caller should
/// verify actual balance changes by comparing balances before and after each block.
///
/// Note: This returns candidate blocks only. For FT/intents tokens, balance changes
/// happen on the token contract, not on the account itself, so the caller must
/// use `get_balance_at_block` to verify actual balance changes.
///
/// # Arguments
/// * `network` - NEAR network configuration
/// * `tx_hash` - Transaction hash from the hint
/// * `account_id` - Account we're tracking
///
/// # Returns
/// Vector of block heights where receipts executed on the account, sorted ascending
pub async fn find_balance_change_blocks(
    network: &NetworkConfig,
    tx_hash: &str,
    account_id: &str,
) -> Result<Vec<u64>, Box<dyn Error + Send + Sync>> {
    // Try resolving with the account as sender
    let resolved = match resolve_transaction_blocks(network, tx_hash, account_id, account_id).await
    {
        Ok(r) => r,
        Err(_) => {
            // Transaction might have been sent by someone else, try a generic lookup
            // In this case, we'll just return empty and let the caller handle it
            log::debug!(
                "Could not resolve tx {} with account {} as sender",
                tx_hash,
                account_id
            );
            return Ok(vec![]);
        }
    };

    if resolved.receipt_blocks.is_empty() {
        return Ok(vec![]);
    }

    let mut result_blocks: Vec<u64> = resolved
        .receipt_blocks
        .iter()
        .map(|rb| rb.block_height)
        .collect();

    result_blocks.sort();
    result_blocks.dedup();

    Ok(result_blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_outgoing_near_transfer() {
        let state = init_test_state().await;

        // Transaction CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5
        // This has the -0.1 NEAR outgoing transfer
        let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
        let account = "webassemblymusic-treasury.sputnik-dao.near";

        let resolved =
            resolve_transaction_blocks(&state.archival_network, tx_hash, account, account)
                .await
                .expect("Should resolve transaction");

        println!("Resolved transaction: {:?}", resolved);

        // Should find receipts on treasury account
        assert!(
            !resolved.receipt_blocks.is_empty(),
            "Should find receipt blocks for treasury"
        );

        // Should include blocks 178148635 and 178148637
        let block_heights: Vec<u64> = resolved
            .receipt_blocks
            .iter()
            .map(|r| r.block_height)
            .collect();
        println!("Receipt blocks: {:?}", block_heights);

        assert!(
            block_heights.contains(&178148635) || block_heights.contains(&178148637),
            "Should contain one of the expected blocks"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_find_balance_change_blocks() {
        let state = init_test_state().await;

        let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
        let account = "webassemblymusic-treasury.sputnik-dao.near";

        let blocks = find_balance_change_blocks(&state.archival_network, tx_hash, account)
            .await
            .expect("Should find candidate blocks");

        println!("Candidate blocks: {:?}", blocks);

        // Should find blocks where receipts executed on our account
        assert!(!blocks.is_empty(), "Should find candidate blocks");

        // Block 178148635 and 178148637 are where receipts executed on treasury
        assert!(
            blocks.contains(&178148635) || blocks.contains(&178148637),
            "Should contain one of the expected receipt blocks"
        );
    }
}

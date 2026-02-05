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
use std::future::Future;
use tokio::time::{Duration, sleep};

const MAX_RPC_RETRIES: u32 = 3;

/// Check if an RPC error is a transient transport error that should be retried
fn is_transport_error(err_debug: &str) -> bool {
    err_debug.contains("TransportError")
        || err_debug.contains("SendError")
        || err_debug.contains("DispatchGone")
        || err_debug.contains("connection")
        || err_debug.contains("timed out")
}

/// Call an RPC endpoint with retry on transient transport errors.
///
/// Uses exponential backoff (200ms, 400ms, 800ms) between retries.
/// Non-transport errors (e.g. "transaction not found") fail immediately.
async fn call_rpc_with_retry<T, E, F, Fut>(
    label: &str,
    mut make_call: F,
) -> Result<T, Box<dyn Error + Send + Sync>>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: std::fmt::Debug + Error + Send + Sync + 'static,
{
    for attempt in 0..=MAX_RPC_RETRIES {
        if attempt > 0 {
            let delay_ms = 200 * 2u64.pow(attempt - 1);
            log::warn!(
                "{}: transport error, retrying in {}ms (attempt {}/{})",
                label,
                delay_ms,
                attempt + 1,
                MAX_RPC_RETRIES + 1
            );
            sleep(Duration::from_millis(delay_ms)).await;
        }
        match make_call().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                let err_debug = format!("{:?}", e);
                if is_transport_error(&err_debug) && attempt < MAX_RPC_RETRIES {
                    continue;
                }
                return Err(Box::new(e));
            }
        }
    }
    unreachable!()
}

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

    // Parse inputs once (deterministic, no need to retry)
    let parsed_tx_hash: near_primitives::hash::CryptoHash = tx_hash.parse()?;
    let parsed_sender: near_primitives::types::AccountId = sender_account_id.parse()?;

    // Query transaction status with retry on transport errors
    let tx_response = call_rpc_with_retry("tx_status", || {
        let req = methods::tx::RpcTransactionStatusRequest {
            transaction_info: methods::tx::TransactionInfo::TransactionId {
                tx_hash: parsed_tx_hash,
                sender_account_id: parsed_sender.clone(),
            },
            wait_until: near_primitives::views::TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await?;

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

            // Resolve block height from block hash with retry on transport errors
            let parsed_block_hash: near_primitives::hash::CryptoHash = block_hash.parse()?;
            let block = call_rpc_with_retry("block", || {
                let req = methods::block::RpcBlockRequest {
                    block_reference: BlockReference::BlockId(BlockId::Hash(parsed_block_hash)),
                };
                client.call(req)
            })
            .await?;
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

        // Assert transaction hash
        assert_eq!(
            resolved.transaction_hash, tx_hash,
            "Transaction hash should match"
        );

        // Assert we have exactly 2 receipt blocks
        assert_eq!(
            resolved.receipt_blocks.len(),
            2,
            "Should have exactly 2 receipt blocks"
        );

        // Assert first receipt block properties
        assert_eq!(resolved.receipt_blocks[0].block_height, 178148635);
        assert_eq!(
            resolved.receipt_blocks[0].receipt_id,
            "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1"
        );
        assert_eq!(resolved.receipt_blocks[0].executor_id, account);
        assert_eq!(resolved.receipt_blocks[0].balance_changed, None);

        // Assert second receipt block properties
        assert_eq!(resolved.receipt_blocks[1].block_height, 178148637);
        assert_eq!(
            resolved.receipt_blocks[1].receipt_id,
            "9VZewnkJcDPFvxgASNKas17DC1u8fhkPaCfVNuZdCZjq"
        );
        assert_eq!(resolved.receipt_blocks[1].executor_id, account);
        assert_eq!(resolved.receipt_blocks[1].balance_changed, None);
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

        // Should find exactly 2 blocks (sorted and deduped)
        assert_eq!(blocks.len(), 2, "Should have exactly 2 candidate blocks");

        // Blocks should be sorted ascending
        assert_eq!(blocks[0], 178148635);
        assert_eq!(blocks[1], 178148637);
    }
}

//! Transaction Status Resolver
//!
//! Uses `experimental_tx_status` to find exact blocks where balance changes occurred.
//! This eliminates the need for binary search when we have a transaction hash from hints.
//!
//! Also provides `resolve_receipt_to_transaction` which traces a receipt_id back to its
//! originating transaction hash using `EXPERIMENTAL_receipt` and block scanning.
//!
//! # How it works
//!
//! ## Transaction → Receipts (existing)
//! 1. Call `experimental_tx_status` with the transaction hash
//! 2. Get all receipt outcomes from the transaction
//! 3. Filter receipts where `executor_id` matches our account
//! 4. Resolve block heights from block hashes
//! 5. Return candidate blocks for balance verification
//!
//! ## Receipt → Transaction (new)
//! 1. Call `EXPERIMENTAL_receipt` to get the receipt's signer_id
//! 2. Scan the block's chunks for transactions signed by that signer
//! 3. For each candidate transaction, check if it produced our receipt
//! 4. Return the matching transaction hash

use near_api::{Chain, NetworkConfig, Reference};
use near_jsonrpc_client::{JsonRpcClient, auth, methods};
use near_jsonrpc_primitives::types::receipts::ReceiptReference;
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
    let client = create_rpc_client(network)?;

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

/// Result of resolving a receipt to its originating transaction
#[derive(Debug, Clone)]
pub struct ReceiptTransaction {
    /// The receipt ID that was resolved
    pub receipt_id: String,
    /// The originating transaction hash
    pub transaction_hash: String,
    /// The signer of the originating transaction
    pub signer_id: String,
}

/// Create a JSON-RPC client from network config
fn create_rpc_client(
    network: &NetworkConfig,
) -> Result<JsonRpcClient, Box<dyn Error + Send + Sync>> {
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    Ok(client)
}

/// Resolve a receipt_id to its originating transaction hash
///
/// Uses `EXPERIMENTAL_receipt` to fetch the receipt and extract the signer_id,
/// then scans the block's transactions to find the one that produced this receipt.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `receipt_id` - The receipt ID to resolve
/// * `block_height` - The block height where this receipt was executed
///
/// # Returns
/// `ReceiptTransaction` containing the originating transaction hash
pub async fn resolve_receipt_to_transaction(
    network: &NetworkConfig,
    receipt_id: &str,
    block_height: u64,
) -> Result<ReceiptTransaction, Box<dyn Error + Send + Sync>> {
    let client = create_rpc_client(network)?;

    // Step 1: Fetch the receipt to get its signer_id
    let receipt_request = methods::EXPERIMENTAL_receipt::RpcReceiptRequest {
        receipt_reference: ReceiptReference {
            receipt_id: receipt_id.parse()?,
        },
    };

    let receipt_response = client.call(receipt_request).await?;

    // Extract signer_id from the receipt's action data
    let signer_id = match &receipt_response.receipt {
        near_primitives::views::ReceiptEnumView::Action { signer_id, .. } => {
            signer_id.to_string()
        }
        _ => {
            return Err(format!(
                "Receipt {} is not an action receipt - cannot resolve to transaction",
                receipt_id
            )
            .into());
        }
    };

    log::debug!(
        "Receipt {} has signer_id: {}, scanning block {} for originating transaction",
        receipt_id,
        signer_id,
        block_height
    );

    // Step 2: Scan the block and nearby blocks for transactions from this signer
    // The receipt may execute in a different block than where the transaction was included,
    // so we search a small window around the receipt's block
    let search_start = block_height.saturating_sub(5);
    let search_end = block_height + 1;

    for search_block in search_start..=search_end {
        match find_tx_in_block(&client, network, &signer_id, receipt_id, search_block).await {
            Ok(Some(tx_hash)) => {
                log::debug!(
                    "Found originating transaction {} for receipt {} in block {}",
                    tx_hash,
                    receipt_id,
                    search_block
                );
                return Ok(ReceiptTransaction {
                    receipt_id: receipt_id.to_string(),
                    transaction_hash: tx_hash,
                    signer_id,
                });
            }
            Ok(None) => continue,
            Err(e) => {
                log::debug!(
                    "Error scanning block {} for receipt {}: {}",
                    search_block,
                    receipt_id,
                    e
                );
                continue;
            }
        }
    }

    // Step 3: Fallback - try using tx_status with the signer as sender
    // Some transactions can be found by querying with the signer account
    log::debug!(
        "Block scan didn't find tx for receipt {} - trying broader search with signer {}",
        receipt_id,
        signer_id
    );

    // Search chunks of the receipt's block more broadly
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;

    for chunk_header in &block.chunks {
        let chunk_hash_str = chunk_header.chunk_hash.to_string();
        let chunk_request = methods::chunk::RpcChunkRequest {
            chunk_reference: methods::chunk::ChunkReference::ChunkHash {
                chunk_id: chunk_hash_str.parse()?,
            },
        };

        let chunk_response = match client.call(chunk_request).await {
            Ok(chunk) => chunk,
            Err(_) => continue,
        };

        // Check ALL transactions in this chunk, not just those from our signer
        // The receipt may have been created by a cross-contract call
        for tx_view in &chunk_response.transactions {
            let tx_hash_str = tx_view.hash.to_string();
            if has_receipt(&client, &tx_hash_str, &tx_view.signer_id.to_string(), receipt_id)
                .await?
            {
                return Ok(ReceiptTransaction {
                    receipt_id: receipt_id.to_string(),
                    transaction_hash: tx_hash_str,
                    signer_id: tx_view.signer_id.to_string(),
                });
            }
        }
    }

    Err(format!(
        "Could not find originating transaction for receipt {} at block {}",
        receipt_id, block_height
    )
    .into())
}

/// Search a block for transactions from a specific signer that produced a given receipt
async fn find_tx_in_block(
    client: &JsonRpcClient,
    network: &NetworkConfig,
    signer_id: &str,
    receipt_id: &str,
    block_height: u64,
) -> Result<Option<String>, Box<dyn Error + Send + Sync>> {
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;

    for chunk_header in &block.chunks {
        let chunk_hash_str = chunk_header.chunk_hash.to_string();
        let chunk_request = methods::chunk::RpcChunkRequest {
            chunk_reference: methods::chunk::ChunkReference::ChunkHash {
                chunk_id: chunk_hash_str.parse()?,
            },
        };

        let chunk_response = match client.call(chunk_request).await {
            Ok(chunk) => chunk,
            Err(_) => continue,
        };

        // Look for transactions from our signer
        for tx_view in &chunk_response.transactions {
            if tx_view.signer_id.as_str() != signer_id {
                continue;
            }

            let tx_hash_str = tx_view.hash.to_string();
            if has_receipt(client, &tx_hash_str, signer_id, receipt_id).await? {
                return Ok(Some(tx_hash_str));
            }
        }
    }

    Ok(None)
}

/// Check if a transaction produced a specific receipt
async fn has_receipt(
    client: &JsonRpcClient,
    tx_hash: &str,
    sender_account_id: &str,
    target_receipt_id: &str,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    let tx_request = methods::tx::RpcTransactionStatusRequest {
        transaction_info: methods::tx::TransactionInfo::TransactionId {
            tx_hash: tx_hash.parse()?,
            sender_account_id: sender_account_id.parse()?,
        },
        wait_until: near_primitives::views::TxExecutionStatus::Final,
    };

    let tx_response = client.call(tx_request).await?;

    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Ok(false),
    };

    Ok(receipts_outcome
        .iter()
        .any(|r| r.id.to_string() == target_receipt_id))
}

/// Resolve a receipt_id to its originating transaction hash using all receipt outcomes
///
/// This is a higher-level function that resolves a transaction and returns all receipt-to-tx
/// mappings. Useful for batch resolution of multiple receipts from the same transaction.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `tx_hash` - Known transaction hash
/// * `sender_account_id` - The transaction signer
///
/// # Returns
/// Map of receipt_id → transaction_hash for all receipts in this transaction
pub async fn get_all_receipt_tx_mappings(
    network: &NetworkConfig,
    tx_hash: &str,
    sender_account_id: &str,
) -> Result<Vec<(String, String)>, Box<dyn Error + Send + Sync>> {
    let client = create_rpc_client(network)?;

    let tx_request = methods::tx::RpcTransactionStatusRequest {
        transaction_info: methods::tx::TransactionInfo::TransactionId {
            tx_hash: tx_hash.parse()?,
            sender_account_id: sender_account_id.parse()?,
        },
        wait_until: near_primitives::views::TxExecutionStatus::Final,
    };

    let tx_response = client.call(tx_request).await?;

    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Ok(vec![]),
    };

    Ok(receipts_outcome
        .iter()
        .map(|r| (r.id.to_string(), tx_hash.to_string()))
        .collect())
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

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_receipt_to_transaction() {
        let state = init_test_state().await;

        // Receipt 4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1 is part of
        // transaction CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5
        // and executed at block 178148635
        let receipt_id = "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1";
        let block_height = 178148635;

        let result =
            resolve_receipt_to_transaction(&state.archival_network, receipt_id, block_height)
                .await
                .expect("Should resolve receipt to transaction");

        println!("Resolved receipt: {:?}", result);

        assert_eq!(result.receipt_id, receipt_id, "Receipt ID should match");
        assert_eq!(
            result.transaction_hash, "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
            "Should resolve to the correct originating transaction"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_all_receipt_tx_mappings() {
        let state = init_test_state().await;

        let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
        let sender = "webassemblymusic-treasury.sputnik-dao.near";

        let mappings = get_all_receipt_tx_mappings(&state.archival_network, tx_hash, sender)
            .await
            .expect("Should get receipt-tx mappings");

        println!("Receipt-TX mappings: {:?}", mappings);

        assert!(
            !mappings.is_empty(),
            "Should have at least one receipt mapping"
        );

        // All mappings should point to the same transaction
        for (receipt_id, mapped_tx_hash) in &mappings {
            assert_eq!(
                mapped_tx_hash, tx_hash,
                "Receipt {} should map to transaction {}",
                receipt_id, tx_hash
            );
        }

        // Should contain the known receipt
        let has_known_receipt = mappings
            .iter()
            .any(|(r, _)| r == "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1");
        assert!(
            has_known_receipt,
            "Should contain the known receipt 4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1"
        );
    }
}

//! Block Information Service
//!
//! Functions to query block metadata including timestamps and receipt data via RPC.

use near_api::{Chain, NetworkConfig, Reference};
use near_jsonrpc_client::{JsonRpcClient, auth, methods};
use near_primitives::types::{BlockId, BlockReference};
use near_primitives::views::StateChangesRequestView;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

// Re-export types from near-primitives for convenience
pub use near_primitives::views::{
    ChunkView, ReceiptView, SignedTransactionView, StateChangeWithCauseView,
};

/// In-memory cache for block timestamps to avoid redundant RPC calls
type BlockTimestampCache = Arc<RwLock<HashMap<u64, i64>>>;

/// Receipt execution outcome data for an account at a specific block
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockReceiptData {
    pub block_height: u64,
    pub block_hash: String,
    pub receipts: Vec<ReceiptView>,
}

/// Get block timestamp at a specific block height
///
/// Results are cached in memory to avoid redundant RPC calls.
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `block_height` - The block height to query
/// * `cache` - Optional cache for storing results
///
/// # Returns
/// The block timestamp in nanoseconds since Unix epoch
pub async fn get_block_timestamp(
    network: &NetworkConfig,
    block_height: u64,
    cache: Option<&BlockTimestampCache>,
) -> Result<i64, Box<dyn std::error::Error>> {
    // Check cache first
    if let Some(cache) = cache {
        let read_cache = cache.read().await;
        if let Some(&timestamp) = read_cache.get(&block_height) {
            return Ok(timestamp);
        }
    }

    // Query from RPC
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;

    let timestamp = block.header.timestamp as i64;

    // Store in cache
    if let Some(cache) = cache {
        let mut write_cache = cache.write().await;
        write_cache.insert(block_height, timestamp);
    }

    Ok(timestamp)
}

/// Get block data including all receipts affecting a specific account
///
/// Queries the block, iterates through all chunks, and examines receipts
/// to find all receipts where the account is the receiver.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account ID to look for in receipts  
/// * `block_height` - The block height to query
///
/// # Returns
/// BlockReceiptData containing all relevant receipts, or an error
pub async fn get_block_data(
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
) -> Result<BlockReceiptData, Box<dyn std::error::Error + Send + Sync>> {
    // Query the block first
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;

    let block_hash = block.header.hash.to_string();
    let mut all_receipts = Vec::new();

    // Set up JSON-RPC client for chunk queries
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        // bearer_header already includes "Bearer " prefix from with_api_key()
        // Extract just the token part
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    for chunk_header in &block.chunks {
        let chunk_hash_str = chunk_header.chunk_hash.to_string();

        // Query the chunk using near-jsonrpc-client
        let chunk_request = methods::chunk::RpcChunkRequest {
            chunk_reference: methods::chunk::ChunkReference::ChunkHash {
                chunk_id: chunk_hash_str.parse()?,
            },
        };

        let chunk_response = match client.call(chunk_request).await {
            Ok(chunk) => chunk,
            Err(e) => {
                eprintln!("Warning: Failed to fetch chunk {}: {}", chunk_hash_str, e);
                continue;
            }
        };

        // Look through receipts for ones affecting our account
        for receipt in chunk_response.receipts {
            if receipt.receiver_id.as_str() == account_id {
                // Store the full receipt - we'll serialize to JSON in raw_data
                all_receipts.push(receipt);
            }
        }
    }

    Ok(BlockReceiptData {
        block_height,
        block_hash,
        receipts: all_receipts,
    })
}

/// Get ALL receipts in a block involving an account (as sender OR receiver)
///
/// Unlike get_block_data which only returns receipts where account is receiver,
/// this returns receipts where the account is either predecessor OR receiver.
/// Useful for token discovery where we need to see outgoing transactions.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account ID to look for in receipts  
/// * `block_height` - The block height to query
///
/// # Returns
/// Vector of all receipts involving the account
pub async fn get_all_account_receipts(
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
) -> Result<Vec<ReceiptView>, Box<dyn std::error::Error + Send + Sync>> {
    // Query the block first
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;

    let mut all_receipts = Vec::new();

    // Set up JSON-RPC client for chunk queries
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    for chunk_header in &block.chunks {
        let chunk_hash_str = chunk_header.chunk_hash.to_string();

        let chunk_request = methods::chunk::RpcChunkRequest {
            chunk_reference: methods::chunk::ChunkReference::ChunkHash {
                chunk_id: chunk_hash_str.parse()?,
            },
        };

        let chunk_response = match client.call(chunk_request).await {
            Ok(chunk) => chunk,
            Err(e) => {
                eprintln!("Warning: Failed to fetch chunk {}: {}", chunk_hash_str, e);
                continue;
            }
        };

        // Look through receipts for ones involving our account (as sender OR receiver)
        for receipt in chunk_response.receipts {
            if receipt.receiver_id.as_str() == account_id
                || receipt.predecessor_id.as_str() == account_id
            {
                all_receipts.push(receipt);
            }
        }
    }

    Ok(all_receipts)
}

/// Get account changes for a specific account at a specific block
///
/// Queries the EXPERIMENTAL_changes RPC endpoint to find state changes
/// for the given account at the specified block.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account ID to query changes for
/// * `block_height` - The block height to query
///
/// # Returns
/// Vector of state changes for the account, or an error
pub async fn get_account_changes(
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
) -> Result<Vec<StateChangeWithCauseView>, Box<dyn std::error::Error + Send + Sync>> {
    // Set up JSON-RPC client
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    let request = methods::EXPERIMENTAL_changes::RpcStateChangesInBlockByTypeRequest {
        block_reference: BlockReference::BlockId(BlockId::Height(block_height)),
        state_changes_request: StateChangesRequestView::AccountChanges {
            account_ids: vec![account_id.parse()?],
        },
    };

    let response = client.call(request).await?;

    Ok(response.changes)
}

/// Get transaction details by transaction hash
///
/// Queries the EXPERIMENTAL_tx_status RPC endpoint to get full transaction details
/// including signer, receiver, and actions.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `tx_hash` - The transaction hash to query
/// * `account_id` - The account that signed or received the transaction
///
/// # Returns
/// Transaction response with full details, or an error
pub async fn get_transaction(
    network: &NetworkConfig,
    tx_hash: &str,
    account_id: &str,
) -> Result<
    near_jsonrpc_client::methods::tx::RpcTransactionResponse,
    Box<dyn std::error::Error + Send + Sync>,
> {
    use near_jsonrpc_client::methods;
    use near_primitives::hash::CryptoHash;

    // Set up JSON-RPC client
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    let tx_hash_crypto: CryptoHash = tx_hash.parse()?;
    let account_id_parsed = account_id.parse()?;

    let request = methods::tx::RpcTransactionStatusRequest {
        transaction_info: methods::tx::TransactionInfo::TransactionId {
            tx_hash: tx_hash_crypto,
            sender_account_id: account_id_parsed,
        },
        wait_until: near_primitives::views::TxExecutionStatus::Final,
    };

    let response = client.call(request).await?;

    Ok(response)
}

/// Create a new block timestamp cache
pub fn new_cache() -> BlockTimestampCache {
    Arc::new(RwLock::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[tokio::test]
    async fn test_query_mainnet_block_timestamp() {
        let state = init_test_state().await;

        let cache = new_cache();

        // Block 151386339 from test data
        let timestamp = get_block_timestamp(&state.archival_network, 151386339, Some(&cache))
            .await
            .unwrap();

        // Block 151386339 has a fixed timestamp that won't change
        assert_eq!(
            timestamp, 1750097144159145697,
            "Block 151386339 timestamp should be exactly 1750097144159145697"
        );
    }

    #[tokio::test]
    async fn test_cache_works() {
        // Add a small delay to avoid rate limiting
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let state = init_test_state().await;

        let cache = new_cache();

        // First call - should fetch from RPC
        let timestamp1 = get_block_timestamp(&state.archival_network, 151386339, Some(&cache))
            .await
            .unwrap();

        // Second call - should use cache
        let timestamp2 = get_block_timestamp(&state.archival_network, 151386339, Some(&cache))
            .await
            .unwrap();

        // Should return same value
        assert_eq!(timestamp1, timestamp2);

        // Verify cache contains the entry
        let read_cache = cache.read().await;
        assert!(read_cache.contains_key(&151386339));
    }

    #[tokio::test]
    async fn test_get_account_changes_block_178148634() {
        use near_primitives::views::{StateChangeCauseView, StateChangeValueView};

        let state = init_test_state().await;

        let changes =
            get_account_changes(&state.archival_network, "petersalomonsen.near", 178148634)
                .await
                .expect("Should successfully query account changes");

        println!("Account changes for petersalomonsen.near at block 178148634:");
        println!("{:#?}", changes);

        // Verify we got exactly one change
        assert!(!changes.is_empty(), "Should have at least one state change");
        let change = &changes[0];

        // Verify the cause is TransactionProcessing with the correct tx_hash
        match &change.cause {
            StateChangeCauseView::TransactionProcessing { tx_hash } => {
                assert_eq!(
                    tx_hash.to_string(),
                    "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
                    "Transaction hash should match"
                );
            }
            _ => panic!(
                "Expected TransactionProcessing cause, got {:?}",
                change.cause
            ),
        }

        // Verify the value is an AccountUpdate with the correct balance
        match &change.value {
            StateChangeValueView::AccountUpdate {
                account_id,
                account,
            } => {
                assert_eq!(
                    account_id.as_str(),
                    "petersalomonsen.near",
                    "Account ID should match"
                );
                assert_eq!(
                    account.amount.as_yoctonear(),
                    47131979815366840642871301,
                    "New balance should be 47131979815366840642871301 yoctoNEAR"
                );
            }
            _ => panic!("Expected AccountUpdate value, got {:?}", change.value),
        }
    }

    #[tokio::test]
    async fn test_get_account_changes_block_178086209() {
        use near_primitives::views::{StateChangeCauseView, StateChangeValueView};

        let state = init_test_state().await;

        println!("\n=== Querying block 178086209 for petersalomonsen.near ===");

        let changes =
            get_account_changes(&state.archival_network, "petersalomonsen.near", 178086209)
                .await
                .expect("Should successfully query account changes");

        println!("Account changes for petersalomonsen.near at block 178086209:");
        println!("{:#?}", changes);

        if changes.is_empty() {
            println!("✗ No state changes found at block 178086209");
        } else {
            println!("✓ Found {} state change(s)", changes.len());

            for (i, change) in changes.iter().enumerate() {
                println!("\n--- Change {} ---", i + 1);

                // Print the cause
                match &change.cause {
                    StateChangeCauseView::TransactionProcessing { tx_hash } => {
                        println!("  Cause: TransactionProcessing");
                        println!("  Transaction hash: {}", tx_hash);
                    }
                    StateChangeCauseView::ReceiptProcessing { receipt_hash } => {
                        println!("  Cause: ReceiptProcessing");
                        println!("  Receipt hash: {}", receipt_hash);
                    }
                    other => {
                        println!("  Cause: {:?}", other);
                    }
                }

                // Print the value
                match &change.value {
                    StateChangeValueView::AccountUpdate {
                        account_id,
                        account,
                    } => {
                        println!("  Type: AccountUpdate");
                        println!("  Account: {}", account_id);
                        println!("  New balance: {} yoctoNEAR", account.amount.as_yoctonear());
                    }
                    StateChangeValueView::DataUpdate {
                        account_id,
                        key,
                        value,
                    } => {
                        println!("  Type: DataUpdate");
                        println!("  Account: {}", account_id);
                        println!("  Key: {:?}", key);
                        println!("  Value length: {} bytes", value.len());
                    }
                    other => {
                        println!("  Type: {:?}", other);
                    }
                }
            }
        }

        // Assert that we found at least one change since user claims this block has a change
        assert!(
            !changes.is_empty(),
            "Expected to find state changes at block 178086209"
        );
    }

    #[tokio::test]
    async fn test_get_block_data_with_event_json_logs() {
        let state = init_test_state().await;

        println!("\n=== Testing block 177751529 for EVENT_JSON logs ===");
        println!("This block should have ft_transfer EVENT_JSON for petersalomonsen.near");
        println!("Receipt: CX6MePrrcvuQA6Pgv4BueCkSVpbPbq1voDC5KuNRMg1t");
        println!("From: distribution.nearmobile.near");
        println!("To: petersalomonsen.near");
        println!("Amount: 41414178022306048887375898");

        // Test 1: Get block data for petersalomonsen.near (receiver)
        println!("\n--- Query 1: petersalomonsen.near as receiver ---");
        let block_data = get_block_data(&state.archival_network, "petersalomonsen.near", 177751529)
            .await
            .expect("Should successfully query block data");

        println!("Block height: {}", block_data.block_height);
        println!("Block hash: {}", block_data.block_hash);
        println!(
            "Total receipts for petersalomonsen.near: {}",
            block_data.receipts.len()
        );

        for (i, receipt) in block_data.receipts.iter().enumerate() {
            println!("\n  Receipt {}:", i + 1);
            println!("    Receipt ID: {}", receipt.receipt_id);
            println!("    Predecessor: {}", receipt.predecessor_id);
            println!("    Receiver: {}", receipt.receiver_id);
            println!("    Receipt: {:#?}", receipt.receipt);
        }

        // Test 2: Get block data for npro.nearmobile.near (token contract)
        println!("\n--- Query 2: npro.nearmobile.near as receiver (token contract) ---");
        let token_block_data =
            get_block_data(&state.archival_network, "npro.nearmobile.near", 177751529)
                .await
                .expect("Should successfully query block data for token contract");

        println!(
            "Total receipts for npro.nearmobile.near: {}",
            token_block_data.receipts.len()
        );

        for (i, receipt) in token_block_data.receipts.iter().enumerate() {
            println!("\n  Receipt {}:", i + 1);
            println!("    Receipt ID: {}", receipt.receipt_id);
            println!("    Predecessor: {}", receipt.predecessor_id);
            println!("    Receiver: {}", receipt.receiver_id);
            println!("    Receipt: {:#?}", receipt.receipt);
        }

        // Test 3: Get ALL receipts in the block (to see if we're missing something)
        println!("\n--- Query 3: Get all account receipts (sender or receiver) ---");
        let all_receipts =
            get_all_account_receipts(&state.archival_network, "petersalomonsen.near", 177751529)
                .await
                .expect("Should successfully query all receipts");

        println!(
            "Total receipts involving petersalomonsen.near: {}",
            all_receipts.len()
        );

        for (i, receipt) in all_receipts.iter().enumerate() {
            println!("\n  Receipt {}:", i + 1);
            println!("    Receipt ID: {}", receipt.receipt_id);
            println!("    Predecessor: {}", receipt.predecessor_id);
            println!("    Receiver: {}", receipt.receiver_id);
            println!("    Receipt: {:#?}", receipt.receipt);
        }

        // We should find at least some receipts
        assert!(
            !block_data.receipts.is_empty()
                || !token_block_data.receipts.is_empty()
                || !all_receipts.is_empty(),
            "Should find at least some receipts in block 177751529"
        );

        // Test 4: Get chunk with execution outcomes to see EVENT_JSON logs
        println!("\n--- Query 4: Get chunk with execution outcomes (includes EVENT_JSON logs) ---");

        let rpc_endpoint = state
            .archival_network
            .rpc_endpoints
            .first()
            .expect("Should have RPC endpoint");

        let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

        if let Some(bearer) = &rpc_endpoint.bearer_header {
            let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
            client = client.header(auth::Authorization::bearer(token).unwrap());
        }

        // Get the block first to find the right chunk
        let block = Chain::block()
            .at(Reference::AtBlock(177751529))
            .fetch_from(&state.archival_network)
            .await
            .expect("Should be able to query block");

        // Look through each chunk for our receipt
        for chunk_header in &block.chunks {
            let chunk_hash_str = chunk_header.chunk_hash.to_string();

            let chunk_request = methods::chunk::RpcChunkRequest {
                chunk_reference: methods::chunk::ChunkReference::ChunkHash {
                    chunk_id: chunk_hash_str.parse().unwrap(),
                },
            };

            let chunk_response = client.call(chunk_request).await.expect("Should get chunk");

            // Check if this chunk has our receipt
            let has_our_receipt = chunk_response.receipts.iter().any(|r| {
                r.receipt_id.to_string() == "CX6MePrrcvuQA6Pgv4BueCkSVpbPbq1voDC5KuNRMg1t"
            });

            if has_our_receipt {
                println!("\n✓✓✓ Found our receipt in chunk {} ✓✓✓", chunk_hash_str);
                println!("\n=== Chunk Details ===");
                println!("Chunk hash: {}", chunk_hash_str);
                println!("Author: {}", chunk_response.author);
                println!("Header height: {}", chunk_response.header.height_created);
                println!("Total receipts in chunk: {}", chunk_response.receipts.len());
                println!(
                    "Total transactions in chunk: {}",
                    chunk_response.transactions.len()
                );

                // Print all receipt IDs in this chunk
                println!("\nAll receipt IDs in this chunk:");
                for (i, r) in chunk_response.receipts.iter().enumerate() {
                    let is_ours =
                        r.receipt_id.to_string() == "CX6MePrrcvuQA6Pgv4BueCkSVpbPbq1voDC5KuNRMg1t";
                    let marker = if is_ours { " ← OUR RECEIPT" } else { "" };
                    println!(
                        "  {}: {} (from {} to {}){}",
                        i + 1,
                        r.receipt_id,
                        r.predecessor_id,
                        r.receiver_id,
                        marker
                    );
                }

                println!("\n=== Transactions in this chunk ===");
                if chunk_response.transactions.is_empty() {
                    println!("⚠️  NO TRANSACTIONS in this chunk!");
                    println!("The receipt was created by a transaction in a DIFFERENT chunk.");
                    println!(
                        "Receipt execution happens in a different chunk from where the transaction was submitted."
                    );
                } else {
                    println!(
                        "Chunk has {} transactions:",
                        chunk_response.transactions.len()
                    );
                }

                for (i, tx_view) in chunk_response.transactions.iter().enumerate() {
                    println!(
                        "Transaction {}: {} from {} to {}",
                        i + 1,
                        tx_view.hash,
                        tx_view.signer_id,
                        tx_view.receiver_id
                    );

                    // Get full transaction details
                    let tx_request = methods::tx::RpcTransactionStatusRequest {
                        transaction_info: methods::tx::TransactionInfo::TransactionId {
                            tx_hash: tx_view.hash.to_string().parse().unwrap(),
                            sender_account_id: tx_view.signer_id.clone(),
                        },
                        wait_until: near_primitives::views::TxExecutionStatus::Final,
                    };

                    match client.call(tx_request).await {
                        Ok(tx_response) => {
                            println!("\n  Transaction details for {}:", tx_view.hash);

                            // Check the final execution outcome
                            if let Some(final_outcome_enum) = &tx_response.final_execution_outcome {
                                use near_primitives::views::FinalExecutionOutcomeViewEnum;

                                let receipts_outcome = match final_outcome_enum {
                                    FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome) => &outcome.receipts_outcome,
                                    FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome) => &outcome.final_outcome.receipts_outcome,
                                };

                                // Check all receipt outcomes
                                for (j, outcome) in receipts_outcome.iter().enumerate() {
                                    println!("\n  Receipt outcome {}:", j + 1);
                                    println!("    Receipt ID: {}", outcome.id);
                                    println!("    Executor: {}", outcome.outcome.executor_id);

                                    if outcome.id.to_string()
                                        == "CX6MePrrcvuQA6Pgv4BueCkSVpbPbq1voDC5KuNRMg1t"
                                    {
                                        println!("\n    ✓✓✓ THIS IS OUR RECEIPT! ✓✓✓");
                                        println!("    Status: {:?}", outcome.outcome.status);
                                        println!("    Gas burnt: {}", outcome.outcome.gas_burnt);

                                        if !outcome.outcome.logs.is_empty() {
                                            println!(
                                                "\n    === LOGS ({} total) ===",
                                                outcome.outcome.logs.len()
                                            );
                                            for (k, log) in outcome.outcome.logs.iter().enumerate()
                                            {
                                                println!("\n    Log {}:", k + 1);
                                                println!("    {}", log);

                                                if log.starts_with("EVENT_JSON:") {
                                                    println!("    ^^^ EVENT_JSON LOG FOUND! ^^^");
                                                    if let Some(json_str) =
                                                        log.strip_prefix("EVENT_JSON:")
                                                    {
                                                        match serde_json::from_str::<
                                                            serde_json::Value,
                                                        >(
                                                            json_str
                                                        ) {
                                                            Ok(json) => {
                                                                println!(
                                                                    "\n    Parsed EVENT_JSON:"
                                                                );
                                                                println!("{:#}", json);
                                                            }
                                                            Err(e) => println!(
                                                                "    Failed to parse: {}",
                                                                e
                                                            ),
                                                        }
                                                    }
                                                }
                                            }
                                        } else {
                                            println!("    No logs found (unexpected!)");
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            println!("  Failed to get transaction details: {}", e);
                        }
                    }
                }

                break; // Found our chunk, no need to check others
            }
        }
    }
}

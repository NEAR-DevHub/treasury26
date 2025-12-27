//! Block Information Service
//!
//! Functions to query block metadata including timestamps and receipt data via RPC.

use near_api::{Chain, NetworkConfig, Reference};
use near_jsonrpc_client::{JsonRpcClient, methods, auth};
use near_primitives::types::{BlockReference, BlockId};
use near_primitives::views::StateChangesRequestView;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

// Re-export types from near-primitives for convenience
pub use near_primitives::views::{ChunkView, ReceiptView, SignedTransactionView, StateChangeWithCauseView};

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
        
        // Debug: print chunk info
        let tx_count = chunk_response.transactions.len();
        let receipt_count = chunk_response.receipts.len();
        eprintln!("Chunk {} has {} transactions and {} receipts", 
                  chunk_hash_str, tx_count, receipt_count);

        // Look through receipts for ones affecting our account
        for receipt in chunk_response.receipts {
            if receipt.receiver_id.as_str() == account_id {
                // Debug: print full receipt structure
                eprintln!("Receipt details: {:#?}", receipt);
                
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
        use near_primitives::views::{StateChangeValueView, StateChangeCauseView};
        
        let state = init_test_state().await;

        let changes = get_account_changes(
            &state.archival_network,
            "petersalomonsen.near",
            178148634,
        )
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
            _ => panic!("Expected TransactionProcessing cause, got {:?}", change.cause),
        }
        
        // Verify the value is an AccountUpdate with the correct balance
        match &change.value {
            StateChangeValueView::AccountUpdate { account_id, account } => {
                assert_eq!(account_id.as_str(), "petersalomonsen.near", "Account ID should match");
                assert_eq!(
                    account.amount.as_yoctonear(),
                    47131979815366840642871301,
                    "New balance should be 47131979815366840642871301 yoctoNEAR"
                );
            }
            _ => panic!("Expected AccountUpdate value, got {:?}", change.value),
        }
    }
}

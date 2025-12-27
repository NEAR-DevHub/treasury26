//! Block Information Service
//!
//! Functions to query block metadata including timestamps via RPC.

use near_api::{Chain, NetworkConfig, Reference};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// In-memory cache for block timestamps to avoid redundant RPC calls
type BlockTimestampCache = Arc<RwLock<HashMap<u64, i64>>>;

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
}

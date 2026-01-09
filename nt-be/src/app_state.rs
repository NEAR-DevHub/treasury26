use chrono::{DateTime, Utc};
use near_api::{AccountId, NetworkConfig, RPCEndpoint, Signer};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

use crate::{
    services::{CoinGeckoClient, PriceLookupService},
    utils::{cache::Cache, env::EnvVars},
};

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache,
    pub signer: Arc<Signer>,
    pub signer_id: AccountId,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: EnvVars,
    pub db_pool: PgPool,
    pub price_service: Option<PriceLookupService<CoinGeckoClient>>,
}

impl AppState {
    /// Initialize the application state with database connection and migrations
    pub async fn new() -> Result<AppState, Box<dyn std::error::Error>> {
        let env_vars = EnvVars::default();

        // Database connection
        log::info!("Connecting to database...");
        let db_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(Duration::from_secs(3))
            .connect(&env_vars.database_url)
            .await?;

        log::info!("Running database migrations...");
        sqlx::migrate!("./migrations").run(&db_pool).await?;

        log::info!("Database connection established successfully");

        let http_client = reqwest::Client::new();

        // Initialize price service if CoinGecko API key is available
        let price_service = env_vars.coingecko_api_key.as_ref().map(|api_key| {
            // Use custom base URL if provided (for testing with mock server)
            let coingecko_client = if let Some(base_url) = &env_vars.coingecko_api_base_url {
                log::info!(
                    "CoinGecko API key found, using custom base URL: {}",
                    base_url
                );
                CoinGeckoClient::with_base_url(
                    http_client.clone(),
                    api_key.clone(),
                    base_url.clone(),
                )
            } else {
                log::info!("CoinGecko API key found, initializing price service");
                CoinGeckoClient::new(http_client.clone(), api_key.clone())
            };
            PriceLookupService::new(db_pool.clone(), coingecko_client)
        });

        if price_service.is_none() {
            log::info!("No CoinGecko API key found, price enrichment will be disabled");
        }

        Ok(AppState {
            http_client,
            cache: Cache::new(),
            signer: Signer::from_secret_key(env_vars.signer_key.clone())
                .expect("Failed to create signer."),
            signer_id: env_vars.signer_id.clone(),
            network: NetworkConfig {
                rpc_endpoints: vec![
                    RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
                        .with_api_key(env_vars.fastnear_api_key.clone()),
                ],
                ..NetworkConfig::mainnet()
            },
            archival_network: NetworkConfig {
                rpc_endpoints: vec![
                    RPCEndpoint::new(
                        "https://archival-rpc.mainnet.fastnear.com/"
                            .parse()
                            .unwrap(),
                    )
                    .with_api_key(env_vars.fastnear_api_key.clone()),
                ],
                ..NetworkConfig::mainnet()
            },
            env_vars,
            db_pool,
            price_service,
        })
    }

    /// Find the block height for a given timestamp
    ///
    /// This method performs the following steps:
    /// 1. Try to lookup the block height from the database (balance_changes table)
    /// 2. If not found in DB, use binary search with NEAR RPC to locate the block
    /// 3. Return an error if both methods fail
    ///
    /// # Arguments
    /// * `date` - The UTC timestamp to find the corresponding block for
    ///
    /// # Returns
    /// * `Ok(u64)` - The block height at or near the given timestamp
    /// * `Err` - If the block cannot be found
    pub async fn find_block_height(
        &self,
        date: DateTime<Utc>,
    ) -> Result<u64, Box<dyn std::error::Error>> {
        // Convert DateTime to nanoseconds since Unix epoch (NEAR's timestamp format)
        let target_timestamp_ns = date.timestamp_nanos_opt().ok_or("Timestamp out of range")?;

        // Step 1: Try to find a block in the database with a timestamp close to the target
        let db_result = sqlx::query!(
            r#"
            SELECT block_height, block_timestamp
            FROM balance_changes
            WHERE block_timestamp >= $1
            ORDER BY block_timestamp ASC
            LIMIT 1
            "#,
            target_timestamp_ns
        )
        .fetch_optional(&self.db_pool)
        .await?;

        if let Some(record) = db_result {
            log::info!(
                "Found block {} in database for timestamp {}",
                record.block_height,
                date
            );
            return Ok(record.block_height as u64);
        }

        log::info!(
            "Block not found in database for timestamp {}, using binary search via RPC",
            date
        );

        // Step 2: Use binary search to find the block via RPC
        let block_height = self
            .binary_search_block_by_timestamp(target_timestamp_ns)
            .await?;

        Ok(block_height)
    }

    /// Binary search for block height by timestamp using NEAR RPC
    ///
    /// Uses the archival RPC to query blocks and find the block that matches
    /// or is closest to the target timestamp.
    ///
    /// # Arguments
    /// * `target_timestamp_ns` - Target timestamp in nanoseconds since Unix epoch
    ///
    /// # Returns
    /// * `Ok(u64)` - The block height closest to the target timestamp
    /// * `Err` - If the search fails
    async fn binary_search_block_by_timestamp(
        &self,
        target_timestamp_ns: i64,
    ) -> Result<u64, Box<dyn std::error::Error>> {
        use near_api::{Chain, Reference};

        // Get the latest block to establish the search range
        let latest_block = Chain::block().fetch_from(&self.archival_network).await?;

        let mut left = 1u64; // Genesis block
        let mut right = latest_block.header.height;
        let mut result = right;

        // Validate that the target timestamp is within range
        let latest_timestamp = latest_block.header.timestamp as i64;
        if target_timestamp_ns > latest_timestamp {
            return Err(format!(
                "Target timestamp {} is in the future (latest block timestamp: {})",
                target_timestamp_ns, latest_timestamp
            )
            .into());
        }

        log::info!(
            "Binary searching for block with timestamp {} in range [{}, {}]",
            target_timestamp_ns,
            left,
            right
        );

        // Binary search for the block with the closest timestamp
        while left <= right {
            let mid = left + (right - left) / 2;

            let mid_block = Chain::block()
                .at(Reference::AtBlock(mid))
                .fetch_from(&self.archival_network)
                .await?;

            let mid_timestamp = mid_block.header.timestamp as i64;

            log::debug!(
                "Checking block {} with timestamp {} (target: {})",
                mid,
                mid_timestamp,
                target_timestamp_ns
            );

            if mid_timestamp < target_timestamp_ns {
                // Target is in a later block
                left = mid + 1;
            } else if mid_timestamp > target_timestamp_ns {
                // Target is in an earlier block
                result = mid;
                if mid == 0 {
                    break;
                }
                right = mid - 1;
            } else {
                // Exact match found
                log::info!(
                    "Found exact match at block {} for timestamp {}",
                    mid,
                    target_timestamp_ns
                );
                return Ok(mid);
            }
        }

        // Return the first block with timestamp >= target
        log::info!(
            "Binary search completed. Closest block: {} for timestamp {}",
            result,
            target_timestamp_ns
        );

        Ok(result)
    }
}

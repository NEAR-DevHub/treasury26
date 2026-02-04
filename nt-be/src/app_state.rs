use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use near_api::{AccountId, NetworkConfig, RPCEndpoint, Signer};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

use crate::{
    handlers::balance_changes::transfer_hints::{TransferHintService, fastnear::FastNearProvider},
    services::{DeFiLlamaClient, PriceLookupService},
    utils::{
        cache::{Cache, CacheKey, CacheTier},
        env::EnvVars,
        telegram::TelegramClient,
    },
};

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache,
    pub signer: Arc<Signer>,
    pub bulk_payment_signer: Arc<Signer>,
    pub signer_id: AccountId,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: EnvVars,
    pub db_pool: PgPool,
    pub price_service: PriceLookupService<DeFiLlamaClient>,
    pub bulk_payment_contract_id: AccountId,
    pub telegram_client: TelegramClient,
    /// Optional transfer hint service for accelerated balance change detection
    pub transfer_hint_service: Option<TransferHintService>,
}

/// Builder for constructing AppState instances
///
/// This builder makes it easy to construct AppState for tests by allowing
/// you to specify only the fields you need, with sensible defaults for the rest.
///
/// # Example
///
/// ```rust,no_run
/// use nt_be::AppState;
/// use sqlx::PgPool;
///
/// # async fn example(pool: PgPool) {
/// let state = AppState::builder()
///     .db_pool(pool)
///     .build()
///     .await
///     .expect("Failed to build AppState");
/// # }
/// ```
pub struct AppStateBuilder {
    http_client: Option<reqwest::Client>,
    cache: Option<Cache>,
    signer: Option<Arc<Signer>>,
    bulk_payment_signer: Option<Arc<Signer>>,
    signer_id: Option<AccountId>,
    network: Option<NetworkConfig>,
    archival_network: Option<NetworkConfig>,
    env_vars: Option<EnvVars>,
    db_pool: Option<PgPool>,
    price_service: Option<PriceLookupService<DeFiLlamaClient>>,
    bulk_payment_contract_id: Option<AccountId>,
    telegram_client: Option<TelegramClient>,
    transfer_hint_service: Option<TransferHintService>,
}

impl AppStateBuilder {
    /// Create a new AppStateBuilder with all fields unset
    pub fn new() -> Self {
        Self {
            http_client: None,
            cache: None,
            signer: None,
            bulk_payment_signer: None,
            signer_id: None,
            network: None,
            archival_network: None,
            env_vars: None,
            db_pool: None,
            price_service: None,
            bulk_payment_contract_id: None,
            telegram_client: None,
            transfer_hint_service: None,
        }
    }

    /// Set the HTTP client
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http_client = Some(client);
        self
    }

    /// Set the cache
    pub fn cache(mut self, cache: Cache) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Set the signer
    pub fn signer(mut self, signer: Arc<Signer>) -> Self {
        self.signer = Some(signer);
        self
    }

    /// Set the bulk payment signer
    pub fn bulk_payment_signer(mut self, bulk_payment_signer: Arc<Signer>) -> Self {
        self.bulk_payment_signer = Some(bulk_payment_signer);
        self
    }

    /// Set the telegram client
    pub fn telegram_client(mut self, telegram_client: TelegramClient) -> Self {
        self.telegram_client = Some(telegram_client);
        self
    }

    /// Set the signer ID
    pub fn signer_id(mut self, signer_id: AccountId) -> Self {
        self.signer_id = Some(signer_id);
        self
    }

    /// Set the network configuration
    pub fn network(mut self, network: NetworkConfig) -> Self {
        self.network = Some(network);
        self
    }

    /// Set the archival network configuration
    pub fn archival_network(mut self, archival_network: NetworkConfig) -> Self {
        self.archival_network = Some(archival_network);
        self
    }

    /// Set the environment variables
    pub fn env_vars(mut self, env_vars: EnvVars) -> Self {
        self.env_vars = Some(env_vars);
        self
    }

    /// Set the database pool
    pub fn db_pool(mut self, db_pool: PgPool) -> Self {
        self.db_pool = Some(db_pool);
        self
    }

    /// Set the price service
    pub fn price_service(mut self, price_service: PriceLookupService<DeFiLlamaClient>) -> Self {
        self.price_service = Some(price_service);
        self
    }

    /// Set the transfer hint service
    pub fn transfer_hint_service(mut self, service: TransferHintService) -> Self {
        self.transfer_hint_service = Some(service);
        self
    }

    /// Build the AppState with the configured values or defaults
    ///
    /// Fields not explicitly set will use defaults:
    /// - http_client: reqwest::Client::new()
    /// - cache: Cache::new()
    /// - signer: Test signer from env or default test key
    /// - signer_id: "test.near"
    /// - network: Mainnet with fastnear API (from env)
    /// - archival_network: Archival mainnet with fastnear API (from env)
    /// - env_vars: EnvVars::default()
    /// - db_pool: REQUIRED - must be provided
    /// - price_service: Cache-only service (no provider)
    pub async fn build(self) -> Result<AppState, Box<dyn std::error::Error>> {
        // Load env vars for defaults
        let env_vars = self.env_vars.unwrap_or_default();

        // Database pool is required
        let db_pool = self.db_pool.ok_or("db_pool is required")?;

        // Create default signer if not provided
        let signer = if let Some(s) = self.signer {
            s
        } else {
            // Use test key or key from env
            let test_key = env_vars.signer_key.clone();
            Signer::from_secret_key(test_key).expect("Failed to create default signer")
        };

        let bulk_payment_signer = if let Some(s) = self.bulk_payment_signer {
            s
        } else {
            // Use test key or key from env
            let test_key = env_vars.bulk_payment_signer.clone();
            Signer::from_secret_key(test_key).expect("Failed to create bulk payment signer")
        };

        let signer_id = self.signer_id.unwrap_or_else(|| env_vars.signer_id.clone());

        // Create default networks if not provided
        let fastnear_api_key = env_vars.fastnear_api_key.clone();

        let network = self.network.unwrap_or_else(|| {
            // If NEAR_RPC_URL is set, use it (for sandbox/testing)
            if let Some(rpc_url) = &env_vars.near_rpc_url {
                NetworkConfig {
                    rpc_endpoints: vec![RPCEndpoint::new(
                        rpc_url.parse().expect("Invalid NEAR_RPC_URL"),
                    )],
                    ..NetworkConfig::testnet() // Use testnet defaults for sandbox
                }
            } else {
                // Otherwise use mainnet with FastNEAR
                NetworkConfig {
                    rpc_endpoints: vec![
                        RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
                            .with_api_key(fastnear_api_key.clone()),
                    ],
                    ..NetworkConfig::mainnet()
                }
            }
        });

        let archival_network = self.archival_network.unwrap_or_else(|| {
            // If NEAR_ARCHIVAL_RPC_URL is set, use it
            // Otherwise fall back to NEAR_RPC_URL (sandbox doesn't differentiate)
            // Otherwise use mainnet archival
            if let Some(archival_rpc_url) = &env_vars.near_archival_rpc_url {
                NetworkConfig {
                    rpc_endpoints: vec![RPCEndpoint::new(
                        archival_rpc_url
                            .parse()
                            .expect("Invalid NEAR_ARCHIVAL_RPC_URL"),
                    )],
                    ..NetworkConfig::testnet()
                }
            } else if let Some(rpc_url) = &env_vars.near_rpc_url {
                NetworkConfig {
                    rpc_endpoints: vec![RPCEndpoint::new(
                        rpc_url.parse().expect("Invalid NEAR_RPC_URL"),
                    )],
                    ..NetworkConfig::testnet()
                }
            } else {
                NetworkConfig {
                    rpc_endpoints: vec![
                        RPCEndpoint::new(
                            "https://archival-rpc.mainnet.fastnear.com/"
                                .parse()
                                .unwrap(),
                        )
                        .with_api_key(fastnear_api_key),
                    ],
                    ..NetworkConfig::mainnet()
                }
            }
        });

        // Create default price service (cache-only) if not provided
        let price_service = self
            .price_service
            .unwrap_or_else(|| PriceLookupService::without_provider(db_pool.clone()));

        // Use bulk payment contract from env or default
        let bulk_payment_contract_id = self
            .bulk_payment_contract_id
            .unwrap_or_else(|| env_vars.bulk_payment_contract_id.clone());

        // Create transfer hint service if enabled (and not explicitly provided)
        let transfer_hint_service = if let Some(service) = self.transfer_hint_service {
            Some(service)
        } else if env_vars.transfer_hints_enabled {
            let provider = if let Some(base_url) = &env_vars.transfer_hints_base_url {
                FastNearProvider::with_base_url(archival_network.clone(), base_url.clone())
            } else {
                FastNearProvider::new(archival_network.clone())
            }
            .with_api_key(&env_vars.fastnear_api_key);
            Some(TransferHintService::new().with_provider(provider))
        } else {
            None
        };

        Ok(AppState {
            http_client: self.http_client.unwrap_or_default(),
            cache: self.cache.unwrap_or_default(),
            signer,
            bulk_payment_signer,
            signer_id,
            network,
            telegram_client: self.telegram_client.unwrap_or_default(),
            archival_network,
            env_vars,
            db_pool,
            price_service,
            bulk_payment_contract_id,
            transfer_hint_service,
        })
    }
}

impl Default for AppStateBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    /// Create a new builder for constructing AppState
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use nt_be::AppState;
    /// use sqlx::PgPool;
    ///
    /// # async fn example(pool: PgPool) {
    /// let state = AppState::builder()
    ///     .db_pool(pool)
    ///     .build()
    ///     .await
    ///     .expect("Failed to build AppState");
    /// # }
    /// ```
    pub fn builder() -> AppStateBuilder {
        AppStateBuilder::new()
    }

    /// Initialize the application state with database connection and migrations
    ///
    /// This is the main entry point for production use. For tests, use `AppState::builder()`
    /// to construct instances with only the required fields.
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

        // Initialize price service with DeFiLlama provider (free, no API key required)
        let base_url = &env_vars.defillama_api_base_url;
        log::info!(
            "Initializing DeFiLlama price provider with base URL: {}",
            base_url
        );
        let defillama_client =
            DeFiLlamaClient::with_base_url(http_client.clone(), base_url.clone());
        let price_service = PriceLookupService::new(db_pool.clone(), defillama_client);

        let telegram_client = TelegramClient::new(
            env_vars.telegram_bot_token.clone(),
            env_vars.telegram_chat_id.clone(),
        );

        // Use the builder pattern internally for consistency
        AppStateBuilder::new()
            .http_client(http_client)
            .cache(Cache::new())
            .signer(
                Signer::from_secret_key(env_vars.signer_key.clone())
                    .expect("Failed to create signer."),
            )
            .signer_id(env_vars.signer_id.clone())
            .env_vars(env_vars)
            .db_pool(db_pool)
            .price_service(price_service)
            .telegram_client(telegram_client)
            .build()
            .await
    }

    /// Find the block height for a given timestamp
    ///
    /// This method performs the following steps:
    /// 1. Check the cache for a previously found block height
    /// 2. Try to lookup the block height from the database (balance_changes table)
    /// 3. If not found in DB, use binary search with NEAR RPC to locate the block
    /// 4. Cache the result for future lookups
    /// 5. Return an error if all methods fail
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

        // Build cache key for this timestamp lookup
        let cache_key = CacheKey::new("block-height-by-timestamp")
            .with(target_timestamp_ns)
            .build();

        // Try to get from cache first (using LongTerm tier since block timestamps are immutable)
        self.cache
            .cached(CacheTier::LongTerm, cache_key.clone(), async {
                // Step 1: Try to find a block in the database with a timestamp close to the target
                let db_result = sqlx::query!(
                    r#"
                        SELECT block_height, block_timestamp
                        FROM balance_changes
                        WHERE block_timestamp = $1
                        ORDER BY block_timestamp ASC
                        LIMIT 1
                        "#,
                    target_timestamp_ns
                )
                .fetch_optional(&self.db_pool)
                .await
                .map_err(|e| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Database query error: {}", e),
                    )
                })?;

                if let Some(record) = db_result {
                    log::info!(
                        "Found block {} in database for timestamp {}",
                        record.block_height,
                        date
                    );
                    return Ok::<u64, (StatusCode, String)>(record.block_height as u64);
                }

                log::info!(
                    "Block not found in database for timestamp {}, using binary search via RPC",
                    date
                );

                // Step 2: Use binary search to find the block via RPC
                let block_height = self
                    .binary_search_block_by_timestamp(target_timestamp_ns)
                    .await
                    .map_err(|e| {
                        (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            format!("Binary search error: {}", e),
                        )
                    })?;

                log::info!(
                    "Found block {} via binary search for timestamp {}, caching result",
                    block_height,
                    date
                );

                Ok::<u64, _>(block_height)
            })
            .await
            .map_err(|(status, msg)| -> Box<dyn std::error::Error> {
                Box::new(std::io::Error::other(format!("Status {}: {}", status, msg)))
            })
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
        timestamp_ns: i64,
    ) -> Result<u64, Box<dyn std::error::Error>> {
        use near_api::{Chain, Reference};

        // Get the latest block to establish the search range
        let latest_block = Chain::block().fetch_from(&self.archival_network).await?;

        // Sputnik DAO genesis block
        let mut left = 129265430; // Genesis block
        let mut right = latest_block.header.height;
        let mut result = right;

        // Validate that the target timestamp is within range
        let latest_timestamp: i64 = latest_block.header.timestamp as i64;
        if timestamp_ns > latest_timestamp {
            return Err(format!(
                "Target timestamp {} is in the future (latest block timestamp: {})",
                timestamp_ns, latest_timestamp
            )
            .into());
        }

        log::info!(
            "Binary searching for block with timestamp {} in range [{}, {}]",
            timestamp_ns,
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

            let mid_timestamp: i64 = mid_block.header.timestamp as i64;

            log::debug!(
                "Checking block {} with timestamp {} (target: {})",
                mid,
                mid_timestamp,
                timestamp_ns
            );

            if mid_timestamp < timestamp_ns {
                // Target is in a later block
                left = mid + 1;
            } else if mid_timestamp > timestamp_ns {
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
                    timestamp_ns
                );
                return Ok(mid);
            }
        }

        // Return the first block with timestamp >= target
        log::info!(
            "Binary search completed. Closest block: {} for timestamp {}",
            result,
            timestamp_ns
        );

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;
    use chrono::{DateTime, Utc};
    use sqlx::PgPool;

    /// Test finding block height from database when data exists
    #[sqlx::test]
    async fn test_find_block_height_from_database(pool: PgPool) -> sqlx::Result<()> {
        // Insert a test balance change record
        let account_id = "test.near";
        let block_height: i64 = 151386339;
        let block_timestamp: i64 = 1750097144159145697; // nanoseconds since Unix epoch

        // Calculate block_time from block_timestamp (nanoseconds to timestamptz)
        let block_time = DateTime::<Utc>::from_timestamp_nanos(block_timestamp);

        sqlx::query!(
            r#"
            INSERT INTO balance_changes
            (account_id, block_height, block_timestamp, block_time, transaction_hashes, counterparty, amount, balance_before, balance_after)
            VALUES ($1, $2, $3, $4, '{}', 'test_counterparty', 1000, 0, 1000)
            "#,
            account_id,
            block_height,
            block_timestamp,
            block_time,
        )
        .execute(&pool)
        .await?;

        // Create AppState using builder pattern with test database
        let app_state = super::AppState::builder()
            .db_pool(pool)
            .build()
            .await
            .expect("Failed to build AppState");

        // Convert the block timestamp to DateTime
        let target_date = DateTime::<Utc>::from_timestamp_nanos(block_timestamp);

        // Try to find the block height
        let result = app_state
            .find_block_height(target_date)
            .await
            .expect("Should find block in database");

        assert_eq!(
            result, block_height as u64,
            "Should return the correct block height from database"
        );

        Ok(())
    }

    /// Test finding block height using binary search when not in database
    #[tokio::test]
    async fn test_find_block_height_with_binary_search() {
        let app_state = init_test_state().await;

        // Use a known block timestamp - Block 151386339 from the binary_search tests
        // Timestamp: 1750097144159145697 nanoseconds = ~2025-12-16
        let target_timestamp_ns = 1750097144159145697;
        let target_date = DateTime::<Utc>::from_timestamp_nanos(target_timestamp_ns);

        // Try to find the block height using binary search
        let result = app_state
            .find_block_height(target_date)
            .await
            .expect("Should find block via binary search");

        println!("Found block {} for timestamp {}", result, target_date);

        // The result should be close to the expected block (151386339)
        // Allow some margin since we're searching by timestamp
        assert_eq!(result, 151386339)
    }

    /// Test error handling for future timestamps
    #[tokio::test]
    async fn test_find_block_height_future_timestamp() {
        let app_state = init_test_state().await;

        // Use a timestamp far in the future
        let future_date = DateTime::<Utc>::MAX_UTC;

        // Try to find block height - should fail with error about future timestamp
        let result = app_state.find_block_height(future_date).await;

        assert!(result.is_err(), "Should return error for future timestamp");

        let _error_msg = result.unwrap_err();
    }

    /// Test that find_block_height uses cache for repeated lookups
    #[tokio::test]
    async fn test_find_block_height_cache_behavior() {
        let app_state = init_test_state().await;

        // Use a known block timestamp that will require binary search
        let target_timestamp_ns = 1767606003313746552;
        let target_date = DateTime::<Utc>::from_timestamp_nanos(target_timestamp_ns);

        println!("\n=== First call - should perform binary search and cache result ===");
        let start = std::time::Instant::now();
        let result1 = app_state
            .find_block_height(target_date)
            .await
            .expect("Should find block via binary search");
        let duration1 = start.elapsed();

        println!("First call took: {:?}", duration1);
        println!("Found block: {}", result1);

        println!("\n=== Second call - should use cached result ===");
        let start = std::time::Instant::now();
        let result2 = app_state
            .find_block_height(target_date)
            .await
            .expect("Should find block from cache");
        let duration2 = start.elapsed();

        println!("Second call took: {:?}", duration2);
        println!("Found block: {}", result2);

        // Both calls should return the same block height
        assert_eq!(
            result1, result2,
            "Both lookups should return the same block height"
        );

        // Second call should be significantly faster (cached)
        // Cache lookup should be at least 10x faster than binary search
        println!(
            "\nSpeed improvement: {}x faster",
            duration1.as_micros() / duration2.as_micros().max(1)
        );
        assert!(
            duration2 < duration1 / 5,
            "Cached lookup should be significantly faster (was {:?} vs {:?})",
            duration2,
            duration1
        );

        // Verify the cache key was properly constructed
        let cache_key = CacheKey::new("block-height-by-timestamp")
            .with(target_timestamp_ns)
            .build();
        println!("\nCache key used: {}", cache_key);
        assert_eq!(
            cache_key,
            format!("block-height-by-timestamp:{}", target_timestamp_ns)
        );
    }
}

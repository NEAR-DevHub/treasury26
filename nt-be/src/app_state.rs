use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use near_api::{AccountId, NetworkConfig, RPCEndpoint, Signer};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};
use tokio::sync::broadcast;

use crate::{
    events::{AppEvent, EVENT_BUS_CAPACITY},
    handlers::balance_changes::transfer_hints::{
        TransferHintService, fastnear::FastNearProvider, neardata::NeardataClient,
    },
    handlers::public_history::bronze::NearblocksPriority,
    jobs::leadership::BackgroundJobsStatus,
    services::{
        ConfidentialCredentialStore, DeFiLlamaClient, PriceLookupService, TokenKeyring,
        TokenPriceService,
    },
    utils::{
        cache::{Cache, CacheKey, CacheTier},
        env::EnvVars,
        priority_rate_gate::PriorityRateGate,
        rate_limiter::RateLimiter,
        telegram::TelegramClient,
    },
};

/// Sustained NearBlocks request ceiling (per minute) shared by every NearBlocks
/// caller, overridable via `NEARBLOCKS_MAX_PER_MINUTE`. Kept under the plan's
/// 190/min hard limit to leave headroom for the on-demand v1 call sites; the
/// daily/monthly budget is enforced separately.
const NEARBLOCKS_MAX_PER_MINUTE_DEFAULT: u32 = 10;

fn nearblocks_max_per_minute() -> u32 {
    std::env::var("NEARBLOCKS_MAX_PER_MINUTE")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(NEARBLOCKS_MAX_PER_MINUTE_DEFAULT)
}

/// Sustained DeFiLlama request ceiling (per minute) shared by every DeFiLlama
/// caller. The free tier enforces 500/min per IP; we stay well under it.
const DEFILLAMA_MAX_PER_MINUTE: u32 = 200;

/// Per-endpoint RPC retries before near-api fails over to the next endpoint
/// (near-api's default is 5). Bumped so transient RPC hiccups are absorbed
/// before giving up on an endpoint.
///
/// NOTE: near-api only fails over on retryable errors (HTTP 408/429/5xx from a
/// reachable server); hard connection errors and client timeouts are treated as
/// `Critical` and abort immediately without failover. Timeout/connection
/// resilience therefore comes from the multiple endpoints.
const RPC_ENDPOINT_RETRIES: u8 = 7;

/// Build the default mainnet RPC endpoints with provider-level failover.
///
/// FastNEAR (authenticated) is primary; public providers act as fallbacks so a
/// single degraded provider can't stall signing/read flows.
fn default_mainnet_endpoints(fastnear_api_key: &str) -> Vec<RPCEndpoint> {
    vec![
        RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
            .with_api_key(fastnear_api_key.to_string())
            .with_retries(RPC_ENDPOINT_RETRIES),
        // Open fallbacks (no API key).
        RPCEndpoint::new("https://rpc.mainnet.near.org".parse().unwrap())
            .with_retries(RPC_ENDPOINT_RETRIES),
        RPCEndpoint::new("https://free.rpc.fastnear.com".parse().unwrap())
            .with_retries(RPC_ENDPOINT_RETRIES),
    ]
}

/// Build the default mainnet archival RPC endpoints with provider-level failover.
fn default_mainnet_archival_endpoints(fastnear_api_key: &str) -> Vec<RPCEndpoint> {
    vec![
        RPCEndpoint::new(
            "https://archival-rpc.mainnet.fastnear.com/"
                .parse()
                .unwrap(),
        )
        .with_api_key(fastnear_api_key.to_string())
        .with_retries(RPC_ENDPOINT_RETRIES),
        RPCEndpoint::new("https://archival-rpc.mainnet.near.org".parse().unwrap())
            .with_retries(RPC_ENDPOINT_RETRIES),
    ]
}

pub struct AppState {
    pub http_client: reqwest::Client,
    /// Priority admission gate over the shared NearBlocks budget. Every NearBlocks
    /// caller draws on one per-minute ceiling; latest (user-facing) requests
    /// preempt backfill (bulk) requests for the next permit. Replaces the raw
    /// limiter so the priority ordering can't be bypassed at the one acquire site.
    pub nearblocks_gate: PriorityRateGate<NearblocksPriority>,
    /// Shared budget for all DeFiLlama callers (free tier allows 500/min;
    /// we self-cap well under it). Clones share one limiter.
    pub defillama_limiter: RateLimiter,
    pub cache: Cache,
    pub signer: Arc<Signer>,
    pub bulk_payment_signer: Arc<Signer>,
    pub signer_id: AccountId,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: EnvVars,
    pub db_pool: PgPool,
    pub price_service: PriceLookupService<DeFiLlamaClient>,
    /// Centralized token registry + minute-level USD prices, fed by the
    /// token price ingest worker. Latest-price reads are in-memory.
    pub token_price_service: Arc<TokenPriceService>,
    pub bulk_payment_contract_id: AccountId,
    pub telegram_client: TelegramClient,
    /// Optional transfer hint service for accelerated balance change detection
    pub transfer_hint_service: Option<Arc<TransferHintService>>,
    /// Optional neardata.xyz client for accelerated block metadata resolution.
    /// Replaces multiple RPC calls with a single HTTP call per block.
    pub neardata_client: Option<NeardataClient>,
    /// Optional connection pool to Goldsky sink Postgres database.
    /// Used by the enrichment worker to read indexed_dao_outcomes.
    /// None if GOLDSKY_DATABASE_URL is not configured.
    pub goldsky_pool: Option<PgPool>,
    /// AES-256-GCM keyring for confidential JWT storage, from
    /// `CONFIDENTIAL_TOKEN_KEYRING_JSON`. None = legacy plaintext mode.
    /// Kept out of `EnvVars` so its `Debug` derive can never print key
    /// material. Access via [`AppState::confidential_credentials`].
    pub confidential_keyring: Option<Arc<TokenKeyring>>,
    pub event_tx: broadcast::Sender<AppEvent>,
    pub background_jobs_status: Arc<BackgroundJobsStatus>,
    /// Wakes the treasury creation sweeper immediately (instead of waiting for
    /// its next poll tick) when an attempt fails, so a half-created treasury is
    /// retried within moments rather than seconds.
    pub creation_sweep_notify: Arc<tokio::sync::Notify>,
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
    goldsky_pool: Option<PgPool>,
    confidential_keyring: Option<Arc<TokenKeyring>>,
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
            goldsky_pool: None,
            confidential_keyring: None,
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

    /// Set the Goldsky database pool (Goldsky sink, read-only)
    pub fn goldsky_pool(mut self, goldsky_pool: PgPool) -> Self {
        self.goldsky_pool = Some(goldsky_pool);
        self
    }

    /// Set the confidential-credential keyring (tests; production loads it
    /// from the environment in `build()`)
    pub fn confidential_keyring(mut self, keyring: TokenKeyring) -> Self {
        self.confidential_keyring = Some(Arc::new(keyring));
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
                // Otherwise use mainnet with FastNEAR (+ public fallbacks)
                NetworkConfig {
                    rpc_endpoints: default_mainnet_endpoints(&fastnear_api_key),
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
                    rpc_endpoints: default_mainnet_archival_endpoints(&fastnear_api_key),
                    ..NetworkConfig::mainnet()
                }
            }
        });

        // Create default price service (cache-only) if not provided
        let price_service = self
            .price_service
            .unwrap_or_else(|| PriceLookupService::without_provider(db_pool.clone()));

        let token_price_service = Arc::new(TokenPriceService::new(db_pool.clone()));

        // Use bulk payment contract from env or default
        let bulk_payment_contract_id = self
            .bulk_payment_contract_id
            .unwrap_or_else(|| env_vars.bulk_payment_contract_id.clone());

        // Create transfer hint service if enabled (and not explicitly provided)
        let transfer_hint_service = if let Some(service) = self.transfer_hint_service {
            Some(Arc::new(service))
        } else if env_vars.transfer_hints_enabled {
            let provider = if let Some(base_url) = &env_vars.transfer_hints_base_url {
                FastNearProvider::with_base_url(archival_network.clone(), base_url.clone())
            } else {
                FastNearProvider::new(archival_network.clone())
            }
            .with_api_key(&env_vars.fastnear_api_key);
            Some(Arc::new(TransferHintService::new().with_provider(provider)))
        } else {
            None
        };

        // Create neardata client (uses same FASTNEAR_API_KEY)
        let neardata_client = if !env_vars.fastnear_api_key.is_empty() {
            Some(NeardataClient::new().with_api_key(&env_vars.fastnear_api_key))
        } else {
            None
        };

        // Create Goldsky pool if URL is configured (Goldsky sink, read-only)
        let goldsky_pool = if let Some(existing) = self.goldsky_pool {
            Some(existing)
        } else if let Some(goldsky_url) = &env_vars.goldsky_database_url {
            match sqlx::postgres::PgPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(Duration::from_secs(5))
                .connect(goldsky_url)
                .await
            {
                Ok(pool) => {
                    tracing::info!("Connected to Goldsky sink database");
                    Some(pool)
                }
                Err(e) => {
                    tracing::error!(
                        tags.error_code = "GOLDSKY_SINK_CONNECT_FAILED",
                        tags.alert_priority = "p0",
                        error = %e,
                        "Failed to connect to Goldsky sink database — enrichment worker disabled"
                    );
                    None
                }
            }
        } else {
            None
        };

        // Build the shared NearBlocks limiter, wrap it in the priority gate, and
        // spawn the gate's driver here so no AppState can exist without a running
        // driver (a gate whose driver isn't running would fail open → unlimited
        // NearBlocks calls). build() is always awaited inside a tokio runtime.
        let nearblocks_max_per_minute = nearblocks_max_per_minute();
        let nearblocks_limiter = RateLimiter::per_minute(
            "nearblocks",
            nearblocks_max_per_minute,
            nearblocks_max_per_minute,
        );
        let (nearblocks_gate, nearblocks_gate_driver) =
            PriorityRateGate::<NearblocksPriority>::new(nearblocks_limiter);
        tokio::spawn(nearblocks_gate_driver.run());

        let defillama_limiter = RateLimiter::per_minute("defillama", DEFILLAMA_MAX_PER_MINUTE, 0);

        let (event_tx, _) = broadcast::channel(EVENT_BUS_CAPACITY);

        let confidential_keyring = match self.confidential_keyring {
            Some(keyring) => Some(keyring),
            // A set-but-invalid keyring fails boot with a clean error (never
            // silently fall back to plaintext); the message names the env
            // var and carries no key material.
            None => match TokenKeyring::from_env() {
                Ok(keyring) => keyring.map(Arc::new),
                Err(e) => {
                    tracing::error!("confidential keyring rejected: {}", e);
                    return Err(e.into());
                }
            },
        };

        Ok(AppState {
            http_client: self.http_client.unwrap_or_default(),
            nearblocks_gate,
            defillama_limiter,
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
            token_price_service,
            bulk_payment_contract_id,
            transfer_hint_service,
            neardata_client,
            goldsky_pool,
            confidential_keyring,
            event_tx,
            background_jobs_status: Arc::new(BackgroundJobsStatus::new()),
            creation_sweep_notify: Arc::new(tokio::sync::Notify::new()),
        })
    }
}

impl Default for AppStateBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    /// The single gateway to confidential 1Click JWT storage — handlers must
    /// not query the token columns directly.
    pub fn confidential_credentials(&self) -> ConfidentialCredentialStore {
        ConfidentialCredentialStore::new(self.db_pool.clone(), self.confidential_keyring.clone())
    }

    pub async fn publish_treasury_projection_updated(&self, account_id: String) {
        // Evict the account's cached assets response before broadcasting:
        // clients refetch on this event, and a refetch inside the cache TTL
        // would read the pre-projection payload and never retry.
        self.cache
            .short_term
            .invalidate(&format!("{account_id}-user-assets"))
            .await;
        let event = AppEvent::treasury_projection_updated(account_id);
        if let Err(e) = self.event_tx.send(event) {
            tracing::debug!(
                account_id = %e.0.account_id,
                "no active SSE subscribers for treasury projection update"
            );
        }
    }

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

        // Database connection.
        //
        // Connection-lifecycle settings are tuned so the app survives a rolling
        // restart without exhausting the database's `max_connections`. Before,
        // the pool opened up to 20 connections and (with no idle/lifetime
        // bounds) held them forever, so during a deploy the outgoing and
        // incoming instances overlapped at ~2× the cap and the new instance's
        // job workers could not acquire connections and stalled. Now:
        //  - `idle_timeout` releases idle connections, so a mostly-idle instance
        //    (most job workers just poll briefly) holds only a handful — the
        //    deploy overlap is small instead of a full 20+20.
        //  - `max_lifetime` recycles connections so ones broken by a server
        //    reset are dropped rather than lingering.
        //  - `test_before_acquire` hands out only live connections, replacing
        //    ones killed by a reset instead of failing a worker on a dead socket.
        //  - `min_connections(0)` keeps boot lazy (no eager herd of opens).
        // `DATABASE_MAX_CONNECTIONS` lets ops fit the pool to the DB's cap and
        // the number of concurrent instances (cap ≥ max × instances + headroom).
        let max_connections = std::env::var("DATABASE_MAX_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|v| *v >= 1)
            .unwrap_or(20);
        let acquire_timeout_secs = std::env::var("DATABASE_ACQUIRE_TIMEOUT_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v >= 1)
            .unwrap_or(10);
        tracing::info!(max_connections, "Connecting to database...");
        let db_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(max_connections)
            .min_connections(0)
            .acquire_timeout(Duration::from_secs(acquire_timeout_secs))
            .idle_timeout(Duration::from_secs(600))
            .max_lifetime(Duration::from_secs(1800))
            .test_before_acquire(true)
            .connect(&env_vars.database_url)
            .await?;

        tracing::info!("Running database migrations...");
        sqlx::migrate!("./migrations").run(&db_pool).await?;

        tracing::info!("Database connection established successfully");

        // Bounded so no handler or job can hang forever on an external HTTP
        // call (1Click, NearBlocks, DeFiLlama, …); a hung call now fails and
        // hits the normal retry/alert paths instead of holding a slot.
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("failed to build shared HTTP client");

        // Initialize price service with DeFiLlama provider (free, no API key required)
        let base_url = &env_vars.defillama_api_base_url;
        tracing::info!(
            "Initializing DeFiLlama price provider with base URL: {}",
            base_url
        );
        let defillama_client =
            DeFiLlamaClient::with_base_url(http_client.clone(), base_url.clone());
        let price_service = PriceLookupService::new(db_pool.clone(), defillama_client);

        let telegram_client = TelegramClient::new(
            env_vars.telegram_bot_token.clone(),
            env_vars.telegram_chat_id.clone(),
            env_vars.telegram_ops_chat_id.clone(),
        );
        tracing::info!(
            bot_configured = env_vars
                .telegram_bot_token
                .as_deref()
                .is_some_and(|t| !t.is_empty()),
            notifications_chat = env_vars.telegram_chat_id.is_some(),
            ops_chat = env_vars.telegram_ops_chat_id.is_some(),
            "telegram channel configuration"
        );

        // Use the builder pattern internally for consistency
        let state = AppStateBuilder::new()
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
            .await?;

        // Register the keyring against the persisted key-generation fence
        // first: a pod whose keyring the fence rejects (stale generation
        // after a rotation, or a conflicting keyring claiming this schema)
        // must not serve — every encrypted write would fail anyway, and a
        // stale-generation reconcile would try to rotate envelopes BACK to
        // the old key.
        if state.confidential_keyring.is_some() {
            let store = state.confidential_credentials();
            if let Err(e) = store.ensure_key_state().await {
                tracing::error!("confidential keyring rejected by key-state fence: {}", e);
                let _ = state
                    .telegram_client
                    .send_ops_alert_html(&format!(
                        "🚨 <b>Confidential keyring rejected at boot</b>: {}",
                        e
                    ))
                    .await;
                return Err(
                    format!("confidential keyring rejected by key-state fence: {e}").into(),
                );
            }

            // Encrypt any legacy plaintext confidential JWTs and re-encrypt
            // envelopes on non-active keys (idempotent). Failure never blocks
            // boot — the plaintext fallback keeps affected treasuries working
            // and the next deploy retries — but anything short of a clean run
            // alerts the ops channel, since a quiet log line is not an
            // operational signal. Old keys may be removed from the keyring
            // only while the PERSISTED rotation status is complete — never on
            // the strength of these log lines.
            match store.reconcile().await {
                Ok(report) => {
                    tracing::info!(
                        encrypted = report.encrypted,
                        already_encrypted = report.already_encrypted,
                        rotated = report.rotated,
                        failed = report.failed,
                        partial = report.partial.len(),
                        stale_after_sweep = report.stale_after_sweep,
                        rotation_complete = report.rotation_complete,
                        "confidential credential reconcile complete"
                    );
                    if !report.is_clean() {
                        let text = format!(
                            "⚠️ <b>Confidential credential reconcile finished with issues</b> (rotation stays pending)\nencrypted: {}\nrotated: {}\nfailed rows: {}\npartial pairs (need re-auth): {}\nrows without a verified active-key envelope: {}",
                            report.encrypted,
                            report.rotated,
                            report.failed,
                            report.partial.len(),
                            report.stale_after_sweep
                        );
                        let _ = state.telegram_client.send_ops_alert_html(&text).await;
                    }
                }
                Err(e) => {
                    tracing::error!("confidential credential reconcile failed: {}", e);
                    let _ = state
                        .telegram_client
                        .send_ops_alert_html(&format!(
                            "🚨 <b>Confidential credential reconcile failed at boot</b>: {}",
                            e
                        ))
                        .await;
                }
            }
        }

        Ok(state)
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
        // Max gap between the nearest indexed block and the requested
        // timestamp for the indexed block to be used directly. NEAR produces
        // ~1 block/sec, so 15s comfortably covers normal indexing granularity
        // while catching quiet gaps where on-chain state may have changed.
        const BLOCK_LOOKUP_TOLERANCE_NS: i64 = 15 * 1_000_000_000;

        // Convert DateTime to nanoseconds since Unix epoch (NEAR's timestamp format)
        let target_timestamp_ns = date.timestamp_nanos_opt().ok_or("Timestamp out of range")?;

        // Build cache key for this timestamp lookup
        let cache_key = CacheKey::new("block-height-by-timestamp")
            .with(target_timestamp_ns)
            .build();

        // Try to get from cache first (using LongTerm tier since block timestamps are immutable)
        self.cache
            .cached(CacheTier::LongTerm, cache_key.clone(), async {
                // Step 1: Find the nearest indexed block at-or-before the target
                // timestamp. `balance_changes` is global (every monitored
                // account) and continuously indexed, so for any timestamp within
                // an active indexed range this returns a block within moments of
                // the target — instant via `idx_balance_changes_timestamp`. An
                // exact timestamp match almost never existed, so the old query
                // fell through to the RPC binary search (~20 sequential archival
                // calls, ~6s), which made the proposal detail page — it resolves
                // the policy at a proposal's submission block — slow on first
                // load. The gap to the target is validated below before the
                // block is used.
                let db_result = sqlx::query!(
                    r#"
                        SELECT block_height, block_timestamp
                        FROM balance_changes
                        WHERE block_timestamp <= $1
                        ORDER BY block_timestamp DESC
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

                // Nearest indexed block found: accept it directly only when it
                // sits within `BLOCK_LOOKUP_TOLERANCE_NS` of the target. The
                // indexer only records blocks in which a monitored account's
                // balance changed, so during quiet periods the nearest earlier
                // block can be far behind the target — far enough that on-chain
                // state may have changed in between. In that case we fall back
                // to the RPC binary search, but seed it with this block as the
                // lower bound so it only scans the (small) range from here to
                // the target instead of from genesis.
                let mut search_lower_bound: Option<u64> = None;
                if let Some(record) = db_result {
                    let gap_ns = target_timestamp_ns - record.block_timestamp;
                    if gap_ns <= BLOCK_LOOKUP_TOLERANCE_NS {
                        tracing::info!(
                            "Found nearest block {} in database for timestamp {} ({}ns away)",
                            record.block_height,
                            date,
                            gap_ns
                        );
                        return Ok::<u64, (StatusCode, String)>(record.block_height as u64);
                    }

                    tracing::info!(
                        "Nearest indexed block {} is {}ns before timestamp {} (> tolerance); \
                         using it as binary-search lower bound",
                        record.block_height,
                        gap_ns,
                        date
                    );
                    search_lower_bound = Some(record.block_height as u64);
                } else {
                    tracing::info!(
                        "No indexed block at-or-before timestamp {}, using binary search via RPC",
                        date
                    );
                }

                // Step 2: Use binary search to find the block via RPC
                let block_height = self
                    .binary_search_block_by_timestamp(target_timestamp_ns, search_lower_bound)
                    .await
                    .map_err(|e| {
                        (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            format!("Binary search error: {}", e),
                        )
                    })?;

                tracing::info!(
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
        lower_bound: Option<u64>,
    ) -> Result<u64, Box<dyn std::error::Error>> {
        use crate::handlers::balance_changes::utils::with_transport_retry;
        use near_api::{Chain, Reference};

        // Get the latest block to establish the search range
        let latest_block = with_transport_retry("binary_search_latest", || {
            Chain::block().fetch_from(&self.archival_network)
        })
        .await?;

        // Start from the caller-supplied lower bound (a known indexed block
        // at-or-before the target) when available, otherwise the Sputnik DAO
        // genesis block. A tighter lower bound shrinks the search range and
        // saves archival RPC round-trips.
        let genesis_block = 129265430u64;
        let mut left = lower_bound.map_or(genesis_block, |b| b.max(genesis_block));
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

        tracing::info!(
            "Binary searching for block with timestamp {} in range [{}, {}]",
            timestamp_ns,
            left,
            right
        );

        // Binary search for the block with the closest timestamp
        while left <= right {
            let mid = left + (right - left) / 2;

            let mid_block = with_transport_retry("binary_search_block", || {
                Chain::block()
                    .at(Reference::AtBlock(mid))
                    .fetch_from(&self.archival_network)
            })
            .await?;

            let mid_timestamp: i64 = mid_block.header.timestamp as i64;

            tracing::debug!(
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
                tracing::info!(
                    "Found exact match at block {} for timestamp {}",
                    mid,
                    timestamp_ns
                );
                return Ok(mid);
            }
        }

        // Return the first block with timestamp >= target
        tracing::info!(
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
        // Retry on transient RPC errors (binary search makes multiple RPC calls)
        let mut result1 = None;
        for attempt in 0..3 {
            match app_state.find_block_height(target_date).await {
                Ok(block) => {
                    result1 = Some(block);
                    break;
                }
                Err(e) if attempt < 2 => {
                    println!("Attempt {} failed (retrying): {}", attempt + 1, e);
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(e) => panic!(
                    "Should find block via binary search after 3 attempts: {}",
                    e
                ),
            }
        }
        let result1 = result1.unwrap();
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

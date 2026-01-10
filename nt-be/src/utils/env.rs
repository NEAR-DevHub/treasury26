use near_api::{AccountId, SecretKey};

#[derive(Clone, Debug)]
pub struct EnvVars {
    pub database_url: String,
    pub pikespeak_key: String,
    pub fastnear_api_key: String,
    pub sputnik_dao_api_base: String,
    pub bridge_rpc_url: String,
    pub ref_sdk_base_url: String,
    pub signer_key: SecretKey,
    pub signer_id: AccountId,
    pub disable_balance_monitoring: bool,
    pub monitor_interval_minutes: u64,
    pub coingecko_api_key: Option<String>,
    pub coingecko_api_base_url: String, // Override for testing
}

impl Default for EnvVars {
    fn default() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL is not set"),
            pikespeak_key: std::env::var("PIKESPEAK_KEY").expect("PIKESPEAK_KEY is not set"),
            fastnear_api_key: std::env::var("FASTNEAR_API_KEY")
                .expect("FASTNEAR_API_KEY is not set"),
            sputnik_dao_api_base: std::env::var("SPUTNIK_DAO_API_BASE")
                .unwrap_or_else(|_| "https://sputnik-indexer.fly.dev".to_string()),
            bridge_rpc_url: std::env::var("BRIDGE_RPC_URL")
                .unwrap_or_else(|_| "https://bridge.chaindefuser.com/rpc".to_string()),
            ref_sdk_base_url: std::env::var("REF_SDK_BASE_URL").unwrap_or_else(|_| {
                "https://ref-sdk-test-cold-haze-1300-2.fly.dev/api".to_string()
            }),
            signer_key: std::env::var("SIGNER_KEY")
                .expect("SIGNER_KEY is not set")
                .parse()
                .unwrap(),
            signer_id: std::env::var("SIGNER_ID")
                .expect("SIGNER_ID is not set")
                .parse()
                .unwrap(),
            disable_balance_monitoring: std::env::var("DISABLE_BALANCE_MONITORING")
                .unwrap_or_else(|_| "false".to_string())
                .parse()
                .unwrap_or(false),
            monitor_interval_minutes: std::env::var("MONITOR_INTERVAL_MINUTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5),
            coingecko_api_key: std::env::var("COINGECKO_API_KEY")
                .ok()
                .filter(|s| !s.is_empty()),
            coingecko_api_base_url: std::env::var("COINGECKO_API_BASE_URL")
                .unwrap_or_else(|_| "https://pro-api.coingecko.com/api/v3".to_string()),
        }
    }
}

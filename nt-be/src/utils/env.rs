use near_api::{AccountId, SecretKey};

#[derive(Clone, Debug)]
pub struct EnvVars {
    pub database_url: String,
    pub near_rpc_url: Option<String>,
    pub near_archival_rpc_url: Option<String>,
    pub bulk_payment_contract_id: AccountId,
    pub pikespeak_key: String,
    pub fastnear_api_key: String,
    pub sputnik_dao_api_base: String,
    pub bridge_rpc_url: String,
    pub ref_sdk_base_url: String,
    pub signer_key: SecretKey,
    pub signer_id: AccountId,
    pub disable_balance_monitoring: bool,
    pub disable_treasury_creation: bool,
    pub monitor_interval_minutes: u64,
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub coingecko_api_key: Option<String>,
    pub coingecko_api_base_url: String, // Override for testing
    pub nearblocks_api_key: Option<String>,
    // 1click API configuration for asset exchange quotes
    pub oneclick_api_url: String,
    pub oneclick_jwt_token: Option<String>,
    pub oneclick_app_fee_bps: Option<u32>,
    pub oneclick_app_fee_recipient: Option<String>,
    pub oneclick_referral: Option<String>,
}

impl Default for EnvVars {
    fn default() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL is not set"),
            near_rpc_url: std::env::var("NEAR_RPC_URL").ok().filter(|s| !s.is_empty()),
            near_archival_rpc_url: std::env::var("NEAR_ARCHIVAL_RPC_URL")
                .ok()
                .filter(|s| !s.is_empty()),
            bulk_payment_contract_id: std::env::var("BULK_PAYMENT_CONTRACT_ID")
                .unwrap_or_else(|_| "bulkpayment.near".to_string())
                .parse()
                .expect("Invalid BULK_PAYMENT_CONTRACT_ID"),
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
            disable_treasury_creation: std::env::var("DISABLE_TREASURY_CREATION")
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
            telegram_bot_token: std::env::var("TELEGRAM_BOT_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            telegram_chat_id: std::env::var("TELEGRAM_CHAT_ID")
                .ok()
                .filter(|s| !s.is_empty()),
            nearblocks_api_key: std::env::var("NEARBLOCKS_API_KEY")
                .ok()
                .filter(|s| !s.is_empty()),
            // 1click API configuration
            oneclick_api_url: std::env::var("ONECLICK_API_URL")
                .unwrap_or_else(|_| "https://1click.chaindefuser.com".to_string()),
            oneclick_jwt_token: std::env::var("ONECLICK_JWT_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            oneclick_app_fee_bps: std::env::var("ONECLICK_APP_FEE_BPS")
                .ok()
                .and_then(|s| s.parse().ok())
                .or(Some(1)), // Default: 1 basis point (0.01%)
            oneclick_app_fee_recipient: std::env::var("ONECLICK_APP_FEE_RECIPIENT")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| Some("testing-astradao.sputnik-dao.near".to_string())),
            oneclick_referral: std::env::var("ONECLICK_REFERRAL")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| Some("near-treasury".to_string())),
        }
    }
}

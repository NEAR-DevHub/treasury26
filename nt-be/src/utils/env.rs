#[derive(Clone, Debug)]
pub struct EnvVars {
    pub pikespeak_key: String,
    pub fastnear_api_key: String,
    pub sputnik_dao_api_base: String,
    pub bridge_rpc_url: String,
}

impl Default for EnvVars {
    fn default() -> Self {
        Self {
            pikespeak_key: std::env::var("PIKESPEAK_KEY").expect("PIKESPEAK_KEY is not set"),
            fastnear_api_key: std::env::var("FASTNEAR_API_KEY")
                .expect("FASTNEAR_API_KEY is not set"),
            sputnik_dao_api_base: std::env::var("SPUTNIK_DAO_API_BASE")
                .unwrap_or_else(|_| "https://sputnik-indexer.fly.dev".to_string()),
            bridge_rpc_url: std::env::var("BRIDGE_RPC_URL")
                .unwrap_or_else(|_| "https://bridge.chaindefuser.com/rpc".to_string()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct OhDearHealthConfig {
    pub database_timeout_seconds: u64,
    pub http_timeout_seconds: u64,
    pub near_rpc_stale_after_seconds: i64,
    pub near_protocol_mainnet_label: String,
    pub exchange_route_label: String,
    pub exchange_swap_type: String,
    pub exchange_origin_asset: String,
    pub exchange_deposit_type: String,
    pub exchange_destination_asset: String,
    pub exchange_amount: String,
    pub exchange_account_id: String,
    pub exchange_refund_type: String,
    pub exchange_recipient_type: String,
    pub exchange_deadline_hours: i64,
    pub exchange_slippage_tolerance: u16,
    pub exchange_quote_waiting_time_ms: u64,
    pub fastnear_probe_account_id: String,
    pub neardata_probe_block_height: u64,
}

impl Default for OhDearHealthConfig {
    fn default() -> Self {
        Self {
            database_timeout_seconds: 5,
            http_timeout_seconds: 10,
            near_rpc_stale_after_seconds: 300,
            near_protocol_mainnet_label: "NEAR Network (mainnet)".to_string(),
            exchange_route_label: "NEAR -> USDT".to_string(),
            exchange_swap_type: "EXACT_INPUT".to_string(),
            exchange_origin_asset: "nep141:wrap.near".to_string(),
            exchange_deposit_type: "ORIGIN_CHAIN".to_string(),
            exchange_destination_asset: "nep141:usdt.tether-token.near".to_string(),
            exchange_amount: "1000000000000000000000000".to_string(),
            exchange_account_id: "trezu.sputnik-dao.near".to_string(),
            exchange_refund_type: "ORIGIN_CHAIN".to_string(),
            exchange_recipient_type: "DESTINATION_CHAIN".to_string(),
            exchange_deadline_hours: 24,
            exchange_slippage_tolerance: 100,
            exchange_quote_waiting_time_ms: 3000,
            fastnear_probe_account_id: "trezu.sputnik-dao.near".to_string(),
            neardata_probe_block_height: 100_000_000,
        }
    }
}

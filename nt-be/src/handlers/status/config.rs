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

/// Consecutive unhealthy checks before sending a Telegram ops alert (~3 min at 60s).
pub const ALERT_AFTER_FAILURES: i32 = 3;
/// Status-page posts (maintenance / incidents) — page after ~5 min.
pub const ALERT_AFTER_FAILURES_INTENTS: i32 = 5;
/// Explorer transaction search flaps — page only after ~15 min down.
pub const ALERT_AFTER_FAILURES_FLAKY: i32 = 15;
/// Consecutive healthy checks before closing an incident (~2 min at 60s).
pub const RECOVER_AFTER_SUCCESSES: i32 = 2;
/// Explorer must stay healthy this long before a recovery Telegram (~15 min).
pub const RECOVER_AFTER_SUCCESSES_FLAKY: i32 = 15;

/// Per-service alert threshold. Intents-related checks are noisier, so they
/// need a longer consecutive-failure streak before paging Telegram.
pub fn alert_after_failures(service: &str) -> i32 {
    match service {
        "intents-explorer" => ALERT_AFTER_FAILURES_FLAKY,
        "exchange" | "near-intents" => ALERT_AFTER_FAILURES_INTENTS,
        _ => ALERT_AFTER_FAILURES,
    }
}

/// Per-service recovery threshold. Explorer stays open through brief green
/// blips so we do not emit fail/recover pairs every few minutes.
pub fn recover_after_successes(service: &str) -> i32 {
    match service {
        "intents-explorer" => RECOVER_AFTER_SUCCESSES_FLAKY,
        _ => RECOVER_AFTER_SUCCESSES,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intents_services_use_longer_alert_threshold() {
        assert_eq!(alert_after_failures("intents-explorer"), 15);
        assert_eq!(alert_after_failures("exchange"), 5);
        assert_eq!(alert_after_failures("near-intents"), 5);
        assert_eq!(alert_after_failures("backend"), 3);
        assert_eq!(alert_after_failures("near-rpc"), 3);
    }

    #[test]
    fn flaky_probes_need_a_longer_healthy_streak_to_recover() {
        assert_eq!(recover_after_successes("intents-explorer"), 15);
        assert_eq!(recover_after_successes("exchange"), 2);
        assert_eq!(recover_after_successes("near-intents"), 2);
        assert_eq!(recover_after_successes("backend"), 2);
    }
}

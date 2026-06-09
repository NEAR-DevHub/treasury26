//! Services module for external integrations and business logic

pub mod coingecko;
pub mod dao_sync;
pub mod defillama;
pub mod ft_lockup_scheduler;
pub mod monitored_accounts;
pub mod platform_metrics;
pub mod price_lookup;
pub mod price_provider;
pub mod price_sync;
pub mod public_dashboard;
pub mod sponsor_alerts;
pub mod testing_accounts;
pub mod usd_value_backfill;

pub use coingecko::CoinGeckoClient;
pub use dao_sync::{
    mark_dao_dirty, register_new_dao, register_new_dao_and_wait, run_dao_list_sync_service,
    run_dao_policy_sync_service,
};
pub use defillama::DeFiLlamaClient;
pub use ft_lockup_scheduler::{
    refresh_ft_lockup_dao_schedules, run_due_ft_lockup_claims,
    run_ft_lockup_schedule_refresh_service,
};
pub use monitored_accounts::{
    MonitoredAccount, RegisterMonitoredAccountError, RegisterMonitoredAccountResult,
    register_or_refresh_monitored_account,
};
pub use price_lookup::PriceLookupService;
pub use price_provider::PriceProvider;
pub use price_sync::{run_price_sync_service, sync_all_prices_now};
pub use public_dashboard::{
    PublicDashboardSnapshot, load_latest_public_dashboard_snapshot,
    run_public_dashboard_refresh_service,
};
pub use sponsor_alerts::run_sponsor_balance_monitor_loop;
pub use testing_accounts::{mark_testing_if_needed, should_mark_testing};
pub use usd_value_backfill::{backfill_batch, run_usd_value_backfill_service};

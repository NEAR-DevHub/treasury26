use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::{AppState, auth, handlers};

mod balance_changes;
pub use balance_changes::{
    BalanceChangesQuery, EnrichedBalanceChange, get_balance_changes_internal,
};

mod monitored_accounts;

async fn health_check(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Test database connection
    let db_connected = sqlx::query("SELECT 1")
        .fetch_one(&state.db_pool)
        .await
        .is_ok();

    let pool_size = state.db_pool.size();
    let idle_connections = state.db_pool.num_idle();

    if !db_connected {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "unhealthy",
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "database": {
                    "connected": false,
                    "error": "Database connection failed"
                }
            })),
        ));
    }

    // Query Goldsky enrichment cursor if configured
    let goldsky_cursor_block = if state.goldsky_pool.is_some() {
        sqlx::query_scalar::<_, i64>(
            "SELECT last_processed_block FROM goldsky_cursors WHERE consumer_name = 'balance_enrichment'"
        )
        .fetch_optional(&state.db_pool)
        .await
        .ok()
        .flatten()
    } else {
        None
    };

    Ok(Json(json!({
        "status": "healthy",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "database": {
            "connected": true,
            "pool_size": pool_size,
            "idle_connections": idle_connections
        },
        "goldsky_enrichment": {
            "enabled": state.goldsky_pool.is_some(),
            "cursor_block": goldsky_cursor_block
        }
    })))
}

pub fn create_routes(state: Arc<AppState>) -> Router {
    Router::new()
        // Health check
        .route("/api/health", get(health_check))
        .route(
            "/api/public/dashboard/aum",
            get(handlers::public_dashboard::get_public_dashboard_aum),
        )
        // Balance changes endpoint
        .route(
            "/api/balance-changes",
            get(balance_changes::get_balance_changes),
        )
        .route(
            "/api/recent-activity",
            get(handlers::balance_changes::history::get_recent_activity),
        )
        .route(
            "/api/recent-activity/senders",
            get(handlers::balance_changes::history::get_recent_activity_senders),
        )
        .route(
            "/api/recent-activity/recipients",
            get(handlers::balance_changes::history::get_recent_activity_recipients),
        )
        .route(
            "/api/balance-changes/fill-gaps",
            post(balance_changes::fill_gaps),
        )
        // Balance history endpoints
        .route(
            "/api/balance-history/completeness",
            get(balance_changes::get_completeness),
        )
        .route(
            "/api/balance-history/chart",
            get(handlers::balance_changes::history::get_balance_chart),
        )
        .route(
            "/api/balance-history/export",
            get(handlers::balance_changes::history::export_balance),
        )
        // Token endpoints
        .route(
            "/api/token/metadata",
            get(handlers::token::metadata::get_token_metadata),
        )
        .route(
            "/api/token/storage-deposit/is-registered",
            get(handlers::token::storage_deposit::is_registered::is_storage_deposit_registered),
        )
        .route(
            "/api/token/storage-deposit/is-registered/batch",
            post(handlers::token::storage_deposit::is_registered::get_batch_storage_deposit_is_registered),
        )
        .route(
            "/api/treasury/policy",
            get(handlers::treasury::policy::get_treasury_policy)
        )
        .route(
            "/api/treasury/config",
            get(handlers::treasury::config::get_treasury_config)
        )
        .route(
            "/api/treasury/check-handle-unused",
            get(handlers::treasury::check_handle_unused::check_handle_unused)
        )
        .route(
            "/api/treasury/create-stream",
            post(handlers::treasury::create::create_treasury_stream)
        )
        .route(
            "/api/treasury/creation-status",
            get(handlers::treasury::creation_status::get_treasury_creation_status)
        )
        .route(
            "/api/treasury/whitelist-request",
            post(handlers::treasury::whitelist_request::submit_whitelist_request)
        )
        // User endpoints
        .route(
            "/api/user/treasuries",
            get(handlers::user::treasuries::get_user_treasuries),
        )
        .route(
            "/api/user/treasuries/save",
            post(handlers::user::treasuries::save_user_treasury),
        )
        .route(
            "/api/user/treasuries/hide",
            post(handlers::user::treasuries::hide_user_treasury),
        )
        .route(
            "/api/user/treasuries/remove",
            post(handlers::user::treasuries::remove_user_treasury),
        )
        .route(
            "/api/user/assets",
            get(handlers::user::assets::get_user_assets),
        )
        .route(
            "/api/user/profile",
            get(handlers::user::profile::get_profile),
        )
        .route(
            "/api/user/check-account-exists",
            get(handlers::user::check_account_exists::check_account_exists),
        )
        .route(
            "/api/user/lockup",
            get(handlers::user::lockup::get_user_lockup),
        )
        .route(
            "/api/user/staking-validator",
            get(handlers::user::staking::get_staking_validator_details),
        )
        // Proposals endpoints
        .route(
            "/api/proposals/{dao_id}",
            get(handlers::proposals::get_proposals::get_proposals),
        )
        .route(
            "/api/proposal/{dao_id}/{proposal_id}",
            get(handlers::proposals::get_proposals::get_proposal),
        )
        .route(
            "/api/proposals/{dao_id}/proposers",
            get(handlers::proposals::get_proposals::get_dao_proposers),
        )
        .route(
            "/api/proposals/{dao_id}/approvers",
            get(handlers::proposals::get_proposals::get_dao_approvers),
        )
        .route(
            "/api/proposal/{dao_id}/{proposal_id}/tx",
            get(handlers::proposals::tx::find_proposal_execution_transaction),
        )
        .route(
            "/api/proposal/{dao_id}/{proposal_id}/staking-amount",
            get(handlers::proposals::staking_amount::get_proposal_staking_amount),
        )
        .route(
            "/api/receipt/search",
            get(handlers::proposals::tx::search_receipt),
        )
        .route(
            "/api/prices/token-at-timestamp",
            get(handlers::proposals::tx::get_token_price_at_timestamp),
        )
        // Lookup endpoints
        .route(
            "/api/lockup/pool",
            get(handlers::lookup::pool::get_lockup_pool),
        )
        // Bulk payment endpoints
        .route(
            "/api/bulk-payment/get",
            get(handlers::bulkpayment::get::get_batch_payment),
        )
        .route(
            "/api/bulk-payment/submit-list",
            post(handlers::bulkpayment::submit::submit_list),
        )
        .route(
            "/api/bulk-payment/storage-credits",
            get(handlers::bulkpayment::storage_credits::get_storage_credits),
        )
        .route(
            "/api/export-history",
            get(handlers::balance_changes::history::get_export_history),
        )
        .route(
            "/api/bulk-payment/list/{list_id}",
            get(handlers::bulkpayment::transactions::get_list_status),
        )
        .route(
            "/api/bulk-payment/list/{list_id}/transactions",
            get(handlers::bulkpayment::transactions::get_transactions),
        )
        .route(
            "/api/bulk-payment/list/{list_id}/transaction/{recipient}",
            get(handlers::bulkpayment::transactions::get_transaction_hash),
        )
        // Relay endpoints
        .route(
            "/api/relay/delegate-action",
            post(handlers::relay::submit::relay_delegate_action),
        )
        // Monitored accounts endpoints
        .route(
            "/api/monitored-accounts",
            post(monitored_accounts::add_monitored_account)
        )
        // Intents endpoints
        .route(
            "/api/intents/search-tokens",
            get(handlers::intents::search_tokens::search_tokens),
        )
        .route(
            "/api/intents/deposit-address",
            post(handlers::intents::deposit_address::get_deposit_address),
        )
        .route(
            "/api/intents/bridge-tokens",
            get(handlers::intents::bridge_tokens::get_bridge_tokens),
        )
        .route(
            "/api/intents/quote",
            post(handlers::intents::quote::get_quote),
        )
        .route(
            "/api/intents/swap-status",
            get(handlers::intents::swap_status::get_swap_status),
        )
        .route(
            "/api/intents/quote-by-deposit-address",
            get(handlers::intents::swap_status::get_quote_by_deposit_address),
        )
        .route(
            "/api/intents/status",
            get(handlers::intents::system_status::get_system_status),
        )
        .route(
            "/api/confidential-intents/generate-intent",
            post(handlers::intents::confidential::generate_intent::generate_intent),
        )
        // Proxy endpoints - catch-all for external API
        .route(
            "/api/proxy/{*path}",
            get(handlers::proxy::external::proxy_external_api),
        )
        // Auth endpoints
        .route(
            "/api/auth/challenge",
            post(auth::handlers::create_challenge),
        )
        .route("/api/auth/login", post(auth::handlers::login))
        .route(
            "/api/auth/accept-terms",
            post(auth::handlers::accept_terms),
        )
        .route("/api/auth/me", get(auth::handlers::get_me))
        .route("/api/auth/logout", post(auth::handlers::logout))
        // Chains endpoint
        .route(
            "/api/chains",
            get(handlers::chains::get_chains),
        )
        // Address book endpoints
        .route(
            "/api/address-book",
            get(handlers::address_book::list_address_book)
                .post(handlers::address_book::create_address_book_entries)
                .delete(handlers::address_book::delete_address_book_entries),
        )
        .route(
            "/api/address-book/export",
            get(handlers::address_book::export_address_book),
        )
        // DAO endpoints
        .route(
            "/api/dao/mark-dirty",
            post(handlers::dao::mark_dirty),
        )
        .route(
            "/api/dao/receipt-metric",
            post(handlers::dao::record_receipt_metric),
        )
        // Subscription endpoints
        .route(
            "/api/subscription/plans",
            get(handlers::subscription::get_plans),
        )
        .route(
            "/api/subscription/{account_id}",
            get(handlers::subscription::get_subscription_status),
        )
        // Telegram bot endpoints
        .route(
            "/api/telegram/webhook",
            post(handlers::telegram::webhook::handle_telegram_webhook),
        )
        .route(
            "/api/telegram/connect",
            get(handlers::telegram::connect::get_chat_info)
                .post(handlers::telegram::connect::connect_treasuries)
                .delete(handlers::telegram::connect::disconnect_treasury),
        )
        .route(
            "/api/telegram/status",
            get(handlers::telegram::connect::get_status),
        )
        .with_state(state)
}

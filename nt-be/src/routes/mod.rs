use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, patch, post},
};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::{AppState, auth, handlers};

mod balance_changes;
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

    Ok(Json(json!({
        "status": "healthy",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "database": {
            "connected": true,
            "pool_size": pool_size,
            "idle_connections": idle_connections
        }
    })))
}

pub fn create_routes(state: Arc<AppState>) -> Router {
    Router::new()
        // Health check
        .route("/api/health", get(health_check))
        // Balance changes endpoint
        .route(
            "/api/balance-changes",
            get(balance_changes::get_balance_changes),
        )
        .route(
            "/api/recent-activity",
            get(balance_changes::get_recent_activity),
        )
        .route(
            "/api/balance-changes/fill-gaps",
            post(balance_changes::fill_gaps),
        )
        // Balance history endpoints
        .route(
            "/api/balance-history/chart",
            get(handlers::balance_changes::history::get_balance_chart),
        )
        .route(
            "/api/balance-history/csv",
            get(handlers::balance_changes::history::export_balance_csv),
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
            "/api/treasury/create",
            post(handlers::treasury::create::create_treasury)
        )
        // User endpoints
        .route(
            "/api/user/balance",
            get(handlers::user::balance::get_token_balance),
        )
        .route(
            "/api/user/treasuries",
            get(handlers::user::treasuries::get_user_treasuries),
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
            "/api/user/profile/batch",
            get(handlers::user::profile::get_batch_profiles),
        )
        .route(
            "/api/user/check-account-exists",
            get(handlers::user::check_account_exists::check_account_exists),
        )
        .route(
            "/api/user/lockup",
            get(handlers::user::lockup::get_user_lockup),
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
            "/api/bulk-payment/usage-stats",
            get(handlers::bulkpayment::usage_stats::get_usage_stats),
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
        // Monitored accounts endpoints
        .route(
            "/api/monitored-accounts",
            post(monitored_accounts::add_monitored_account)
                .get(monitored_accounts::list_monitored_accounts),
        )
        .route(
            "/api/monitored-accounts/{account_id}",
            patch(monitored_accounts::update_monitored_account)
                .delete(monitored_accounts::delete_monitored_account),
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
        // DAO endpoints
        .route(
            "/api/dao/mark-dirty",
            post(handlers::dao::mark_dirty),
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
        .with_state(state)
}

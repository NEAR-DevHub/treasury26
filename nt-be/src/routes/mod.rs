use axum::{
    extract::State,
    http::StatusCode,
    Json, Router,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::{AppState, handlers};

async fn health_check(State(state): State<Arc<AppState>>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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
            }))
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
        // Token endpoints
        .route(
            "/api/token/price",
            get(handlers::token::price::get_token_price),
        )
        .route(
            "/api/token/metadata",
            get(handlers::token::metadata::get_token_metadata),
        )
        .route(
            "/api/token/price/batch",
            get(handlers::token::price::get_batch_token_prices),
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
        // User endpoints
        .route(
            "/api/user/balance",
            get(handlers::user::balance::get_token_balance),
        )
        .route(
            "/api/user/balance/batch",
            get(handlers::user::balance::get_batch_token_balances),
        )
        .route(
            "/api/user/balance/history",
            get(handlers::user::balance_history::get_token_balance_history),
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
        // Proposals endpoints
        .route(
            "/api/proposals/{dao_id}",
            get(handlers::proposals::get_proposals::get_proposals),
        )
        .route(
            "/api/proposal/{dao_id}/{proposal_id}",
            get(handlers::proposals::get_proposals::get_proposal),
        )
        // Lookup endpoints
        .route(
            "/api/lockup/pool",
            get(handlers::lookup::pool::get_lockup_pool),
        )
        // Bulk payment endpoints
        .route(
            "/api/bulkpayment/get",
            get(handlers::bulkpayment::get::get_batch_payment),
        )
        // Intents endpoints
        .route(
            "/api/intents/supported-tokens",
            get(handlers::intents::supported_tokens::get_supported_tokens),
        )
        // Proxy endpoints - catch-all for external API
        .route(
            "/api/proxy/{*path}",
            get(handlers::proxy::external::proxy_external_api),
        )
        .with_state(state)
}

use axum::{Router, routing::get};
use std::sync::Arc;

use crate::{AppState, handlers};

pub fn create_routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route(
            "/api/user-treasuries",
            get(handlers::user_treasuries::get_user_treasuries),
        )
        .route(
            "/api/whitelist-tokens",
            get(handlers::whitelist_tokens::get_whitelist_tokens),
        )
        .route(
            "/api/token-balance-history",
            get(handlers::token_balance_history::get_token_balance_history),
        )
        .route(
            "/api/token-price",
            get(handlers::token_price::get_token_price),
        )
        .route(
            "/api/token-prices/batch",
            get(handlers::token_price::get_batch_token_prices),
        )
        .route(
            "/api/token-balance",
            get(handlers::token_balance::get_token_balance),
        )
        .route(
            "/api/token-balances/batch",
            get(handlers::token_balance::get_batch_token_balances),
        )
        .with_state(state)
}

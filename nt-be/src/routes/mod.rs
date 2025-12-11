use axum::{Router, routing::get};
use std::sync::Arc;

use crate::{AppState, handlers};

pub fn create_routes(state: Arc<AppState>) -> Router {
    Router::new()
        // Token endpoints
        .route(
            "/api/token/price",
            get(handlers::token::price::get_token_price),
        )
        .route(
            "/api/token/price/batch",
            get(handlers::token::price::get_batch_token_prices),
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
        .with_state(state)
}

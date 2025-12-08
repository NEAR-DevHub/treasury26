use axum::{Router, routing::get};
use std::sync::Arc;

use crate::{AppState, handlers};

pub fn create_routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route(
            "/api/user-treasuries",
            get(handlers::user_treasuries::get_user_treasuries),
        )
        .with_state(state)
}

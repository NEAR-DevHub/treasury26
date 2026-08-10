//! Read endpoints for the Trezu Wallet connector script.
//!
//! The connector runs on the calling dapp's origin (inside near-connect's
//! sandbox), which the main API's CORS allow-list would block, so these GET
//! endpoints are mounted separately behind an any-origin, credential-less
//! CORS layer — see `main.rs` and `routes::create_wallet_adapter_routes`.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use near_primitives::hash::CryptoHash;
use serde_json::Value;

use crate::AppState;
use crate::handlers::balance_changes::block_info::get_transaction;

/// Final execution outcome of a transaction, in the same shape as the NEAR
/// `tx` RPC method's result, so the connector can hand it to wallet-selector
/// consumers unchanged.
pub async fn get_tx_status(
    State(state): State<Arc<AppState>>,
    Path((tx_hash, sender_id)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    tx_hash.parse::<CryptoHash>().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid transaction hash: {}", e),
        )
    })?;
    sender_id
        .parse::<near_primitives::types::AccountId>()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid sender id: {}", e)))?;

    let response = get_transaction(&state.archival_network, &tx_hash, &sender_id)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to fetch transaction: {}", e),
            )
        })?;
    let value = serde_json::to_value(&response).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize transaction: {}", e),
        )
    })?;
    Ok(Json(value))
}

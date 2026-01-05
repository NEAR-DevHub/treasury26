use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::{AccountId, Contract};
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct GetTreasuryPolicyQuery {
    #[serde(rename = "treasuryId")]
    pub treasury_id: AccountId,
}

pub async fn get_treasury_policy(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryPolicyQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let treasury_id = params.treasury_id;

    let cache_key = format!("treasury-policy:{}", treasury_id);
    if let Some(cached_policy) = state.short_term_cache.get(&cache_key).await {
        println!("🔁 Returning cached policy for {}", treasury_id);
        return Ok((StatusCode::OK, Json(cached_policy)));
    }

    let policy: serde_json::Value = Contract(treasury_id)
        .call_function("get_policy", ())
        .read_only()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching treasury policy: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?
        .data;

    state
        .short_term_cache
        .insert(cache_key, policy.clone())
        .await;

    Ok((StatusCode::OK, Json(policy)))
}

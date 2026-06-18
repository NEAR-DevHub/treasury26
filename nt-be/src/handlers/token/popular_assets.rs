use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;

use crate::{
    AppState,
    handlers::token::{
        fetch_tokens_metadata_enriched, metadata::TokenMetadata, search_token_by_symbol,
    },
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopularAssetsResponse {
    pub data: Vec<TokenMetadata>,
}

const STATIC_POPULAR_ASSET_SYMBOLS: &[&str] = &["ETH", "ZEC", "NEAR", "SOL", "BTC"];

pub async fn get_popular_assets_by_activity(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PopularAssetsResponse>, (StatusCode, String)> {
    let mut token_ids: Vec<String> = Vec::new();
    for symbol in STATIC_POPULAR_ASSET_SYMBOLS {
        match search_token_by_symbol(&state, symbol).await {
            Ok(candidates) if !candidates.is_empty() => {
                token_ids.push(candidates[0].clone());
            }
            Ok(_) => {}
            Err((status, err)) => {
                log::warn!(
                    "popular_assets symbol lookup failed: symbol={}, status={}, error={}",
                    symbol,
                    status.as_u16(),
                    err
                );
            }
        }
    }

    let metadata_map = fetch_tokens_metadata_enriched(&state, &token_ids, false).await;
    let data: Vec<TokenMetadata> = token_ids
        .iter()
        .filter_map(|token_id| metadata_map.get(token_id).cloned())
        .collect();

    Ok(Json(PopularAssetsResponse { data }))
}

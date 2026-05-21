use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;
use std::sync::Arc;

use crate::{AppState, constants::intents_chains::CHAIN_METADATA};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainInfo {
    pub key: String,
    pub name: String,
    pub icon: String,
}

pub async fn get_chains(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<Vec<ChainInfo>>, (StatusCode, String)> {
    let mut chains: Vec<ChainInfo> = CHAIN_METADATA
        .iter()
        .filter(|(_, meta)| meta.canonical_key.is_none())
        .map(|(key, meta)| ChainInfo {
            key: key.clone(),
            name: meta.name.clone(),
            icon: meta.icon.icon.clone(),
        })
        .collect();

    chains.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(Json(chains))
}

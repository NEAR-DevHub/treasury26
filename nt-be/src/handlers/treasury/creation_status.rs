use std::sync::Arc;

use axum::{Json, extract::State};
use near_api::{NearToken, Tokens};
use reqwest::StatusCode;
use serde::Serialize;

pub const LOW_BALANCE_THRESHOLD: NearToken = NearToken::from_near(5);

use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryCreationStatusResponse {
    pub creation_available: bool,
}

pub async fn get_treasury_creation_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<TreasuryCreationStatusResponse>, (StatusCode, String)> {
    if state.env_vars.disable_treasury_creation {
        return Ok(Json(TreasuryCreationStatusResponse {
            creation_available: false,
        }));
    }

    let balance = Tokens::account(state.signer_id.clone())
        .near_balance()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching signer near balance: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    // Liquid balance = total - storage locked
    let liquid = NearToken::from_yoctonear(
        balance
            .total
            .as_yoctonear()
            .saturating_sub(balance.storage_locked.as_yoctonear()),
    );

    let creation_available = liquid >= LOW_BALANCE_THRESHOLD;

    Ok(Json(TreasuryCreationStatusResponse { creation_available }))
}

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct StorageCreditsQuery {
    pub account_id: String,
}

#[derive(Serialize)]
pub struct StorageCreditsResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<String>, // NearToken as string (yoctoNEAR)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// View storage credits for a DAO account in the bulk payment contract
pub async fn get_storage_credits(
    State(state): State<Arc<AppState>>,
    Query(params): Query<StorageCreditsQuery>,
) -> Result<Json<StorageCreditsResponse>, (StatusCode, Json<StorageCreditsResponse>)> {
    let account_id = params.account_id.clone();

    // Call the bulk payment contract's view_storage_credits method
    let result = near_api::Contract(state.bulk_payment_contract_id.clone())
        .call_function(
            "view_storage_credits",
            serde_json::json!({
                "account_id": account_id,
            }),
        )
        .read_only::<String>() // Returns yoctoNEAR as string
        .fetch_from(&state.network)
        .await;

    match result {
        Ok(response) => Ok(Json(StorageCreditsResponse {
            success: true,
            credits: Some(response.data),
            error: None,
        })),
        Err(e) => {
            log::error!("Failed to get storage credits for {}: {}", account_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(StorageCreditsResponse {
                    success: false,
                    credits: None,
                    error: Some(format!("Failed to fetch storage credits: {}", e)),
                }),
            ))
        }
    }
}

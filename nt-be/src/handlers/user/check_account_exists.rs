use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{Account, AccountId};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckAccountExistsQuery {
    pub account_id: AccountId,
}

#[derive(Serialize)]
pub struct CheckAccountExistsResponse {
    pub exists: bool,
}

pub async fn check_account_exists(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CheckAccountExistsQuery>,
) -> Result<Json<CheckAccountExistsResponse>, (StatusCode, String)> {
    let account_id = params.account_id;

    match Account(account_id.clone())
        .view()
        .fetch_from(&state.network)
        .await
    {
        Ok(_) => Ok(Json(CheckAccountExistsResponse { exists: true })),
        Err(e) => {
            if e.to_string().contains("UnknownAccount") {
                Ok(Json(CheckAccountExistsResponse { exists: false }))
            } else {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to check account: {}", e),
                ))
            }
        }
    }
}

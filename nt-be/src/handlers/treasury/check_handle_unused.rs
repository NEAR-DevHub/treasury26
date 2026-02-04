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
pub struct CheckHandleUnusedQuery {
    pub treasury_id: AccountId,
}

#[derive(Serialize)]
pub struct CheckHandleUnusedResponse {
    pub unused: bool,
}

pub async fn check_handle_unused(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CheckHandleUnusedQuery>,
) -> Result<Json<CheckHandleUnusedResponse>, (StatusCode, String)> {
    let treasury_id = params.treasury_id;

    if !treasury_id.as_str().ends_with("sputnik-dao.near") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Treasury ID must end with sputnik-dao.near".to_string(),
        ));
    }

    match Account(treasury_id.clone())
        .view()
        .fetch_from(&state.network)
        .await
    {
        Ok(_) => Ok(Json(CheckHandleUnusedResponse { unused: false })),
        Err(e) => Ok(Json(CheckHandleUnusedResponse {
            unused: dbg!(e.to_string()).contains("UnknownAccount"),
        })),
    }
}

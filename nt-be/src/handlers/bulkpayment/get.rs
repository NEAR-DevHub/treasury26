use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    constants::BATCH_PAYMENT_ACCOUNT_ID,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Deserialize)]
pub struct BatchPaymentQuery {
    #[serde(rename = "batchId")]
    pub batch_id: String,
}

#[derive(Deserialize, Serialize)]
pub struct BatchPayment {
    pub recipient: AccountId,
    pub amount: String,
    pub status: serde_json::Value,
}

#[derive(Deserialize, Serialize)]
pub struct BatchPaymentResponse {
    pub token_id: AccountId,
    pub submitter: AccountId,
    pub status: String,
    pub payments: Vec<BatchPayment>,
}

pub async fn get_batch_payment(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BatchPaymentQuery>,
) -> Result<axum::Json<BatchPaymentResponse>, (StatusCode, String)> {
    let batch_id = params.batch_id.clone();
    let cache_key = CacheKey::new("batch-payment").with(&batch_id).build();

    let result = state
        .cache
        .clone()
        .cached_contract_call(CacheTier::LongTerm, cache_key, async move {
            near_api::Contract(BATCH_PAYMENT_ACCOUNT_ID.into())
                .call_function(
                    "view_list",
                    serde_json::json!({
                        "list_id": batch_id,
                    }),
                )
                .read_only::<BatchPaymentResponse>()
                .fetch_from(&state.network)
                .await
                .map(|r| r.data)
        })
        .await?;

    Ok(axum::Json(result))
}

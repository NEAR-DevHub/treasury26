use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::{
    AppState,
    handlers::proposals::scraper::{BatchPaymentResponse, fetch_batch_payment_list},
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Deserialize)]
pub struct BatchPaymentQuery {
    #[serde(rename = "batchId")]
    pub batch_id: String,
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
            fetch_batch_payment_list(&state.network, &batch_id).await
        })
        .await?;

    Ok(axum::Json(result))
}

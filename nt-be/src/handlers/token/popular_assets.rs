use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{
    AppState,
    handlers::token::{fetch_tokens_metadata_enriched, metadata::TokenMetadata},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopularAssetsQuery {
    pub limit: Option<i64>,
    pub lookback_days: Option<i32>,
}

#[derive(Debug, FromRow)]
struct PopularAssetRow {
    token_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopularAssetsResponse {
    pub data: Vec<TokenMetadata>,
}

pub async fn get_popular_assets_by_activity(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PopularAssetsQuery>,
) -> Result<Json<PopularAssetsResponse>, (StatusCode, String)> {
    let limit = params.limit.unwrap_or(8).clamp(1, 50);
    let lookback_days = params.lookback_days.unwrap_or(45).clamp(1, 365);

    let rows = sqlx::query_as::<_, PopularAssetRow>(
        r#"
        WITH scoped_changes AS (
            SELECT
                token_id,
                account_id,
                COALESCE(transaction_hashes[1], CONCAT('row-', id::text)) AS tx_hash
            FROM balance_changes
            WHERE block_time >= NOW() - make_interval(days => $1)
              AND token_id IS NOT NULL
              AND token_id <> ''
              AND token_id NOT LIKE 'staking:%'
              AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'NOT_REGISTERED')
              AND (
                  account_id LIKE '%.sputnik-dao.near'
                  OR counterparty LIKE '%.sputnik-dao.near'
              )
        ),
        deduped_changes AS (
            SELECT DISTINCT
                token_id,
                account_id,
                tx_hash
            FROM scoped_changes
        ),
        ranked_assets AS (
            SELECT
                token_id,
                COUNT(*)::float8 AS activity_count,
                COUNT(DISTINCT account_id)::float8 AS active_treasuries,
                (COUNT(*)::float8 * 0.7 + COUNT(DISTINCT account_id)::float8 * 0.3) AS popularity_score
            FROM deduped_changes
            GROUP BY token_id
        )
        SELECT
            token_id
        FROM ranked_assets
        ORDER BY popularity_score DESC, activity_count DESC
        LIMIT $2
        "#,
    )
    .bind(lookback_days)
    .bind(limit)
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch popular assets: {}", e),
        )
    })?;

    let token_ids: Vec<String> = rows.iter().map(|row| row.token_id.clone()).collect();
    let metadata_map = fetch_tokens_metadata_enriched(&state, &token_ids).await;

    let data = rows
        .into_iter()
        .filter_map(|row| metadata_map.get(&row.token_id).cloned())
        .collect();

    Ok(Json(PopularAssetsResponse { data }))
}

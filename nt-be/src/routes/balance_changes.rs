use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::types::BigDecimal;
use sqlx::types::chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct BalanceChangesQuery {
    pub account_id: String,
    pub token_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BalanceChange {
    pub id: i64,
    pub account_id: String,
    pub block_height: i64,
    pub block_timestamp: i64,
    pub token_id: String,
    pub counterparty: Option<String>,
    pub amount: BigDecimal,
    pub balance_before: BigDecimal,
    pub balance_after: BigDecimal,
    pub actions: Value,
    pub created_at: DateTime<Utc>,
}

pub async fn get_balance_changes(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BalanceChangesQuery>,
) -> Result<Json<Vec<BalanceChange>>, (StatusCode, Json<Value>)> {
    let limit = params.limit.unwrap_or(100).min(1000);
    let offset = params.offset.unwrap_or(0);

    let changes = if let Some(token_id) = params.token_id {
        sqlx::query_as::<_, BalanceChange>(
            r#"
            SELECT id, account_id, block_height, block_timestamp, token_id, 
                   counterparty, amount, balance_before, balance_after, 
                   actions, created_at
            FROM balance_changes
            WHERE account_id = $1 AND token_id = $2
            ORDER BY block_height DESC, id DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(&params.account_id)
        .bind(&token_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db_pool)
        .await
    } else {
        sqlx::query_as::<_, BalanceChange>(
            r#"
            SELECT id, account_id, block_height, block_timestamp, token_id, 
                   counterparty, amount, balance_before, balance_after, 
                   actions, created_at
            FROM balance_changes
            WHERE account_id = $1
            ORDER BY block_height DESC, id DESC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(&params.account_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db_pool)
        .await
    };

    match changes {
        Ok(data) => Ok(Json(data)),
        Err(e) => {
            log::error!("Failed to fetch balance changes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch balance changes",
                    "details": e.to_string()
                })),
            ))
        }
    }
}

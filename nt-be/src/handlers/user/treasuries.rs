use crate::handlers::treasury::config::{TreasuryConfig, fetch_treasury_config};
use crate::utils::cache::CacheTier;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct UserTreasuriesQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Treasury {
    #[serde(rename = "daoId")]
    pub dao_id: AccountId,
    pub config: TreasuryConfig,
}

pub async fn get_user_treasuries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserTreasuriesQuery>,
) -> Result<Json<Vec<Treasury>>, (StatusCode, String)> {
    let account_id = params.account_id.clone();

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let cache_key = format!("user-treasuries:{}", account_id);
    let state_clone = state.clone();

    let treasuries = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            // Query local database for user's DAO memberships
            let dao_ids: Vec<String> = sqlx::query_scalar(
                r#"
                SELECT DISTINCT dao_id
                FROM dao_members
                WHERE account_id = $1
                ORDER BY dao_id
                "#,
            )
            .bind(&account_id)
            .fetch_all(&state_clone.db_pool)
            .await
            .map_err(|e| {
                log::error!("Error fetching user DAOs from database: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to fetch user DAOs".to_string(),
                )
            })?;

            if dao_ids.is_empty() {
                return Ok(Vec::new());
            }

            let mut treasuries = Vec::new();

            for dao_id_str in dao_ids {
                let dao_id: AccountId = match dao_id_str.parse() {
                    Ok(id) => id,
                    Err(e) => {
                        log::warn!("Invalid DAO ID in database: {} - {}", dao_id_str, e);
                        continue;
                    }
                };

                let config = fetch_treasury_config(&state_clone, &dao_id, None).await?;

                treasuries.push(Treasury { dao_id, config });
            }

            Ok::<_, (StatusCode, String)>(treasuries)
        })
        .await?;

    Ok(Json(treasuries))
}

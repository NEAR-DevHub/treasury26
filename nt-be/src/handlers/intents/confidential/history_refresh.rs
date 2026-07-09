use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Duration, Utc};
use near_account_id::AccountIdRef;
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::auth::OptionalAuthUser;
use crate::handlers::intents::confidential::bronze::ingest_worker::{
    CONFIDENTIAL_HISTORY_TRIGGER_LIMIT, run_account_history_full_drain,
};
use crate::handlers::intents::confidential::bronze::store::mark_confidential_history_activity_due;
use crate::handlers::intents::confidential::gold::history_events::confidential_deposit_corrections_enabled;
use crate::handlers::intents::confidential::gold::{
    ConfidentialDepositCorrector, project_confidential_gold_for_dao,
    snapshot_confidential_dao_balances,
};

const REFRESH_COOLDOWN: Duration = Duration::seconds(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRefreshStatusQuery {
    pub account_id: AccountId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRefreshRequest {
    pub account_id: AccountId,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRefreshStatusResponse {
    pub account_id: AccountId,
    pub last_updated_at: Option<DateTime<Utc>>,
    pub can_refresh: bool,
    pub cooldown_ends_at: Option<DateTime<Utc>>,
}

fn build_refresh_status(
    account_id: AccountId,
    last_updated_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> HistoryRefreshStatusResponse {
    let cooldown_ends_at = last_updated_at.map(|last_updated| last_updated + REFRESH_COOLDOWN);
    let can_refresh = cooldown_ends_at.is_none_or(|ends_at| ends_at <= now);

    HistoryRefreshStatusResponse {
        account_id,
        last_updated_at,
        can_refresh,
        cooldown_ends_at: if can_refresh { None } else { cooldown_ends_at },
    }
}

fn ensure_refresh_allowed(
    status: &HistoryRefreshStatusResponse,
) -> Result<(), (StatusCode, String)> {
    if status.can_refresh {
        Ok(())
    } else {
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Confidential history refresh is on cooldown".to_string(),
        ))
    }
}

async fn ensure_enabled_confidential_dao(
    state: &AppState,
    account_id: &AccountId,
) -> Result<(), (StatusCode, String)> {
    let is_enabled_confidential: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM monitored_accounts
            WHERE account_id = $1
              AND enabled = true
              AND is_confidential_account = true
        )
        "#,
    )
    .bind(account_id.as_str())
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if is_enabled_confidential {
        Ok(())
    } else {
        Err((
            StatusCode::NOT_FOUND,
            format!("Confidential DAO {} is not monitored", account_id),
        ))
    }
}

async fn load_last_updated_at(
    state: &AppState,
    account_id: &AccountId,
) -> Result<Option<DateTime<Utc>>, (StatusCode, String)> {
    sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        r#"
        SELECT last_polled_at
        FROM bronze_confidential_history_cursors
        WHERE account_id = $1
        "#,
    )
    .bind(account_id.as_str())
    .fetch_optional(&state.db_pool)
    .await
    .map(|row| row.flatten())
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn load_refresh_status(
    state: &AppState,
    account_id: AccountId,
) -> Result<HistoryRefreshStatusResponse, (StatusCode, String)> {
    let last_updated_at = load_last_updated_at(state, &account_id).await?;
    Ok(build_refresh_status(
        account_id,
        last_updated_at,
        Utc::now(),
    ))
}

pub async fn get_confidential_history_refresh_status(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<HistoryRefreshStatusQuery>,
) -> Result<Json<HistoryRefreshStatusResponse>, (StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await?;
    ensure_enabled_confidential_dao(&state, &params.account_id).await?;

    let status = load_refresh_status(&state, params.account_id).await?;
    Ok(Json(status))
}

pub async fn refresh_confidential_history(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Json(request): Json<HistoryRefreshRequest>,
) -> Result<Json<HistoryRefreshStatusResponse>, (StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, &request.account_id)
        .await?;
    ensure_enabled_confidential_dao(&state, &request.account_id).await?;

    let status = load_refresh_status(&state, request.account_id.clone()).await?;
    ensure_refresh_allowed(&status)?;

    let account_ref = AccountIdRef::new(request.account_id.as_str())
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    mark_confidential_history_activity_due(&state.db_pool, request.account_id.as_str())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    run_account_history_full_drain(&state, account_ref, CONFIDENTIAL_HISTORY_TRIGGER_LIMIT).await?;

    let mut projection_changed = false;
    let stats = project_confidential_gold_for_dao(&state.db_pool, request.account_id.as_str())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    projection_changed |= stats.rows_projected > 0 || stats.rows_deleted > 0;

    let corrections_written = if confidential_deposit_corrections_enabled() {
        ConfidentialDepositCorrector::reconcile_dao(&state.db_pool, request.account_id.as_str())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
        0
    };

    if corrections_written > 0 {
        let stats = project_confidential_gold_for_dao(&state.db_pool, request.account_id.as_str())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        projection_changed |= stats.rows_projected > 0 || stats.rows_deleted > 0;
    }

    if projection_changed {
        state.publish_treasury_projection_updated(request.account_id.to_string());
    }

    snapshot_confidential_dao_balances(&state, request.account_id.as_str()).await;

    let status = load_refresh_status(&state, request.account_id).await?;
    Ok(Json(status))
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(second: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 6, 19, 0, 0, 0).unwrap() + Duration::seconds(second)
    }

    fn account() -> AccountId {
        "testing-109.sputnik-dao.near".parse().unwrap()
    }

    #[test]
    fn refresh_status_allows_missing_last_update() {
        let status = build_refresh_status(account(), None, at(30));

        assert!(status.can_refresh);
        assert_eq!(status.last_updated_at, None);
        assert_eq!(status.cooldown_ends_at, None);
    }

    #[test]
    fn refresh_status_disables_during_cooldown() {
        let status = build_refresh_status(account(), Some(at(0)), at(5));

        assert!(!status.can_refresh);
        assert_eq!(status.cooldown_ends_at, Some(at(10)));
        assert!(ensure_refresh_allowed(&status).is_err());
    }

    #[test]
    fn refresh_status_allows_after_cooldown() {
        let status = build_refresh_status(account(), Some(at(0)), at(10));

        assert!(status.can_refresh);
        assert_eq!(status.cooldown_ends_at, None);
        assert!(ensure_refresh_allowed(&status).is_ok());
    }
}

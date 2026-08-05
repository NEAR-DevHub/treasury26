//! Submission/vote hook: the frontend calls this right after broadcasting
//! `add_proposal` or `act_proposal`, so `dao_proposals` learns about the
//! proposal (and its executed status) in seconds instead of at indexer
//! speed. The client supplies only identifiers — every fact is fetched from
//! the live `get_proposal` RPC — and the NearBlocks linker remains the
//! safety net for proposals submitted outside the app.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::{Deserialize, Serialize};

use super::linker::refresh_proposal_from_chain;
use crate::AppState;
use crate::handlers::public_history::silver::cursors::mark_silver_dirty_tx;

const REFRESH_COOLDOWN: Duration = Duration::from_secs(10);
/// Freshly learned proposal facts (status, execution linkage) re-project
/// onto legs indexed around approval time; the dirty mark must reach back
/// far enough for the recompute window to cover them.
const DIRTY_LOOKBACK_MINUTES: i64 = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshProposalRequest {
    pub account_id: AccountId,
    pub proposal_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshProposalResponse {
    pub status: Option<String>,
}

fn cooldowns() -> &'static Mutex<HashMap<String, Instant>> {
    static COOLDOWNS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    COOLDOWNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn check_cooldown(key: String) -> bool {
    let mut map = cooldowns().lock().expect("cooldown lock");
    let now = Instant::now();
    map.retain(|_, at| now.duration_since(*at) < REFRESH_COOLDOWN);
    match map.get(&key) {
        Some(_) => false,
        None => {
            map.insert(key, now);
            true
        }
    }
}

pub async fn refresh_public_proposal(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RefreshProposalRequest>,
) -> Result<Json<RefreshProposalResponse>, (StatusCode, String)> {
    let dao_id = request.account_id.as_str();

    let eligible: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM monitored_accounts
            WHERE account_id = $1
              AND enabled = true
              AND COALESCE(is_confidential_account, false) = false
        )
        "#,
    )
    .bind(dao_id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !eligible {
        return Err((
            StatusCode::NOT_FOUND,
            "unknown or non-public treasury".to_string(),
        ));
    }

    if !check_cooldown(format!("{dao_id}:{}", request.proposal_id)) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "proposal refresh cooling down".to_string(),
        ));
    }

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let status = refresh_proposal_from_chain(&state, &mut tx, dao_id, request.proposal_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if status.is_none() {
        tx.rollback().await.ok();
        return Err((
            StatusCode::BAD_GATEWAY,
            "proposal not found on chain".to_string(),
        ));
    }

    mark_silver_dirty_tx(
        &mut tx,
        dao_id,
        Some(chrono::Utc::now() - chrono::Duration::minutes(DIRTY_LOOKBACK_MINUTES)),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RefreshProposalResponse {
        status: status.map(str::to_string),
    }))
}

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use sqlx::Postgres;
use std::sync::Arc;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, handlers::treasury::config::fetch_treasury_config};

fn internal_error(context: &str, e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("{context}: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error".to_string(),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteResponse {
    pub token: Uuid,
    pub url: String,
}

/// `POST /api/treasury/{dao_id}/member-invites` — create a one-time invite link.
pub async fn create_member_invite(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
) -> Result<Json<CreateInviteResponse>, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &dao_id)
        .await?;

    let created_by = sqlx::query_scalar!(
        "SELECT id FROM users WHERE account_id = $1",
        auth_user.account_id.as_str()
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to look up invite creator", e))?;

    let token = sqlx::query_scalar!(
        r#"
        INSERT INTO member_invite_links (dao_id, created_by)
        VALUES ($1, $2)
        RETURNING token
        "#,
        dao_id.as_str(),
        created_by
    )
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to create member invite link", e))?;

    let url = format!(
        "{}/join/{}",
        state.env_vars.frontend_base_url.trim_end_matches('/'),
        token
    );

    Ok(Json(CreateInviteResponse { token, url }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteLinkStatus {
    Valid,
    Used,
    Expired,
    NotFound,
}

impl InviteLinkStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Used => "used",
            Self::Expired => "expired",
            Self::NotFound => "not_found",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteLinkInfoResponse {
    pub dao_id: AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub treasury_name: Option<String>,
    pub status: InviteLinkStatus,
}

struct InviteLinkRow {
    dao_id: String,
    used_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
}

fn resolve_invite_status(row: &InviteLinkRow) -> InviteLinkStatus {
    if row.used_at.is_some() {
        InviteLinkStatus::Used
    } else if row.expires_at <= Utc::now() {
        InviteLinkStatus::Expired
    } else {
        InviteLinkStatus::Valid
    }
}

/// `GET /api/member-invites/{token}` — public invite link metadata.
pub async fn get_member_invite(
    State(state): State<Arc<AppState>>,
    Path(token): Path<Uuid>,
) -> Result<Json<InviteLinkInfoResponse>, (StatusCode, String)> {
    let row = sqlx::query_as!(
        InviteLinkRow,
        r#"
        SELECT dao_id, used_at, expires_at
        FROM member_invite_links
        WHERE token = $1
        "#,
        token
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to fetch member invite link", e))?;

    let Some(row) = row else {
        return Err((StatusCode::NOT_FOUND, "Invite link not found".to_string()));
    };

    let status = resolve_invite_status(&row);
    let dao_id: AccountId = row
        .dao_id
        .parse()
        .map_err(|e| internal_error("Invalid dao_id on invite link", e))?;

    let treasury_name = if status == InviteLinkStatus::Valid {
        let config = fetch_treasury_config(&state, &dao_id, None).await?;
        config.name
    } else {
        None
    };

    Ok(Json(InviteLinkInfoResponse {
        dao_id,
        treasury_name,
        status,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinViaInviteRequest {
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinViaInviteResponse {
    pub dao_id: AccountId,
    pub request_id: Uuid,
}

async fn upsert_display_name(
    pool: &sqlx::PgPool,
    account_id: &str,
    display_name: Option<String>,
) -> Result<(), (StatusCode, String)> {
    let Some(name) = display_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
    else {
        return Ok(());
    };

    sqlx::query!(
        r#"
        INSERT INTO user_profiles (account_id, display_name)
        VALUES ($1, $2)
        ON CONFLICT (account_id) DO UPDATE
        SET display_name = EXCLUDED.display_name, updated_at = NOW()
        "#,
        account_id,
        name
    )
    .execute(pool)
    .await
    .map_err(|e| internal_error("Failed to upsert user profile", e))?;

    Ok(())
}

/// `POST /api/member-invites/{token}/join` — consume an invite and create a pending join request.
pub async fn join_via_invite(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(token): Path<Uuid>,
    Json(body): Json<JoinViaInviteRequest>,
) -> Result<Json<JoinViaInviteResponse>, (StatusCode, String)> {
    // Profile upsert is idempotent and independent of invite consumption.
    upsert_display_name(
        &state.db_pool,
        auth_user.account_id.as_str(),
        body.display_name,
    )
    .await?;

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|e| internal_error("Failed to start join transaction", e))?;

    // Lock the invite row so concurrent joins for the same token serialize:
    // validate → insert join request → mark used happen atomically.
    let invite = sqlx::query_as!(
        InviteLinkRow,
        r#"
        SELECT dao_id, used_at, expires_at
        FROM member_invite_links
        WHERE token = $1
        FOR UPDATE
        "#,
        token
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| internal_error("Failed to fetch member invite link", e))?;

    let Some(invite) = invite else {
        return Err((StatusCode::NOT_FOUND, "Invite link not found".to_string()));
    };

    let status = resolve_invite_status(&invite);
    if status != InviteLinkStatus::Valid {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Invite link is {}", status.as_str()),
        ));
    }

    let dao_id: AccountId = invite
        .dao_id
        .parse()
        .map_err(|e| internal_error("Invalid dao_id on invite link", e))?;

    let already_member = sqlx::query_scalar!(
        r#"
        SELECT 1 AS ok FROM dao_members
        WHERE dao_id = $1 AND account_id = $2 AND is_policy_member = true
        "#,
        dao_id.as_str(),
        auth_user.account_id.as_str()
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| internal_error("Failed to check DAO membership", e))?;

    if already_member.is_some() {
        return Err((
            StatusCode::CONFLICT,
            "Account is already a treasury member".to_string(),
        ));
    }

    let pending_request = sqlx::query_scalar!(
        r#"
        SELECT 1 AS ok FROM member_join_requests
        WHERE dao_id = $1 AND account_id = $2 AND status = 'pending'
        "#,
        dao_id.as_str(),
        auth_user.account_id.as_str()
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| internal_error("Failed to check pending join request", e))?;

    if pending_request.is_some() {
        return Err((
            StatusCode::CONFLICT,
            "A pending join request already exists for this treasury".to_string(),
        ));
    }

    let request_id =
        create_pending_join_request(&mut tx, &dao_id, auth_user.account_id.as_str(), token).await?;

    mark_invite_used(&mut tx, token, auth_user.account_id.as_str()).await?;

    tx.commit()
        .await
        .map_err(|e| internal_error("Failed to commit join transaction", e))?;

    Ok(Json(JoinViaInviteResponse { dao_id, request_id }))
}

async fn create_pending_join_request(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    dao_id: &AccountId,
    account_id: &str,
    invite_token: Uuid,
) -> Result<Uuid, (StatusCode, String)> {
    sqlx::query_scalar!(
        r#"
        INSERT INTO member_join_requests (dao_id, account_id, invite_token)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
        dao_id.as_str(),
        account_id,
        invite_token
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| {
        if e.as_database_error()
            .map(|db| db.is_unique_violation())
            .unwrap_or(false)
        {
            (
                StatusCode::CONFLICT,
                "Invite link was already used or a pending join request already exists".to_string(),
            )
        } else {
            internal_error("Failed to create join request", e)
        }
    })
}

async fn mark_invite_used(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    token: Uuid,
    account_id: &str,
) -> Result<(), (StatusCode, String)> {
    let updated = sqlx::query!(
        r#"
        UPDATE member_invite_links
        SET used_at = NOW(), used_by_account_id = $2
        WHERE token = $1 AND used_at IS NULL
        "#,
        token,
        account_id
    )
    .execute(&mut **tx)
    .await
    .map_err(|e| internal_error("Failed to mark invite link as used", e))?;

    if updated.rows_affected() == 0 {
        return Err((
            StatusCode::CONFLICT,
            "Invite link was already used".to_string(),
        ));
    }

    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberJoinRequestItem {
    pub id: Uuid,
    pub account_id: AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// `GET /api/treasury/{dao_id}/member-join-requests` — list pending join requests.
pub async fn list_member_join_requests(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
) -> Result<Json<Vec<MemberJoinRequestItem>>, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &dao_id)
        .await?;

    let rows = sqlx::query!(
        r#"
        SELECT mjr.id, mjr.account_id, mjr.created_at, up.display_name
        FROM member_join_requests mjr
        LEFT JOIN user_profiles up ON up.account_id = mjr.account_id
        WHERE mjr.dao_id = $1 AND mjr.status = 'pending'
        ORDER BY mjr.created_at ASC
        "#,
        dao_id.as_str()
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to list member join requests", e))?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(MemberJoinRequestItem {
            id: row.id,
            account_id: row
                .account_id
                .parse()
                .map_err(|e| internal_error("Invalid account_id on join request", e))?,
            display_name: row.display_name,
            created_at: row.created_at,
        });
    }

    Ok(Json(items))
}

/// `DELETE /api/treasury/{dao_id}/member-join-requests/{id}` — cancel a pending join request.
pub async fn cancel_member_join_request(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path((dao_id, id)): Path<(AccountId, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &dao_id)
        .await?;

    let updated = sqlx::query!(
        r#"
        UPDATE member_join_requests
        SET status = 'cancelled'
        WHERE id = $1 AND dao_id = $2 AND status = 'pending'
        "#,
        id,
        dao_id.as_str()
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to cancel member join request", e))?;

    if updated.rows_affected() == 0 {
        return Err((
            StatusCode::NOT_FOUND,
            "Pending join request not found".to_string(),
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveMemberJoinRequestsRequest {
    pub request_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveMemberJoinRequestsResponse {
    pub approved_count: u64,
}

/// `POST /api/treasury/{dao_id}/member-join-requests/approve` — mark join requests approved.
pub async fn approve_member_join_requests(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
    Json(body): Json<ApproveMemberJoinRequestsRequest>,
) -> Result<Json<ApproveMemberJoinRequestsResponse>, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &dao_id)
        .await?;

    if body.request_ids.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "requestIds must not be empty".to_string(),
        ));
    }

    let updated = sqlx::query!(
        r#"
        UPDATE member_join_requests
        SET status = 'approved'
        WHERE dao_id = $1
          AND status = 'pending'
          AND id = ANY($2)
        "#,
        dao_id.as_str(),
        &body.request_ids
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to approve member join requests", e))?;

    Ok(Json(ApproveMemberJoinRequestsResponse {
        approved_count: updated.rows_affected(),
    }))
}

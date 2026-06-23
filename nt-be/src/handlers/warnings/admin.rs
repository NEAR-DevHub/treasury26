use axum::{
    Json,
    extract::{Path, Query, State},
    http::{
        HeaderMap, StatusCode,
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
    },
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::{AppState, handlers::warnings::templates, utils::cache::CacheKey};

const BASIC_AUTH_REALM: &str = "Warnings Admin";

pub struct AdminError {
    status: StatusCode,
    message: String,
    headers: Option<HeaderMap>,
}

impl AdminError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            headers: None,
        }
    }

    fn with_headers(status: StatusCode, message: impl Into<String>, headers: HeaderMap) -> Self {
        Self {
            status,
            message: message.into(),
            headers: Some(headers),
        }
    }
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        let body = json!({ "error": self.message });
        let mut response = (self.status, Json(body)).into_response();
        if let Some(headers) = self.headers {
            for (key, value) in headers.iter() {
                response.headers_mut().insert(key, value.clone());
            }
        }
        response
    }
}

pub struct AdminUser {
    pub username: String,
}

pub fn require_admin(headers: &HeaderMap, state: &AppState) -> Result<AdminUser, AdminError> {
    let mut unauthorized_headers = HeaderMap::new();
    unauthorized_headers.insert(
        WWW_AUTHENTICATE,
        format!("Basic realm=\"{BASIC_AUTH_REALM}\"")
            .parse()
            .unwrap(),
    );

    let credentials = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
        .and_then(|encoded| STANDARD.decode(encoded).ok())
        .and_then(|decoded| String::from_utf8(decoded).ok());

    let Some(credentials) = credentials else {
        return Err(AdminError::with_headers(
            StatusCode::UNAUTHORIZED,
            "Session expired. Please reload the page and sign in again.",
            unauthorized_headers,
        ));
    };

    let Some((username, password)) = credentials.split_once(':') else {
        return Err(AdminError::with_headers(
            StatusCode::UNAUTHORIZED,
            "Invalid credentials format.",
            unauthorized_headers,
        ));
    };

    let Some((configured_username, configured_password)) = state
        .env_vars
        .admin_username
        .as_deref()
        .zip(state.env_vars.admin_password.as_deref())
    else {
        return Err(AdminError::with_headers(
            StatusCode::UNAUTHORIZED,
            "Admin access is not configured.",
            unauthorized_headers,
        ));
    };

    if username == configured_username && password == configured_password {
        Ok(AdminUser {
            username: username.to_string(),
        })
    } else {
        Err(AdminError::with_headers(
            StatusCode::UNAUTHORIZED,
            "Incorrect username or password.",
            unauthorized_headers,
        ))
    }
}

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdminWarning {
    pub id: i32,
    pub slot: Option<String>,
    pub token: Option<String>,
    pub network: Option<String>,
    pub is_active: bool,
    pub severity: String,
    pub user_message: Option<String>,
    pub scenario: Option<String>,
    pub internal_note: Option<String>,
    pub scheduled_start: Option<DateTime<Utc>>,
    pub scheduled_end: Option<DateTime<Utc>>,
    pub updated_by: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWarningRequest {
    pub slot: Option<String>,
    pub token: Option<String>,
    pub network: Option<String>,
    pub is_active: Option<bool>,
    pub severity: Option<String>,
    pub user_message: Option<String>,
    pub scenario: Option<String>,
    pub internal_note: Option<String>,
    pub scheduled_start: Option<DateTime<Utc>>,
    pub scheduled_end: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWarningRequest {
    pub slot: Option<String>,
    pub token: Option<String>,
    pub network: Option<String>,
    pub is_active: Option<bool>,
    pub severity: Option<String>,
    pub user_message: Option<String>,
    pub scenario: Option<String>,
    pub internal_note: Option<String>,
    pub scheduled_start: Option<Option<DateTime<Utc>>>,
    pub scheduled_end: Option<Option<DateTime<Utc>>>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: i64,
    pub warning_id: Option<i32>,
    pub action: String,
    pub changed_by: String,
    pub changes: Option<Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct AuditLogQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogResponse {
    pub entries: Vec<AuditLogEntry>,
    pub page: i64,
    pub limit: i64,
    pub total: i64,
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn validate_severity(severity: &str) -> Result<(), (StatusCode, String)> {
    match severity {
        "info" | "warning" | "critical" => Ok(()),
        _ => Err((
            StatusCode::BAD_REQUEST,
            "severity must be one of: info, warning, critical".to_string(),
        )),
    }
}

async fn invalidate_warnings_cache(state: &AppState) {
    let cache_key = CacheKey::new("public-warnings").build();
    state.cache.short_term.invalidate(&cache_key).await;
}

async fn insert_audit_log(
    pool: &sqlx::PgPool,
    warning_id: Option<i32>,
    action: &str,
    changed_by: &str,
    changes: Value,
) -> Result<(), (StatusCode, String)> {
    sqlx::query(
        r#"
        INSERT INTO warning_audit_log (warning_id, action, changed_by, changes)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(warning_id)
    .bind(action)
    .bind(changed_by)
    .bind(changes)
    .execute(pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to insert audit log: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write audit log: {}", e),
        )
    })?;

    Ok(())
}

fn determine_update_action(
    old: &AdminWarning,
    new_is_active: bool,
    scheduled_start: &Option<DateTime<Utc>>,
    scheduled_end: &Option<DateTime<Utc>>,
) -> &'static str {
    if old.is_active != new_is_active {
        return if new_is_active {
            "activated"
        } else {
            "deactivated"
        };
    }

    if scheduled_start.is_some() || scheduled_end.is_some() {
        return "scheduled";
    }

    "updated"
}

fn build_changes(old: &AdminWarning, new: &AdminWarning) -> Value {
    let mut changes = serde_json::Map::new();

    macro_rules! push_change {
        ($field:ident) => {
            if old.$field != new.$field {
                changes.insert(
                    stringify!($field).to_string(),
                    json!([old.$field, new.$field]),
                );
            }
        };
    }

    push_change!(slot);
    push_change!(token);
    push_change!(network);
    push_change!(is_active);
    push_change!(severity);
    push_change!(user_message);
    push_change!(scenario);
    push_change!(internal_note);
    push_change!(scheduled_start);
    push_change!(scheduled_end);

    Value::Object(changes)
}

pub async fn list_warnings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminWarning>>, AdminError> {
    let _admin = require_admin(&headers, &state)?;

    let warnings = sqlx::query_as::<_, AdminWarning>(
        r#"
        SELECT
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            scheduled_start, scheduled_end,
            updated_by, updated_at, created_at
        FROM warning_slots
        ORDER BY id
        "#,
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to list warnings: {}", e);
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load warnings. Please try again.",
        )
    })?;

    Ok(Json(warnings))
}

pub async fn create_warning(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateWarningRequest>,
) -> Result<Json<AdminWarning>, AdminError> {
    let admin = require_admin(&headers, &state)?;

    let mut severity = body.severity.unwrap_or_else(|| "warning".to_string());
    validate_severity(&severity).map_err(|(status, msg)| AdminError::new(status, msg))?;

    let slot = empty_to_none(body.slot);
    let token = empty_to_none(body.token);
    let network = empty_to_none(body.network);
    let scenario = empty_to_none(body.scenario);

    // App-level scenarios imply their own severity tier.
    if let Some(implied) = scenario.as_deref().and_then(templates::scenario_severity) {
        severity = implied.to_string();
    }

    let generated = templates::generate_messages(
        &severity,
        slot.as_deref(),
        token.as_deref(),
        network.as_deref(),
        scenario.as_deref(),
    );

    let user_message = empty_to_none(body.user_message).or_else(|| generated.clone());
    let user_message = user_message.unwrap_or_default();
    // The treasury-creation slot replaces the form with the waitlist, so it has
    // no user-facing message — skip the requirement for it.
    if user_message.trim().is_empty() && slot.as_deref() != Some("treasury-creation") {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "User-facing message is required.",
        ));
    }

    let is_active = body.is_active.unwrap_or(false);
    if !is_active && body.scheduled_start.is_none() {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Either mark the warning as active or set a scheduled start time.",
        ));
    }
    if let (Some(start), Some(end)) = (body.scheduled_start, body.scheduled_end) {
        if end <= start {
            return Err(AdminError::new(
                StatusCode::BAD_REQUEST,
                "Scheduled end time must be after the start time.",
            ));
        }
    }

    let warning = sqlx::query_as::<_, AdminWarning>(
        r#"
        INSERT INTO warning_slots (
            slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            scheduled_start, scheduled_end, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            scheduled_start, scheduled_end,
            updated_by, updated_at, created_at
        "#,
    )
    .bind(&slot)
    .bind(&token)
    .bind(&network)
    .bind(is_active)
    .bind(&severity)
    .bind(&user_message)
    .bind(&scenario)
    .bind(&body.internal_note)
    .bind(body.scheduled_start)
    .bind(body.scheduled_end)
    .bind(&admin.username)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to create warning: {}", e);
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint().is_some() {
                return AdminError::new(StatusCode::CONFLICT, "A warning with the same slot, token, and network combination already exists. Edit the existing one instead, or delete it first.");
            }
        }
        AdminError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create warning. Please try again.")
    })?;

    let action = if body.scheduled_start.is_some() || body.scheduled_end.is_some() {
        "scheduled"
    } else if is_active {
        "activated"
    } else {
        "created"
    };

    insert_audit_log(
        &state.db_pool,
        Some(warning.id),
        action,
        &admin.username,
        json!({
            "slot": warning.slot,
            "token": warning.token,
            "network": warning.network,
            "is_active": warning.is_active,
            "severity": warning.severity,
            "user_message": warning.user_message,
            "scenario": warning.scenario,
            "internal_note": warning.internal_note,
            "scheduled_start": warning.scheduled_start,
            "scheduled_end": warning.scheduled_end,
        }),
    )
    .await
    .map_err(|(status, msg)| AdminError::new(status, msg))?;

    invalidate_warnings_cache(&state).await;

    Ok(Json(warning))
}

pub async fn update_warning(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(body): Json<UpdateWarningRequest>,
) -> Result<Json<AdminWarning>, AdminError> {
    let admin = require_admin(&headers, &state)?;

    let existing = sqlx::query_as::<_, AdminWarning>(
        r#"
        SELECT
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            scheduled_start, scheduled_end,
            updated_by, updated_at, created_at
        FROM warning_slots
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|_| AdminError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load warning."))?
    .ok_or(AdminError::new(
        StatusCode::NOT_FOUND,
        "Warning not found — it may have been deleted by someone else. Try refreshing.",
    ))?;

    let previous = existing.clone();

    if let Some(ref severity) = body.severity {
        validate_severity(severity).map_err(|(status, msg)| AdminError::new(status, msg))?;
    }

    let slot = body
        .slot
        .map(|s| empty_to_none(Some(s)))
        .unwrap_or(existing.slot);
    let token = body
        .token
        .map(|s| empty_to_none(Some(s)))
        .unwrap_or(existing.token);
    let network = body
        .network
        .map(|s| empty_to_none(Some(s)))
        .unwrap_or(existing.network);
    let is_active = body.is_active.unwrap_or(existing.is_active);
    let scenario = match body.scenario {
        Some(value) => empty_to_none(Some(value)),
        None => existing.scenario.clone(),
    };
    let mut severity = body.severity.unwrap_or(existing.severity);
    if let Some(implied) = scenario.as_deref().and_then(templates::scenario_severity) {
        severity = implied.to_string();
    }

    let generated = templates::generate_messages(
        &severity,
        slot.as_deref(),
        token.as_deref(),
        network.as_deref(),
        scenario.as_deref(),
    );

    let user_message = match body.user_message {
        Some(value) => empty_to_none(Some(value)),
        None => existing.user_message.clone(),
    }
    .or_else(|| generated.clone());

    let internal_note = body
        .internal_note
        .or_else(|| existing.internal_note.clone());
    let scheduled_start = match body.scheduled_start {
        Some(value) => value,
        None => existing.scheduled_start,
    };
    let scheduled_end = match body.scheduled_end {
        Some(value) => value,
        None => existing.scheduled_end,
    };

    let updated = sqlx::query_as::<_, AdminWarning>(
        r#"
        UPDATE warning_slots
        SET
            slot = $2,
            token = $3,
            network = $4,
            is_active = $5,
            severity = $6,
            user_message = $7,
            scenario = $8,
            internal_note = $9,
            scheduled_start = $10,
            scheduled_end = $11,
            updated_by = $12,
            updated_at = NOW()
        WHERE id = $1
        RETURNING
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            scheduled_start, scheduled_end,
            updated_by, updated_at, created_at
        "#,
    )
    .bind(id)
    .bind(&slot)
    .bind(&token)
    .bind(&network)
    .bind(is_active)
    .bind(&severity)
    .bind(&user_message)
    .bind(&scenario)
    .bind(&internal_note)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .bind(&admin.username)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to update warning {}: {}", id, e);
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint().is_some() {
                return AdminError::new(
                    StatusCode::CONFLICT,
                    "A warning with the same slot, token, and network combination already exists.",
                );
            }
        }
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update warning. Please try again.",
        )
    })?;

    let action = determine_update_action(
        &previous,
        updated.is_active,
        &updated.scheduled_start,
        &updated.scheduled_end,
    );
    let changes = build_changes(&previous, &updated);

    if !changes.as_object().is_some_and(|m| m.is_empty()) {
        insert_audit_log(&state.db_pool, Some(id), action, &admin.username, changes)
            .await
            .map_err(|(status, msg)| AdminError::new(status, msg))?;
    }

    invalidate_warnings_cache(&state).await;

    Ok(Json(updated))
}

pub async fn delete_warning(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<StatusCode, AdminError> {
    let admin = require_admin(&headers, &state)?;

    let existing = sqlx::query_as::<_, AdminWarning>(
        r#"
        SELECT
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            scheduled_start, scheduled_end,
            updated_by, updated_at, created_at
        FROM warning_slots
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|_| AdminError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load warning."))?
    .ok_or(AdminError::new(
        StatusCode::NOT_FOUND,
        "Warning not found — it may have been deleted already.",
    ))?;

    sqlx::query("DELETE FROM warning_slots WHERE id = $1")
        .bind(id)
        .execute(&state.db_pool)
        .await
        .map_err(|_| {
            AdminError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete warning. Please try again.",
            )
        })?;

    insert_audit_log(
        &state.db_pool,
        None,
        "deleted",
        &admin.username,
        json!({
            "id": existing.id,
            "slot": existing.slot,
            "token": existing.token,
            "network": existing.network,
        }),
    )
    .await
    .map_err(|(status, msg)| AdminError::new(status, msg))?;

    invalidate_warnings_cache(&state).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_audit_log(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuditLogQuery>,
) -> Result<Json<AuditLogResponse>, AdminError> {
    let _admin = require_admin(&headers, &state)?;

    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * limit;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warning_audit_log")
        .fetch_one(&state.db_pool)
        .await
        .map_err(|_| {
            AdminError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load audit log.",
            )
        })?;

    let entries = sqlx::query_as::<_, AuditLogEntry>(
        r#"
        SELECT id, warning_id, action, changed_by, changes, created_at
        FROM warning_audit_log
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db_pool)
    .await
    .map_err(|_| {
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load audit log entries.",
        )
    })?;

    Ok(Json(AuditLogResponse {
        entries,
        page,
        limit,
        total,
    }))
}

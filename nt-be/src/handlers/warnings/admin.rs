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
    headers: Option<Box<HeaderMap>>,
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
            headers: Some(Box::new(headers)),
        }
    }
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        let body = json!({ "error": self.message });
        let mut response = (self.status, Json(body)).into_response();
        if let Some(headers) = self.headers {
            for (key, value) in headers.as_ref().iter() {
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
    pub show_from: Option<DateTime<Utc>>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub linked_service: Option<String>,
    pub linked_post_id: Option<String>,
    pub group_id: Option<String>,
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
    pub show_from: Option<DateTime<Utc>>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub linked_service: Option<String>,
    pub linked_post_id: Option<String>,
    pub group_id: Option<String>,
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
    pub show_from: Option<Option<DateTime<Utc>>>,
    pub starts_at: Option<Option<DateTime<Utc>>>,
    pub ends_at: Option<Option<DateTime<Utc>>>,
    pub linked_service: Option<Option<String>>,
    pub linked_post_id: Option<Option<String>>,
    pub group_id: Option<Option<String>>,
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
    show_from: &Option<DateTime<Utc>>,
    ends_at: &Option<DateTime<Utc>>,
) -> &'static str {
    if old.is_active != new_is_active {
        return if new_is_active {
            "activated"
        } else {
            "deactivated"
        };
    }

    if show_from.is_some() || ends_at.is_some() {
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
    push_change!(show_from);
    push_change!(starts_at);
    push_change!(ends_at);
    push_change!(linked_service);
    push_change!(linked_post_id);

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
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id,
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
    if !is_active && body.show_from.is_none() {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Either mark the warning as active or set a show-from time.",
        ));
    }
    if let (Some(start), Some(end)) = (body.starts_at, body.ends_at)
        && end <= start
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "End time must be after the start time.",
        ));
    }

    let linked_service = empty_to_none(body.linked_service);
    if let Some(ref svc) = linked_service
        && !crate::handlers::status::oh_dear::SUPPORTED_SERVICES.contains(&svc.as_str())
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Invalid linked service.",
        ));
    }
    let linked_post_id = empty_to_none(body.linked_post_id);
    let group_id = empty_to_none(body.group_id);

    let warning = sqlx::query_as::<_, AdminWarning>(
        r#"
        INSERT INTO warning_slots (
            slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id,
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
    .bind(body.show_from)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(&linked_service)
    .bind(&linked_post_id)
    .bind(&group_id)
    .bind(&admin.username)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to create warning: {}", e);
        if let sqlx::Error::Database(db_err) = &e
            && db_err.constraint().is_some()
        {
            return AdminError::new(StatusCode::CONFLICT, "A warning with the same slot, token, and network combination already exists. Edit the existing one instead, or delete it first.");
        }
        AdminError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create warning. Please try again.")
    })?;

    let action = if body.show_from.is_some() || body.ends_at.is_some() {
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
            "show_from": warning.show_from,
            "starts_at": warning.starts_at,
            "ends_at": warning.ends_at,
            "linked_service": warning.linked_service,
            "linked_post_id": warning.linked_post_id,
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
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id,
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
    let show_from = match body.show_from {
        Some(value) => value,
        None => existing.show_from,
    };
    let starts_at = match body.starts_at {
        Some(value) => value,
        None => existing.starts_at,
    };
    let ends_at = match body.ends_at {
        Some(value) => value,
        None => existing.ends_at,
    };
    let linked_service = match body.linked_service {
        Some(value) => value,
        None => existing.linked_service.clone(),
    };
    let linked_post_id = match body.linked_post_id {
        Some(value) => value,
        None => existing.linked_post_id.clone(),
    };
    let group_id = match body.group_id {
        Some(value) => value.filter(|s| !s.trim().is_empty()),
        None => existing.group_id.clone(),
    };

    if let Some(ref svc) = linked_service
        && !crate::handlers::status::oh_dear::SUPPORTED_SERVICES.contains(&svc.as_str())
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Invalid linked service.",
        ));
    }

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
            show_from = $10,
            starts_at = $11,
            ends_at = $12,
            linked_service = $13,
            linked_post_id = $14,
            group_id = $15,
            updated_by = $16,
            updated_at = NOW()
        WHERE id = $1
        RETURNING
            id, slot, token, network, is_active, severity,
            user_message, scenario, internal_note,
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id,
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
    .bind(show_from)
    .bind(starts_at)
    .bind(ends_at)
    .bind(&linked_service)
    .bind(&linked_post_id)
    .bind(&group_id)
    .bind(&admin.username)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to update warning {}: {}", id, e);
        if let sqlx::Error::Database(db_err) = &e
            && db_err.constraint().is_some()
        {
            return AdminError::new(
                StatusCode::CONFLICT,
                "A warning with the same slot, token, and network combination already exists.",
            );
        }
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update warning. Please try again.",
        )
    })?;

    let action = determine_update_action(
        &previous,
        updated.is_active,
        &updated.show_from,
        &updated.ends_at,
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
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id,
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

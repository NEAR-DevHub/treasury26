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

use crate::{
    AppState,
    handlers::status::notifications::{
        self, MessageTrigger, WarningEvent, WarningEventAction, WarningPreview, WarningSchedule,
    },
    handlers::warnings::{
        db::{self, AuditAction},
        templates,
    },
    utils::admin_auth,
};

const BASIC_AUTH_REALM: &str = "Trezu Status Manager";

const ADMIN_WARNING_COLUMNS: &str = r#"
    id, slot, token, network, is_active, response, severity,
    user_message, use_custom_message, situation, internal_note,
    show_from, starts_at, ends_at,
    linked_service, linked_post_id, group_id,
    updated_by, updated_at, created_at
"#;

pub struct AdminError {
    status: StatusCode,
    message: String,
    headers: Option<Box<HeaderMap>>,
    /// Extra JSON fields merged into the error body (e.g. `existingId` on conflict).
    extra: Option<Value>,
}

impl AdminError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            headers: None,
            extra: None,
        }
    }

    fn with_headers(status: StatusCode, message: impl Into<String>, headers: HeaderMap) -> Self {
        Self {
            status,
            message: message.into(),
            headers: Some(Box::new(headers)),
            extra: None,
        }
    }

    fn conflict_existing(existing_id: i32) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: "A warning with the same slot, token, and network combination already exists. Edit the existing one instead, or delete it first.".to_string(),
            headers: None,
            extra: Some(json!({ "existingId": existing_id })),
        }
    }
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.message });
        if let Some(Value::Object(extra)) = self.extra
            && let Some(obj) = body.as_object_mut()
        {
            obj.extend(extra);
        }
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

    if state.env_vars.admin_users.is_empty() {
        return Err(AdminError::with_headers(
            StatusCode::UNAUTHORIZED,
            "Admin access is not configured.",
            unauthorized_headers,
        ));
    }

    let Some(configured_username) =
        admin_auth::authenticate_admin(&state.env_vars.admin_users, username, password)
    else {
        return Err(AdminError::with_headers(
            StatusCode::UNAUTHORIZED,
            "Incorrect username or password.",
            unauthorized_headers,
        ));
    };

    Ok(AdminUser {
        username: configured_username,
    })
}

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdminWarning {
    pub id: i32,
    pub slot: Option<String>,
    pub token: Option<String>,
    pub network: Option<String>,
    pub is_active: bool,
    pub response: String,
    pub severity: String,
    pub user_message: Option<String>,
    pub use_custom_message: bool,
    pub situation: Option<String>,
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
pub struct WarningRequest {
    pub slot: Option<String>,
    pub token: Option<String>,
    pub network: Option<String>,
    pub is_active: Option<bool>,
    pub response: Option<String>,
    pub severity: Option<String>,
    pub user_message: Option<String>,
    pub use_custom_message: Option<bool>,
    pub situation: Option<String>,
    pub internal_note: Option<String>,
    /// ISO-8601 timestamp, or empty string when unset / cleared.
    pub show_from: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub linked_service: Option<String>,
    pub linked_post_id: Option<String>,
    pub group_id: Option<String>,
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

fn parse_optional_utc(value: Option<String>) -> Option<DateTime<Utc>> {
    empty_to_none(value).and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(&s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    })
}

fn validate_response(response: &str) -> Result<(), (StatusCode, String)> {
    match response {
        "notice" | "paused" => Ok(()),
        _ => Err((
            StatusCode::BAD_REQUEST,
            "response must be one of: notice, paused".to_string(),
        )),
    }
}

fn validate_severity(severity: &str) -> Result<(), (StatusCode, String)> {
    match severity {
        "low" | "high" | "critical" => Ok(()),
        _ => Err((
            StatusCode::BAD_REQUEST,
            "severity must be one of: low, high, critical".to_string(),
        )),
    }
}

async fn insert_audit_log_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    warning_id: Option<i32>,
    action: AuditAction,
    changed_by: &str,
    changes: Value,
) -> Result<(), (StatusCode, String)> {
    db::insert_audit_log(&mut **tx, warning_id, action, changed_by, changes)
        .await
        .map_err(|e| {
            tracing::error!("Failed to insert audit log: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to write audit log: {}", e),
            )
        })
}

fn warning_is_upcoming(show_from: &Option<DateTime<Utc>>) -> bool {
    show_from.is_some_and(|sf| sf > Utc::now())
}

fn warning_is_publicly_visible(
    is_active: bool,
    show_from: &Option<DateTime<Utc>>,
    ends_at: &Option<DateTime<Utc>>,
) -> bool {
    let now = Utc::now();
    if ends_at.is_some_and(|e| e <= now) {
        return false;
    }
    if is_active {
        return true;
    }
    show_from.is_some_and(|sf| sf <= now)
}

fn warning_should_be_deleted(
    is_active: bool,
    show_from: &Option<DateTime<Utc>>,
    ends_at: &Option<DateTime<Utc>>,
) -> bool {
    !warning_is_publicly_visible(is_active, show_from, ends_at) && !warning_is_upcoming(show_from)
}

fn determine_update_action(
    old: &AdminWarning,
    new_is_active: bool,
    show_from: &Option<DateTime<Utc>>,
    ends_at: &Option<DateTime<Utc>>,
) -> AuditAction {
    if show_from.is_some() || ends_at.is_some() {
        return AuditAction::Scheduled;
    }

    if old.is_active != new_is_active && new_is_active {
        return AuditAction::Activated;
    }

    AuditAction::Updated
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
    push_change!(response);
    push_change!(severity);
    push_change!(user_message);
    push_change!(use_custom_message);
    push_change!(situation);
    push_change!(internal_note);
    push_change!(show_from);
    push_change!(starts_at);
    push_change!(ends_at);
    push_change!(linked_service);
    push_change!(linked_post_id);
    push_change!(group_id);

    Value::Object(changes)
}

pub async fn list_warnings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminWarning>>, AdminError> {
    let _admin = require_admin(&headers, &state)?;

    let warnings = sqlx::query_as::<_, AdminWarning>(&format!(
        "SELECT {ADMIN_WARNING_COLUMNS} FROM warning_slots ORDER BY id"
    ))
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
    Json(body): Json<WarningRequest>,
) -> Result<Json<AdminWarning>, AdminError> {
    let admin = require_admin(&headers, &state)?;

    let mut response = body.response.unwrap_or_else(|| "notice".to_string());
    let mut severity = body.severity.unwrap_or_else(|| "high".to_string());
    validate_response(&response).map_err(|(status, msg)| AdminError::new(status, msg))?;
    validate_severity(&severity).map_err(|(status, msg)| AdminError::new(status, msg))?;

    let slot = empty_to_none(body.slot);
    let token = empty_to_none(body.token);
    let network = empty_to_none(body.network);
    let situation = empty_to_none(body.situation);

    if let Some(implied) = situation.as_deref().and_then(templates::situation_response) {
        response = implied.to_string();
    }
    if let Some(implied) = situation.as_deref().and_then(templates::situation_severity) {
        severity = implied.to_string();
    }
    if slot.as_deref() == Some("login")
        || slot
            .as_deref()
            .is_some_and(|s| s.starts_with("login.wallet."))
        || slot.as_deref() == Some("treasury-creation")
    {
        response = "paused".to_string();
    }

    let generated = templates::generate_messages(
        &response,
        &severity,
        slot.as_deref(),
        token.as_deref(),
        network.as_deref(),
        situation.as_deref(),
    );

    let user_message = empty_to_none(body.user_message).or_else(|| generated.clone());
    let user_message = user_message.unwrap_or_default();
    let use_custom_message = body.use_custom_message.unwrap_or(false);
    // Treasury-creation replaces the form with the waitlist; login messages are
    // auto-generated from the catalog — skip the requirement for both.
    let skip_message_check = matches!(slot.as_deref(), Some("treasury-creation") | Some("login"))
        || slot
            .as_deref()
            .is_some_and(|s| s.starts_with("login.wallet."));
    if user_message.trim().is_empty() && !skip_message_check {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "User-facing message is required.",
        ));
    }

    let is_active = body.is_active.unwrap_or(false);
    let show_from = parse_optional_utc(body.show_from);
    let starts_at = parse_optional_utc(body.starts_at);
    let ends_at = parse_optional_utc(body.ends_at);
    if !is_active && show_from.is_none() {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Either mark the warning as active or set a show-from time.",
        ));
    }
    if let (Some(start), Some(end)) = (starts_at, ends_at)
        && end <= start
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "End time must be after the start time.",
        ));
    }
    if let (Some(show), Some(start)) = (show_from, starts_at)
        && start < show
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Event start must be on or after the show-from time.",
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

    let mut tx = state.db_pool.begin().await.map_err(|_| {
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create warning.",
        )
    })?;

    if let Some(existing_id) =
        db::find_conflicting_warning_id(&mut *tx, None, &slot, &token, &network)
            .await
            .map_err(|_| {
                AdminError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to create warning.",
                )
            })?
    {
        return Err(AdminError::conflict_existing(existing_id));
    }

    let warning = sqlx::query_as::<_, AdminWarning>(&format!(
        r#"
        INSERT INTO warning_slots (
            slot, token, network, is_active, response, severity,
            user_message, use_custom_message, situation, internal_note,
            show_from, starts_at, ends_at,
            linked_service, linked_post_id, group_id, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING {ADMIN_WARNING_COLUMNS}
        "#
    ))
    .bind(&slot)
    .bind(&token)
    .bind(&network)
    .bind(is_active)
    .bind(&response)
    .bind(&severity)
    .bind(&user_message)
    .bind(use_custom_message)
    .bind(&situation)
    .bind(empty_to_none(body.internal_note))
    .bind(show_from)
    .bind(starts_at)
    .bind(ends_at)
    .bind(&linked_service)
    .bind(&linked_post_id)
    .bind(&group_id)
    .bind(&admin.username)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!("Failed to create warning: {}", e);
        if let sqlx::Error::Database(db_err) = &e
            && db_err.constraint().is_some()
        {
            return AdminError::new(
                StatusCode::CONFLICT,
                "A warning with the same slot, token, and network combination already exists. Edit the existing one instead, or delete it first.",
            );
        }
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create warning. Please try again.",
        )
    })?;

    let action = if show_from.is_some() || ends_at.is_some() {
        AuditAction::Scheduled
    } else if is_active {
        AuditAction::Activated
    } else {
        AuditAction::Created
    };

    insert_audit_log_in_tx(
        &mut tx,
        Some(warning.id),
        action,
        &admin.username,
        json!({
            "slot": warning.slot,
            "token": warning.token,
            "network": warning.network,
            "is_active": warning.is_active,
            "response": warning.response,
            "severity": warning.severity,
            "user_message": warning.user_message,
            "use_custom_message": warning.use_custom_message,
            "situation": warning.situation,
            "internal_note": warning.internal_note,
            "show_from": warning.show_from,
            "starts_at": warning.starts_at,
            "ends_at": warning.ends_at,
            "linked_service": warning.linked_service,
            "linked_post_id": warning.linked_post_id,
            "group_id": warning.group_id,
        }),
    )
    .await
    .map_err(|(status, msg)| AdminError::new(status, msg))?;

    tx.commit().await.map_err(|_| {
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create warning.",
        )
    })?;

    db::invalidate_warnings_cache(&state).await;

    notifications::notify_warning_event(
        &state,
        WarningEvent {
            action: notifications::event_action_from_audit(action),
            source: MessageTrigger::manual(admin.username.clone()),
            preview: WarningPreview::from_message(
                warning.slot.as_deref(),
                &warning.response,
                &warning.severity,
                warning.user_message.as_deref(),
            ),
            token: warning.token.clone(),
            network: warning.network.clone(),
            schedule: WarningSchedule {
                show_from: warning.show_from,
                starts_at: warning.starts_at,
                ends_at: warning.ends_at,
            },
        },
    )
    .await;

    Ok(Json(warning))
}

pub async fn update_warning(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(body): Json<WarningRequest>,
) -> Result<Response, AdminError> {
    let admin = require_admin(&headers, &state)?;

    let existing = sqlx::query_as::<_, AdminWarning>(&format!(
        "SELECT {ADMIN_WARNING_COLUMNS} FROM warning_slots WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|_| AdminError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load warning."))?
    .ok_or(AdminError::new(
        StatusCode::NOT_FOUND,
        "Warning not found — it may have been deleted by someone else. Try refreshing.",
    ))?;

    let previous = existing.clone();

    if let Some(ref response) = body.response {
        validate_response(response).map_err(|(status, msg)| AdminError::new(status, msg))?;
    }
    if let Some(ref severity) = body.severity {
        validate_severity(severity).map_err(|(status, msg)| AdminError::new(status, msg))?;
    }

    let slot = empty_to_none(body.slot).or(existing.slot.clone());
    let token = empty_to_none(body.token);
    let network = empty_to_none(body.network);
    let is_active = body.is_active.unwrap_or(existing.is_active);
    let situation = empty_to_none(body.situation);
    let mut response = body.response.unwrap_or(existing.response);
    let mut severity = body.severity.unwrap_or(existing.severity);
    if let Some(implied) = situation.as_deref().and_then(templates::situation_response) {
        response = implied.to_string();
    }
    if let Some(implied) = situation.as_deref().and_then(templates::situation_severity) {
        severity = implied.to_string();
    }
    if slot.as_deref() == Some("login")
        || slot
            .as_deref()
            .is_some_and(|s| s.starts_with("login.wallet."))
        || slot.as_deref() == Some("treasury-creation")
    {
        response = "paused".to_string();
    }

    let generated = templates::generate_messages(
        &response,
        &severity,
        slot.as_deref(),
        token.as_deref(),
        network.as_deref(),
        situation.as_deref(),
    );

    let user_message = empty_to_none(body.user_message).or(generated);
    let use_custom_message = body
        .use_custom_message
        .unwrap_or(existing.use_custom_message);
    let internal_note = empty_to_none(body.internal_note);
    let show_from = parse_optional_utc(body.show_from);
    let starts_at = parse_optional_utc(body.starts_at);
    let ends_at = parse_optional_utc(body.ends_at);
    if !is_active && show_from.is_none() {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Either mark the warning as active or set a show-from time.",
        ));
    }
    if let (Some(start), Some(end)) = (starts_at, ends_at)
        && end <= start
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "End time must be after the start time.",
        ));
    }
    if let (Some(show), Some(start)) = (show_from, starts_at)
        && start < show
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Event start must be on or after the show-from time.",
        ));
    }
    let linked_service = empty_to_none(body.linked_service);
    let mut linked_post_id = empty_to_none(body.linked_post_id);
    if linked_service.is_none() {
        linked_post_id = None;
    }
    let group_id = empty_to_none(body.group_id);

    if let Some(ref svc) = linked_service
        && !crate::handlers::status::oh_dear::SUPPORTED_SERVICES.contains(&svc.as_str())
    {
        return Err(AdminError::new(
            StatusCode::BAD_REQUEST,
            "Invalid linked service.",
        ));
    }

    if warning_should_be_deleted(is_active, &show_from, &ends_at) {
        let mut extra = json!({ "source": "admin_update" });
        if let Some(ref gid) = existing.group_id {
            extra["group_id"] = json!(gid);
        }
        let changes = db::audit_delete_changes(
            existing.id,
            slot.clone(),
            token.clone(),
            network.clone(),
            extra,
        );
        db::delete_warning_with_audit(&state.db_pool, id, &admin.username, changes)
            .await
            .map_err(|_| {
                AdminError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to delete warning.",
                )
            })?;
        db::invalidate_warnings_cache(&state).await;

        notifications::notify_warning_event(
            &state,
            WarningEvent {
                action: WarningEventAction::Removed,
                source: MessageTrigger::manual(admin.username.clone()),
                preview: WarningPreview::from_message(
                    slot.as_deref(),
                    &response,
                    &severity,
                    user_message.as_deref(),
                ),
                token: token.clone(),
                network: network.clone(),
                schedule: WarningSchedule::default(),
            },
        )
        .await;

        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let mut tx = state.db_pool.begin().await.map_err(|_| {
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update warning.",
        )
    })?;

    if let Some(existing_id) =
        db::find_conflicting_warning_id(&mut *tx, Some(id), &slot, &token, &network)
            .await
            .map_err(|_| {
                AdminError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to update warning.",
                )
            })?
    {
        return Err(AdminError::conflict_existing(existing_id));
    }

    let updated = sqlx::query_as::<_, AdminWarning>(&format!(
        r#"
        UPDATE warning_slots
        SET
            slot = $2,
            token = $3,
            network = $4,
            is_active = $5,
            response = $6,
            severity = $7,
            user_message = $8,
            use_custom_message = $9,
            situation = $10,
            internal_note = $11,
            show_from = $12,
            starts_at = $13,
            ends_at = $14,
            linked_service = $15,
            linked_post_id = $16,
            group_id = $17,
            updated_by = $18,
            updated_at = NOW()
        WHERE id = $1
        RETURNING {ADMIN_WARNING_COLUMNS}
        "#
    ))
    .bind(id)
    .bind(&slot)
    .bind(&token)
    .bind(&network)
    .bind(is_active)
    .bind(&response)
    .bind(&severity)
    .bind(&user_message)
    .bind(use_custom_message)
    .bind(&situation)
    .bind(&internal_note)
    .bind(show_from)
    .bind(starts_at)
    .bind(ends_at)
    .bind(&linked_service)
    .bind(&linked_post_id)
    .bind(&group_id)
    .bind(&admin.username)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!("Failed to update warning {}: {}", id, e);
        if let sqlx::Error::Database(db_err) = &e
            && db_err.constraint().is_some()
        {
            return AdminError::new(
                StatusCode::CONFLICT,
                "A warning with the same slot, token, and network combination already exists. Edit the existing one instead, or delete it first.",
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
    let mut changes = build_changes(&previous, &updated);
    // Always stamp group_id so the admin audit UI can collapse grouped saves.
    if let Some(obj) = changes.as_object_mut()
        && let Some(ref gid) = updated.group_id
    {
        obj.entry("group_id".to_string())
            .or_insert_with(|| json!(gid));
    }
    let has_field_changes = changes
        .as_object()
        .is_some_and(|m| m.keys().any(|k| k != "group_id"));

    if has_field_changes {
        insert_audit_log_in_tx(&mut tx, Some(id), action, &admin.username, changes)
            .await
            .map_err(|(status, msg)| AdminError::new(status, msg))?;
    }

    tx.commit().await.map_err(|_| {
        AdminError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update warning.",
        )
    })?;

    db::invalidate_warnings_cache(&state).await;

    // Only alert when the edit actually changed something.
    if has_field_changes {
        notifications::notify_warning_event(
            &state,
            WarningEvent {
                action: notifications::event_action_from_audit(action),
                source: MessageTrigger::manual(admin.username.clone()),
                preview: WarningPreview::from_message(
                    updated.slot.as_deref(),
                    &updated.response,
                    &updated.severity,
                    updated.user_message.as_deref(),
                ),
                token: updated.token.clone(),
                network: updated.network.clone(),
                schedule: WarningSchedule {
                    show_from: updated.show_from,
                    starts_at: updated.starts_at,
                    ends_at: updated.ends_at,
                },
            },
        )
        .await;
    }

    Ok(Json(updated).into_response())
}

pub async fn delete_warning(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<StatusCode, AdminError> {
    let admin = require_admin(&headers, &state)?;

    let existing = sqlx::query_as::<_, AdminWarning>(&format!(
        "SELECT {ADMIN_WARNING_COLUMNS} FROM warning_slots WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|_| AdminError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load warning."))?;

    // Idempotent: already-deleted ids succeed so duplicate clicks don't error.
    let Some(existing) = existing else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let mut extra = json!({});
    if let Some(ref gid) = existing.group_id {
        extra["group_id"] = json!(gid);
    }
    let changes = db::audit_delete_changes(
        existing.id,
        existing.slot.clone(),
        existing.token.clone(),
        existing.network.clone(),
        extra,
    );
    db::delete_warning_with_audit(&state.db_pool, id, &admin.username, changes)
        .await
        .map_err(|_| {
            AdminError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete warning. Please try again.",
            )
        })?;

    db::invalidate_warnings_cache(&state).await;

    notifications::notify_warning_event(
        &state,
        WarningEvent {
            action: WarningEventAction::Removed,
            source: MessageTrigger::manual(admin.username.clone()),
            preview: WarningPreview::from_message(
                existing.slot.as_deref(),
                &existing.response,
                &existing.severity,
                existing.user_message.as_deref(),
            ),
            token: existing.token.clone(),
            network: existing.network.clone(),
            schedule: WarningSchedule {
                show_from: existing.show_from,
                starts_at: existing.starts_at,
                ends_at: existing.ends_at,
            },
        },
    )
    .await;

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

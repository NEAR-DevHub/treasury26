use crate::{AppState, routes::create_routes, utils::test_utils::build_test_state};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state(pool: PgPool) -> Arc<AppState> {
    Arc::new(build_test_state(pool))
}

fn basic_auth_header(username: &str, password: &str) -> String {
    let encoded = STANDARD.encode(format!("{username}:{password}"));
    format!("Basic {encoded}")
}

fn primary_admin_auth(state: &AppState) -> String {
    let admin = state
        .env_vars
        .admin_users
        .first()
        .expect("At least one admin user should be configured in tests");
    basic_auth_header(&admin.username, &admin.password)
}

fn field_is_cleared(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null())
}

async fn response_json(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("Should read response body");
    serde_json::from_slice(&body)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&body) }))
}

#[sqlx::test]
async fn test_public_warnings_returns_only_active_and_scheduled(pool: PgPool) {
    let state = test_state(pool.clone());
    let app = create_routes(state);

    sqlx::query("DELETE FROM warning_slots")
        .execute(&pool)
        .await
        .expect("Should clear warnings");

    sqlx::query(
        r#"
        INSERT INTO warning_slots (slot, is_active, response, severity, user_message)
        VALUES ('app', true, 'notice', 'high', 'App is degraded')
        "#,
    )
    .execute(&pool)
    .await
    .expect("Should insert active app warning");

    sqlx::query(
        r#"
        INSERT INTO warning_slots (slot, is_active, response, severity, user_message, show_from, ends_at)
        VALUES (
            'exchange',
            false,
            'notice',
            'high',
            'Exchange maintenance',
            NOW() - INTERVAL '1 hour',
            NOW() + INTERVAL '1 hour'
        )
        "#,
    )
    .execute(&pool)
    .await
    .expect("Should insert scheduled exchange warning");

    sqlx::query(
        r#"
        INSERT INTO warning_slots (slot, is_active, response, severity, user_message, ends_at)
        VALUES ('deposit', true, 'paused', 'high', 'Expired warning', NOW() - INTERVAL '1 minute')
        "#,
    )
    .execute(&pool)
    .await
    .expect("Should insert expired deposit warning");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/warnings")
                .body(Body::empty())
                .expect("Should build request"),
        )
        .await
        .expect("Request should complete");

    assert_eq!(response.status(), StatusCode::OK);

    let body = response_json(response).await;
    let warnings = body
        .get("warnings")
        .and_then(Value::as_array)
        .expect("Response should include warnings array");

    let slots: Vec<&str> = warnings
        .iter()
        .filter_map(|w| w.get("slot").and_then(Value::as_str))
        .collect();

    assert!(
        slots.contains(&"app"),
        "Active app warning should be returned"
    );
    assert!(
        slots.contains(&"exchange"),
        "Scheduled exchange warning should be returned"
    );
    assert!(
        !slots.contains(&"deposit"),
        "Expired deposit warning should not be returned"
    );
}

#[sqlx::test]
async fn test_admin_endpoints_require_basic_auth(pool: PgPool) {
    let state = test_state(pool);
    let app = create_routes(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/internal/api/warnings")
                .body(Body::empty())
                .expect("Should build request"),
        )
        .await
        .expect("Request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        response.headers().get(header::WWW_AUTHENTICATE).is_some(),
        "Unauthorized admin response should include WWW-Authenticate"
    );
}

#[sqlx::test]
async fn test_admin_warning_crud_and_audit_log(pool: PgPool) {
    let state = test_state(pool.clone());
    let app = create_routes(state.clone());
    let auth = primary_admin_auth(&state);

    let create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "slot": "payments",
                        "isActive": true,
                        "response": "paused",
                        "severity": "high",
                        "userMessage": "Payments unavailable"
                    })
                    .to_string(),
                ))
                .expect("Should build create request"),
        )
        .await
        .expect("Create request should complete");

    assert_eq!(create_response.status(), StatusCode::OK);
    let created = response_json(create_response).await;
    let warning_id = created
        .get("id")
        .and_then(Value::as_i64)
        .expect("Created warning should have id");

    let list_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .body(Body::empty())
                .expect("Should build list request"),
        )
        .await
        .expect("List request should complete");

    assert_eq!(list_response.status(), StatusCode::OK);
    let listed = response_json(list_response).await;
    let listed = listed.as_array().expect("List response should be array");
    assert!(
        listed
            .iter()
            .any(|w| w.get("id").and_then(Value::as_i64) == Some(warning_id)),
        "Created warning should appear in admin list"
    );

    let audit_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/internal/api/audit-log?limit=10")
                .header(header::AUTHORIZATION, &auth)
                .body(Body::empty())
                .expect("Should build audit request"),
        )
        .await
        .expect("Audit request should complete");

    assert_eq!(audit_response.status(), StatusCode::OK);
    let audit = response_json(audit_response).await;
    let entries = audit
        .get("entries")
        .and_then(Value::as_array)
        .expect("Audit response should include entries");
    assert!(
        !entries.is_empty(),
        "Creating a warning should write an audit log entry"
    );

    let delete_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/internal/api/warnings/{warning_id}"))
                .header(header::AUTHORIZATION, &auth)
                .body(Body::empty())
                .expect("Should build delete request"),
        )
        .await
        .expect("Delete request should complete");

    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
}

#[sqlx::test]
async fn test_admin_update_clears_nullable_fields(pool: PgPool) {
    let state = test_state(pool.clone());
    let app = create_routes(state.clone());
    let auth = primary_admin_auth(&state);

    let create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "slot": "app",
                        "isActive": true,
                        "response": "notice",
                        "severity": "high",
                        "userMessage": "Temporary issue",
                        "linkedService": "near-rpc",
                        "linkedPostId": "post-123",
                        "situation": "backend_down",
                        "internalNote": "ops note",
                    })
                    .to_string(),
                ))
                .expect("Should build create request"),
        )
        .await
        .expect("Create request should complete");

    assert_eq!(create_response.status(), StatusCode::OK);
    let created = response_json(create_response).await;
    let warning_id = created
        .get("id")
        .and_then(Value::as_i64)
        .expect("Created warning should have id");

    let update_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/internal/api/warnings/{warning_id}"))
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "slot": "app",
                        "isActive": true,
                        "response": "notice",
                        "severity": "high",
                        "userMessage": "Temporary issue",
                        "linkedService": "",
                        "linkedPostId": "",
                        "situation": "",
                        "internalNote": "",
                    })
                    .to_string(),
                ))
                .expect("Should build update request"),
        )
        .await
        .expect("Update request should complete");

    assert_eq!(update_response.status(), StatusCode::OK);
    let updated = response_json(update_response).await;
    assert!(field_is_cleared(updated.get("linkedService")));
    assert!(field_is_cleared(updated.get("linkedPostId")));
    assert!(field_is_cleared(updated.get("situation")));
    assert!(field_is_cleared(updated.get("internalNote")));
}

#[sqlx::test]
async fn test_multiple_admin_users_are_recorded_in_audit_log(pool: PgPool) {
    let state = test_state(pool.clone());
    let app = create_routes(state.clone());

    let second_admin = state
        .env_vars
        .admin_users
        .get(1)
        .expect("Second admin user should be configured in .env.test");

    let auth = basic_auth_header(&second_admin.username, &second_admin.password);

    let create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "slot": "payments",
                        "isActive": true,
                        "response": "notice",
                        "severity": "high",
                        "userMessage": "Created by second admin"
                    })
                    .to_string(),
                ))
                .expect("Should build create request"),
        )
        .await
        .expect("Create request should complete");

    assert_eq!(create_response.status(), StatusCode::OK);

    let audit_response = app
        .oneshot(
            Request::builder()
                .uri("/internal/api/audit-log?limit=5")
                .header(header::AUTHORIZATION, &auth)
                .body(Body::empty())
                .expect("Should build audit request"),
        )
        .await
        .expect("Audit request should complete");

    assert_eq!(audit_response.status(), StatusCode::OK);
    let audit = response_json(audit_response).await;
    let entries = audit
        .get("entries")
        .and_then(Value::as_array)
        .expect("Audit response should include entries");

    assert!(
        entries.iter().any(|entry| {
            entry.get("changedBy").and_then(Value::as_str) == Some(second_admin.username.as_str())
        }),
        "Audit log should record the authenticated admin username"
    );
}

#[sqlx::test]
async fn test_create_warning_rejects_duplicate_slot_without_overwrite(pool: PgPool) {
    let state = test_state(pool.clone());
    let app = create_routes(state.clone());
    let auth = primary_admin_auth(&state);

    sqlx::query("DELETE FROM warning_slots")
        .execute(&pool)
        .await
        .expect("Should clear warnings");

    let create_body = json!({
        "slot": "login",
        "isActive": true,
        "response": "paused",
        "severity": "high",
        "situation": "wallet_login_unavailable",
        "userMessage": "### Original\nFirst warning",
        "useCustomMessage": true,
    })
    .to_string();

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(create_body.clone()))
                .expect("Should build first create request"),
        )
        .await
        .expect("First create should complete");
    assert_eq!(first.status(), StatusCode::OK);
    let created = response_json(first).await;
    let existing_id = created
        .get("id")
        .and_then(Value::as_i64)
        .expect("Created warning should have id");

    let second = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "slot": "login",
                        "isActive": true,
                        "response": "paused",
                        "severity": "high",
                        "situation": "wallet_login_unavailable",
                        "userMessage": "### Replacement\nShould not overwrite",
                        "useCustomMessage": true,
                    })
                    .to_string(),
                ))
                .expect("Should build duplicate create request"),
        )
        .await
        .expect("Duplicate create should complete");

    assert_eq!(second.status(), StatusCode::CONFLICT);
    let conflict = response_json(second).await;
    assert_eq!(
        conflict.get("existingId").and_then(Value::as_i64),
        Some(existing_id)
    );

    let remaining: Vec<(Option<String>, bool)> = sqlx::query_as(
        r#"
        SELECT user_message, use_custom_message
        FROM warning_slots
        WHERE COALESCE(slot, '') = 'login'
        "#,
    )
    .fetch_all(&pool)
    .await
    .expect("Should load remaining login warnings");

    assert_eq!(
        remaining.len(),
        1,
        "Duplicate create must not insert a second row"
    );
    assert_eq!(
        remaining[0].0.as_deref(),
        Some("### Original\nFirst warning"),
        "Original custom message must be preserved"
    );
    assert!(remaining[0].1, "use_custom_message must stay true");
}

#[sqlx::test]
async fn test_delete_warning_is_idempotent(pool: PgPool) {
    let state = test_state(pool.clone());
    let app = create_routes(state.clone());
    let auth = primary_admin_auth(&state);

    sqlx::query("DELETE FROM warning_slots")
        .execute(&pool)
        .await
        .expect("Should clear warnings");

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/api/warnings")
                .header(header::AUTHORIZATION, &auth)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "slot": "exchange",
                        "isActive": true,
                        "response": "notice",
                        "severity": "high",
                        "userMessage": "Exchange issue",
                    })
                    .to_string(),
                ))
                .expect("Should build create request"),
        )
        .await
        .expect("Create should complete");
    assert_eq!(create.status(), StatusCode::OK);
    let created = response_json(create).await;
    let warning_id = created
        .get("id")
        .and_then(Value::as_i64)
        .expect("Created warning should have id");

    let first_delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/internal/api/warnings/{warning_id}"))
                .header(header::AUTHORIZATION, &auth)
                .body(Body::empty())
                .expect("Should build first delete"),
        )
        .await
        .expect("First delete should complete");
    assert_eq!(first_delete.status(), StatusCode::NO_CONTENT);

    let second_delete = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/internal/api/warnings/{warning_id}"))
                .header(header::AUTHORIZATION, &auth)
                .body(Body::empty())
                .expect("Should build second delete"),
        )
        .await
        .expect("Second delete should complete");
    assert_eq!(
        second_delete.status(),
        StatusCode::NO_CONTENT,
        "Deleting an already-removed warning should succeed"
    );
}

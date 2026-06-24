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

    sqlx::query("UPDATE warning_slots SET is_active = false, show_from = NULL, ends_at = NULL")
        .execute(&pool)
        .await
        .expect("Should reset warnings");

    sqlx::query(
        r#"
        UPDATE warning_slots
        SET is_active = true, user_message = 'App is degraded'
        WHERE slot = 'app'
        "#,
    )
    .execute(&pool)
    .await
    .expect("Should activate app warning");

    sqlx::query(
        r#"
        UPDATE warning_slots
        SET is_active = false,
            show_from = NOW() - INTERVAL '1 hour',
            ends_at = NOW() + INTERVAL '1 hour',
            user_message = 'Exchange maintenance'
        WHERE slot = 'exchange'
        "#,
    )
    .execute(&pool)
    .await
    .expect("Should schedule exchange warning");

    sqlx::query(
        r#"
        UPDATE warning_slots
        SET is_active = true,
            ends_at = NOW() - INTERVAL '1 minute',
            user_message = 'Expired warning'
        WHERE slot = 'deposit'
        "#,
    )
    .execute(&pool)
    .await
    .expect("Should expire deposit warning");

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
    let auth = basic_auth_header(
        state
            .env_vars
            .admin_username
            .as_deref()
            .expect("ADMIN_USERNAME"),
        state
            .env_vars
            .admin_password
            .as_deref()
            .expect("ADMIN_PASSWORD"),
    );

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
                        "severity": "critical",
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
    let auth = basic_auth_header(
        state
            .env_vars
            .admin_username
            .as_deref()
            .expect("ADMIN_USERNAME"),
        state
            .env_vars
            .admin_password
            .as_deref()
            .expect("ADMIN_PASSWORD"),
    );

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
                        "severity": "warning",
                        "userMessage": "Temporary issue",
                        "linkedService": "near-rpc",
                        "linkedPostId": "post-123",
                        "scenario": "tier1_backend",
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
                        "severity": "warning",
                        "userMessage": "Temporary issue",
                        "linkedService": "",
                        "linkedPostId": "",
                        "scenario": "",
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
    assert!(updated.get("linkedService").is_none());
    assert!(updated.get("linkedPostId").is_none());
    assert!(updated.get("scenario").is_none());
    assert!(updated.get("internalNote").is_none());
}

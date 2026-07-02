use axum::{
    Json,
    extract::{Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAddressBookQuery {
    pub dao_id: AccountId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAddressBookEntryRequest {
    pub name: String,
    pub networks: Vec<String>,
    pub address: String,
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAddressBookRequest {
    pub dao_id: AccountId,
    pub entries: Vec<CreateAddressBookEntryRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntry {
    pub id: Uuid,
    pub dao_id: AccountId,
    pub name: String,
    pub networks: Vec<String>,
    pub address: String,
    pub note: Option<String>,
    pub created_by: Option<AccountId>,
    pub created_at: DateTime<Utc>,
}

/// Row returned by the fetch queries (list + export) with joined wallet.
struct AddressBookRow {
    id: Uuid,
    dao_id: String,
    name: String,
    networks: Vec<String>,
    address: String,
    note: Option<String>,
    created_by_wallet: Option<String>,
    created_at: DateTime<Utc>,
}

impl TryFrom<AddressBookRow> for AddressBookEntry {
    type Error = near_account_id::ParseAccountError;

    fn try_from(r: AddressBookRow) -> Result<Self, Self::Error> {
        Ok(AddressBookEntry {
            id: r.id,
            dao_id: r.dao_id.parse()?,
            name: r.name,
            networks: r.networks,
            address: r.address,
            note: r.note,
            created_by: r.created_by_wallet.map(|s| s.parse()).transpose()?,
            created_at: r.created_at,
        })
    }
}

/// Row returned by INSERT RETURNING (no wallet join needed).
#[derive(sqlx::FromRow)]
struct InsertedAddressBookRow {
    id: Uuid,
    dao_id: String,
    name: String,
    networks: Vec<String>,
    address: String,
    note: Option<String>,
    created_at: DateTime<Utc>,
}

pub async fn list_address_book(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Query(params): Query<ListAddressBookQuery>,
) -> Result<Json<Vec<AddressBookEntry>>, (StatusCode, String)> {
    auth_user
        .verify_dao_member(&state.db_pool, &params.dao_id)
        .await
        .map_err(|_| (StatusCode::FORBIDDEN, "Not a DAO policy member".to_string()))?;

    let entries: Vec<AddressBookEntry> = sqlx::query_as!(
        AddressBookRow,
        r#"
        SELECT ab.id, ab.dao_id, ab.name, ab.networks, ab.address, ab.note, ab.created_at,
               u.account_id AS "created_by_wallet?"
        FROM address_book ab
        LEFT JOIN users u ON u.id = ab.created_by
        WHERE ab.dao_id = $1
        ORDER BY ab.created_at DESC
        "#,
        params.dao_id.as_str()
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to list address book for {}: {}", params.dao_id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch address book".to_string(),
        )
    })?
    .into_iter()
    .map(AddressBookEntry::try_from)
    .collect::<Result<_, _>>()
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid account in address book: {}", e),
        )
    })?;

    Ok(Json(entries))
}

pub async fn create_address_book_entries(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(req): Json<CreateAddressBookRequest>,
) -> Result<Json<Vec<AddressBookEntry>>, (StatusCode, String)> {
    if req.entries.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "entries must not be empty".to_string(),
        ));
    }

    auth_user
        .verify_dao_member(&state.db_pool, &req.dao_id)
        .await
        .map_err(|_| (StatusCode::FORBIDDEN, "Not a DAO policy member".to_string()))?;

    let user_id = sqlx::query_scalar!(
        "SELECT id FROM users WHERE account_id = $1",
        auth_user.account_id.as_str()
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to look up user {}: {}", auth_user.account_id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to look up user".to_string(),
        )
    })?;

    let entries_json = serde_json::to_value(
        req.entries
            .iter()
            .map(|e| {
                serde_json::json!({
                    "name": e.name,
                    "networks": e.networks,
                    "address": e.address,
                    "note": e.note,
                })
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|e| {
        tracing::error!("Failed to serialize entries: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize entries".to_string(),
        )
    })?;

    let rows = sqlx::query_as::<_, InsertedAddressBookRow>(
        r#"
        INSERT INTO address_book (dao_id, name, networks, address, note, created_by)
        SELECT $1, r.name, r.networks, r.address, r.note, $3
        FROM json_to_recordset($2::json) AS r(name text, networks text[], address text, note text)
        ON CONFLICT (dao_id, address) DO NOTHING
        RETURNING id, dao_id, name, networks, address, note, created_at
        "#,
    )
    .bind(req.dao_id.as_str())
    .bind(sqlx::types::Json(entries_json))
    .bind(user_id)
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to create address book entries: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create address book entries".to_string(),
        )
    })?;

    let created: Vec<AddressBookEntry> =
        rows.into_iter()
            .map(|row| -> Result<AddressBookEntry, (StatusCode, String)> {
                Ok(AddressBookEntry {
                    id: row.id,
                    dao_id: row.dao_id.parse().map_err(
                        |e: near_account_id::ParseAccountError| {
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!("Invalid dao_id in DB: {}", e),
                            )
                        },
                    )?,
                    name: row.name,
                    networks: row.networks,
                    address: row.address,
                    note: row.note,
                    created_by: Some(auth_user.account_id.clone()),
                    created_at: row.created_at,
                })
            })
            .collect::<Result<_, _>>()?;

    Ok(Json(created))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAddressBookQuery {
    pub dao_id: AccountId,
    /// Comma-separated list of UUIDs to export; omit to export all
    pub ids: Option<String>,
}

pub async fn export_address_book(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Query(params): Query<ExportAddressBookQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    auth_user
        .verify_dao_member(&state.db_pool, &params.dao_id)
        .await
        .map_err(|_| (StatusCode::FORBIDDEN, "Not a DAO policy member".to_string()))?;

    let ids: Option<Vec<Uuid>> = params
        .ids
        .as_deref()
        .map(|s| s.split(',').filter_map(|p| p.trim().parse().ok()).collect());

    if let Some(ref v) = ids
        && v.is_empty()
    {
        return Err((StatusCode::BAD_REQUEST, "ids must not be empty".to_string()));
    }

    let rows: Vec<AddressBookRow> = match ids {
        Some(ids) => sqlx::query_as!(
            AddressBookRow,
            r#"
            SELECT ab.id, ab.dao_id, ab.name, ab.networks, ab.address, ab.note, ab.created_at,
                   u.account_id AS "created_by_wallet?"
            FROM address_book ab
            LEFT JOIN users u ON u.id = ab.created_by
            WHERE ab.dao_id = $1 AND ab.id = ANY($2)
            ORDER BY ab.created_at DESC
            "#,
            params.dao_id.as_str(),
            &ids
        )
        .fetch_all(&state.db_pool)
        .await
        .map_err(|e| {
            tracing::error!("Failed to export address book for {}: {}", params.dao_id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to export address book".to_string(),
            )
        })?,
        None => sqlx::query_as!(
            AddressBookRow,
            r#"
            SELECT ab.id, ab.dao_id, ab.name, ab.networks, ab.address, ab.note, ab.created_at,
                   u.account_id AS "created_by_wallet?"
            FROM address_book ab
            LEFT JOIN users u ON u.id = ab.created_by
            WHERE ab.dao_id = $1
            ORDER BY ab.created_at DESC
            "#,
            params.dao_id.as_str()
        )
        .fetch_all(&state.db_pool)
        .await
        .map_err(|e| {
            tracing::error!("Failed to export address book for {}: {}", params.dao_id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to export address book".to_string(),
            )
        })?,
    };

    fn csv_escape(s: &str) -> String {
        if s.contains(',') || s.contains('"') || s.contains('\n') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    }

    let mut csv = String::from("Name,Address,Networks,Note,Created By,Created At\n");
    for row in &rows {
        let networks = row.networks.join("|");
        let note = row.note.as_deref().unwrap_or("");
        let created_by = row.created_by_wallet.as_deref().unwrap_or("");
        csv.push_str(&format!(
            "{},{},{},{},{},{}\n",
            csv_escape(&row.name),
            csv_escape(&row.address),
            csv_escape(&networks),
            csv_escape(note),
            csv_escape(created_by),
            row.created_at.format("%Y-%m-%dT%H:%M:%SZ"),
        ));
    }

    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"address-book.csv\"",
            ),
        ],
        csv,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAddressBookRequest {
    pub ids: Vec<Uuid>,
}

pub async fn delete_address_book_entries(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(req): Json<DeleteAddressBookRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if req.ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "ids must not be empty".to_string()));
    }

    let rows = sqlx::query!(
        "SELECT DISTINCT dao_id FROM address_book WHERE id = ANY($1)",
        &req.ids
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to fetch address book entries: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch address book entries".to_string(),
        )
    })?;

    if rows.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "No matching address book entries found".to_string(),
        ));
    }

    if rows.len() > 1 {
        return Err((
            StatusCode::BAD_REQUEST,
            "All entries must belong to the same DAO".to_string(),
        ));
    }

    let dao_id_str = &rows[0].dao_id;
    let dao_id: AccountId = dao_id_str.parse().map_err(|e| {
        tracing::error!("Invalid dao_id in address_book row '{}': {}", dao_id_str, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid dao_id".to_string(),
        )
    })?;

    auth_user
        .verify_dao_member(&state.db_pool, &dao_id)
        .await
        .map_err(|_| (StatusCode::FORBIDDEN, "Not a DAO policy member".to_string()))?;

    sqlx::query!(
        "DELETE FROM address_book WHERE id = ANY($1) AND dao_id = $2",
        &req.ids,
        dao_id_str,
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to delete address book entries: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to delete address book entries".to_string(),
        )
    })?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use crate::{
        AppState,
        auth::{create_jwt, middleware::AUTH_COOKIE_NAME},
        routes::create_routes,
        utils::test_utils::build_test_state,
    };
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::json;
    use sqlx::PgPool;
    use std::sync::Arc;
    use tower::ServiceExt;
    use uuid::Uuid;

    const DAO_ID: &str = "test-dao.sputnik-dao.near";
    const OTHER_DAO_ID: &str = "other-dao.sputnik-dao.near";
    const USER_ACCOUNT_ID: &str = "member.near";

    fn test_state(pool: PgPool) -> Arc<AppState> {
        Arc::new(build_test_state(pool))
    }

    async fn seed_dao(pool: &PgPool, dao_id: &str) {
        sqlx::query!(
            "INSERT INTO monitored_accounts (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
            dao_id,
        )
        .execute(pool)
        .await
        .expect("Should insert monitored account for test DAO");

        sqlx::query!(
            "INSERT INTO daos (dao_id) VALUES ($1) ON CONFLICT (dao_id) DO NOTHING",
            dao_id,
        )
        .execute(pool)
        .await
        .expect("Should insert DAO record for test DAO");
    }

    async fn seed_policy_member(pool: &PgPool, dao_id: &str, account_id: &str) {
        seed_dao(pool, dao_id).await;

        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ($1, $2, true, false, false)
            ON CONFLICT (dao_id, account_id) DO UPDATE
            SET is_policy_member = EXCLUDED.is_policy_member,
                is_saved = EXCLUDED.is_saved,
                is_hidden = EXCLUDED.is_hidden
            "#,
            dao_id,
            account_id,
        )
        .execute(pool)
        .await
        .expect("Should insert DAO policy member for tests");
    }

    async fn issue_auth_cookie(pool: &PgPool, state: &Arc<AppState>, account_id: &str) -> String {
        let user_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO users (account_id)
            VALUES ($1)
            ON CONFLICT (account_id) DO UPDATE SET updated_at = NOW()
            RETURNING id
            "#,
        )
        .bind(account_id)
        .fetch_one(pool)
        .await
        .expect("Should create or fetch test user");

        let jwt = create_jwt(
            account_id,
            state.env_vars.jwt_secret.as_bytes(),
            state.env_vars.jwt_expiry_hours,
        )
        .expect("Should create JWT for test user");

        sqlx::query!(
            "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
            user_id,
            jwt.token_hash,
            jwt.expires_at,
        )
        .execute(pool)
        .await
        .expect("Should create active session for test user");

        format!("{AUTH_COOKIE_NAME}={}", jwt.token)
    }

    async fn insert_address_book_entry(
        pool: &PgPool,
        dao_id: &str,
        name: &str,
        address: &str,
    ) -> Uuid {
        sqlx::query_scalar(
            r#"
            INSERT INTO address_book (dao_id, name, networks, address, note)
            VALUES ($1, $2, $3, $4, NULL)
            RETURNING id
            "#,
        )
        .bind(dao_id)
        .bind(name)
        .bind(vec!["near".to_string()])
        .bind(address)
        .fetch_one(pool)
        .await
        .expect("Should insert address book entry for tests")
    }

    async fn response_text(response: axum::response::Response) -> String {
        String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("Should read response body")
                .to_vec(),
        )
        .expect("Response body should be valid UTF-8")
    }

    /// An entry whose creator was removed (`created_by` set NULL by the FK's `ON DELETE SET NULL`)
    /// must list without crashing: the `LEFT JOIN users` yields a NULL `created_by_wallet`, which
    /// the query has to decode as `None`. Regression for the missing `?` nullability override (the
    /// same fix this PR applies to proposal_templates; the export queries get the override too).
    #[sqlx::test]
    async fn test_list_tolerates_null_creator(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let auth_cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;
        // insert_address_book_entry leaves created_by NULL — the post-ON-DELETE-SET-NULL state.
        insert_address_book_entry(&pool, DAO_ID, "Orphan", "orphan.near").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/address-book?daoId={DAO_ID}"))
                    .header("cookie", &auth_cookie)
                    .body(Body::empty())
                    .expect("Should build list request"),
            )
            .await
            .expect("List request should complete");

        let status = response.status();
        let body = response_text(response).await;
        assert_eq!(status, StatusCode::OK, "List should succeed. Body: {body}");

        let entries: serde_json::Value =
            serde_json::from_str(&body).expect("List response should be valid JSON");
        let entries = entries
            .as_array()
            .expect("List response should be an array");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "Orphan");
        assert_eq!(entries[0]["createdBy"], serde_json::Value::Null);
    }

    #[sqlx::test]
    async fn test_address_book_routes_support_crud_and_export(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let auth_cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/address-book")
                    .header("content-type", "application/json")
                    .header("cookie", &auth_cookie)
                    .body(Body::from(
                        json!({
                            "daoId": DAO_ID,
                            "entries": [{
                                "name": "Vendor, Inc.",
                                "networks": ["near", "ethereum"],
                                "address": "0xabc123",
                                "note": "Says \"hi\", friend"
                            }]
                        })
                        .to_string(),
                    ))
                    .expect("Should build create request"),
            )
            .await
            .expect("Create request should complete");

        let create_status = create_response.status();
        let create_body = response_text(create_response).await;
        assert_eq!(
            create_status,
            StatusCode::OK,
            "Create should succeed. Body: {create_body}"
        );

        let created_entries: serde_json::Value =
            serde_json::from_str(&create_body).expect("Create response should be valid JSON");
        let created_entries = created_entries
            .as_array()
            .expect("Create response should be a JSON array");
        assert_eq!(
            created_entries.len(),
            1,
            "Create should return exactly one inserted entry"
        );

        let created_entry = created_entries
            .first()
            .expect("Create response should contain the new entry");
        let created_id = created_entry
            .get("id")
            .and_then(|value| value.as_str())
            .expect("Created entry should include an id")
            .to_string();
        assert_eq!(
            created_entry
                .get("createdBy")
                .and_then(|value| value.as_str()),
            Some(USER_ACCOUNT_ID),
            "Create should include the authenticated creator account"
        );

        let duplicate_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/address-book")
                    .header("content-type", "application/json")
                    .header("cookie", &auth_cookie)
                    .body(Body::from(
                        json!({
                            "daoId": DAO_ID,
                            "entries": [{
                                "name": "Duplicate vendor",
                                "networks": ["near"],
                                "address": "0xabc123",
                                "note": "Should be ignored"
                            }]
                        })
                        .to_string(),
                    ))
                    .expect("Should build duplicate create request"),
            )
            .await
            .expect("Duplicate create request should complete");

        let duplicate_status = duplicate_response.status();
        let duplicate_body = response_text(duplicate_response).await;
        assert_eq!(
            duplicate_status,
            StatusCode::OK,
            "Duplicate create should still return OK. Body: {duplicate_body}"
        );

        let duplicate_entries: serde_json::Value = serde_json::from_str(&duplicate_body)
            .expect("Duplicate create response should be JSON");
        let duplicate_entries = duplicate_entries
            .as_array()
            .expect("Duplicate create response should be a JSON array");
        assert!(
            duplicate_entries.is_empty(),
            "Duplicate create should not return any inserted rows"
        );

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/address-book?daoId={DAO_ID}"))
                    .header("cookie", &auth_cookie)
                    .body(Body::empty())
                    .expect("Should build list request"),
            )
            .await
            .expect("List request should complete");

        let list_status = list_response.status();
        let list_body = response_text(list_response).await;
        assert_eq!(
            list_status,
            StatusCode::OK,
            "List should succeed. Body: {list_body}"
        );

        let listed_entries: serde_json::Value =
            serde_json::from_str(&list_body).expect("List response should be valid JSON");
        let listed_entries = listed_entries
            .as_array()
            .expect("List response should be a JSON array");
        assert_eq!(
            listed_entries.len(),
            1,
            "List should still return one entry after duplicate create"
        );
        assert_eq!(
            listed_entries[0]
                .get("name")
                .and_then(|value| value.as_str()),
            Some("Vendor, Inc."),
            "List should preserve the original entry rather than overwrite it"
        );

        let export_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/api/address-book/export?daoId={DAO_ID}&ids={created_id}"
                    ))
                    .header("cookie", &auth_cookie)
                    .body(Body::empty())
                    .expect("Should build export request"),
            )
            .await
            .expect("Export request should complete");

        let export_status = export_response.status();
        let export_content_type = export_response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .expect("Export response should include a content type")
            .to_string();
        let export_content_disposition = export_response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .expect("Export response should include content disposition")
            .to_string();
        let export_body = response_text(export_response).await;

        assert_eq!(
            export_status,
            StatusCode::OK,
            "Export should succeed. Body: {export_body}"
        );
        assert_eq!(
            export_content_type, "text/csv; charset=utf-8",
            "Export should return CSV content"
        );
        assert_eq!(
            export_content_disposition, "attachment; filename=\"address-book.csv\"",
            "Export should return a downloadable filename"
        );
        assert!(
            export_body.starts_with("Name,Address,Networks,Note,Created By,Created At\n"),
            "Export should include the expected CSV header"
        );
        assert!(
            export_body.contains("\"Vendor, Inc.\""),
            "Export should quote names that contain commas"
        );
        assert!(
            export_body.contains("\"Says \"\"hi\"\", friend\""),
            "Export should escape quotes inside CSV fields"
        );
        assert!(
            export_body.contains(USER_ACCOUNT_ID),
            "Export should include the creator account id"
        );

        let delete_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/address-book")
                    .header("content-type", "application/json")
                    .header("cookie", &auth_cookie)
                    .body(Body::from(
                        json!({
                            "ids": [created_id]
                        })
                        .to_string(),
                    ))
                    .expect("Should build delete request"),
            )
            .await
            .expect("Delete request should complete");

        let delete_status = delete_response.status();
        let delete_body = response_text(delete_response).await;
        assert_eq!(
            delete_status,
            StatusCode::NO_CONTENT,
            "Delete should succeed. Body: {delete_body}"
        );

        let final_list_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/address-book?daoId={DAO_ID}"))
                    .header("cookie", &auth_cookie)
                    .body(Body::empty())
                    .expect("Should build final list request"),
            )
            .await
            .expect("Final list request should complete");

        let final_list_status = final_list_response.status();
        let final_list_body = response_text(final_list_response).await;
        assert_eq!(
            final_list_status,
            StatusCode::OK,
            "Final list should succeed. Body: {final_list_body}"
        );

        let final_entries: serde_json::Value =
            serde_json::from_str(&final_list_body).expect("Final list response should be JSON");
        let final_entries = final_entries
            .as_array()
            .expect("Final list response should be a JSON array");
        assert!(
            final_entries.is_empty(),
            "Delete should remove the exported address book entry"
        );
    }

    #[sqlx::test]
    async fn test_create_address_book_rejects_empty_entries(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let auth_cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/address-book")
                    .header("content-type", "application/json")
                    .header("cookie", &auth_cookie)
                    .body(Body::from(
                        json!({
                            "daoId": DAO_ID,
                            "entries": []
                        })
                        .to_string(),
                    ))
                    .expect("Should build empty create request"),
            )
            .await
            .expect("Empty create request should complete");

        let status = response.status();
        let body = response_text(response).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "Empty create should be rejected. Body: {body}"
        );
        assert_eq!(
            body, "entries must not be empty",
            "Empty create should return the validation error"
        );
    }

    #[sqlx::test]
    async fn test_delete_address_book_rejects_entries_from_multiple_daos(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        seed_dao(&pool, DAO_ID).await;
        seed_dao(&pool, OTHER_DAO_ID).await;

        let auth_cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;
        let first_id = insert_address_book_entry(&pool, DAO_ID, "Alpha", "alpha.near").await;
        let second_id = insert_address_book_entry(&pool, OTHER_DAO_ID, "Beta", "beta.near").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/address-book")
                    .header("content-type", "application/json")
                    .header("cookie", &auth_cookie)
                    .body(Body::from(
                        json!({
                            "ids": [first_id, second_id]
                        })
                        .to_string(),
                    ))
                    .expect("Should build multi-DAO delete request"),
            )
            .await
            .expect("Multi-DAO delete request should complete");

        let status = response.status();
        let body = response_text(response).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "Deleting entries across DAOs should be rejected. Body: {body}"
        );
        assert_eq!(
            body, "All entries must belong to the same DAO",
            "Delete should explain why the request was rejected"
        );

        let remaining_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM address_book")
            .fetch_one(&pool)
            .await
            .expect("Should count remaining address book rows");
        assert_eq!(
            remaining_count, 2,
            "Rejected multi-DAO delete should leave both rows untouched"
        );
    }
}

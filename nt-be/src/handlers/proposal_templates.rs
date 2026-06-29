//! Per-DAO custom proposal templates (the manifest-driven custom-proposal framework).
//!
//! A `manifest` is a JSON form definition. A techy DAO member authors a template; regular
//! members later fill the rendered form to file a generic SputnikDAO `FunctionCall` proposal.
//! This module is the storage + CRUD layer (mirrors `address_book`). The form engine and
//! renderer live in the frontend; the on-chain proposal a template produces still passes the
//! DAO's normal permissions and approvals, so a manifest never grants authority by itself.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalTemplate {
    pub id: Uuid,
    pub dao_id: AccountId,
    pub name: String,
    pub description: Option<String>,
    pub manifest: Value,
    pub enabled: bool,
    pub pinned: bool,
    pub created_by: Option<AccountId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Row shape for the join queries (list / fetch-by-id), with the creator's wallet resolved.
struct ProposalTemplateRow {
    id: Uuid,
    dao_id: String,
    name: String,
    description: Option<String>,
    manifest: Value,
    enabled: bool,
    pinned: bool,
    created_by_wallet: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl TryFrom<ProposalTemplateRow> for ProposalTemplate {
    type Error = near_account_id::ParseAccountError;

    fn try_from(r: ProposalTemplateRow) -> Result<Self, Self::Error> {
        Ok(ProposalTemplate {
            id: r.id,
            dao_id: r.dao_id.parse()?,
            name: r.name,
            description: r.description,
            manifest: r.manifest,
            enabled: r.enabled,
            pinned: r.pinned,
            created_by: r.created_by_wallet.map(|s| s.parse()).transpose()?,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProposalTemplateRequest {
    pub name: String,
    pub description: Option<String>,
    pub manifest: Value,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProposalTemplateRequest {
    pub name: Option<String>,
    /// Omitted or `null` leaves the existing description unchanged (COALESCE semantics). A
    /// provided value must be non-blank (trimmed, like `name`): a whitespace-only string is
    /// rejected rather than silently stored as `""`. There is no clear-to-empty here.
    pub description: Option<String>,
    /// Omitted or `null` leaves the existing manifest unchanged (COALESCE semantics). The
    /// manifest cannot be cleared through this endpoint — send the replacement shape instead
    /// (the column is NOT NULL, so an absent manifest is never a valid stored state).
    pub manifest: Option<Value>,
    pub enabled: Option<bool>,
    /// Omitted or `null` leaves the pin state unchanged (COALESCE). Toggling this is how a template
    /// is pinned to / unpinned from the sidebar.
    pub pinned: Option<bool>,
}

fn default_enabled() -> bool {
    true
}

/// Validate a manifest's structural shape and return a **normalized** copy with its known
/// string fields (`id`, `title`, `binding.receiver_id`, `binding.method_name`) trimmed — the
/// same trim-then-store treatment `name`/`description` get, so a padded `id` can't drift the
/// `[trezu-tmpl:<id>]` tag or break downstream comparisons.
///
/// Only structural validation here; strict field-type / u128 / args-mapping checks are a
/// deliberate follow-up that must mirror the frontend validator and lands with the form engine.
fn validate_manifest(manifest: &Value) -> Result<Value, String> {
    let obj = manifest
        .as_object()
        .ok_or("manifest must be a JSON object")?;

    // Shared by the validity check and the normalize-on-store step below.
    fn trimmed(
        container: &serde_json::Map<String, Value>,
        key: &str,
        path: &str,
    ) -> Result<String, String> {
        container
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("manifest.{path} must be a non-empty string"))
    }

    let id = trimmed(obj, "id", "id")?;
    // `id` becomes the `manifest_id` generated column and the `/custom-templates/<id>` route key, so
    // enforce its slug shape here (the rest of the strict field validation stays a follow-up): a
    // tag-safe charset, and not a reserved static-route slug that would shadow the template's page.
    // Keep RESERVED_SLUGS in sync with the frontend `RESERVED_TEMPLATE_SLUGS` in manifest.ts.
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("manifest.id must be a tag-safe slug ([A-Za-z0-9_-])".to_string());
    }
    const RESERVED_SLUGS: [&str; 3] = ["create", "new", "about"];
    if RESERVED_SLUGS.contains(&id.to_lowercase().as_str()) {
        return Err(format!(
            "manifest.id must not be a reserved route slug ({})",
            RESERVED_SLUGS.join(", ")
        ));
    }
    let title = trimmed(obj, "title", "title")?;

    let binding = obj
        .get("binding")
        .and_then(Value::as_object)
        .ok_or("manifest.binding must be an object")?;
    let receiver_id = trimmed(binding, "receiver_id", "binding.receiver_id")?;
    let method_name = trimmed(binding, "method_name", "binding.method_name")?;

    // `receiver_id`/`method_name` go straight into the on-chain FunctionCall, so reject free text
    // (e.g. "I m the receiver" / "the method") that would file an un-callable proposal. Mirrors the
    // frontend manifest validator (NEAR_ACCOUNT_RE + method-name rule in nt-fe manifest.ts).
    AccountId::from_str(&receiver_id)
        .map_err(|_| "manifest.binding.receiver_id must be a valid NEAR account id".to_string())?;
    let method_ok = method_name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && method_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !method_ok {
        return Err(
            "manifest.binding.method_name must be a valid contract method name ([A-Za-z0-9_], no spaces)"
                .to_string(),
        );
    }

    if !obj.get("fields").map(Value::is_array).unwrap_or(false) {
        return Err("manifest.fields must be an array".to_string());
    }

    let mut normalized = manifest.clone();
    let obj = normalized
        .as_object_mut()
        .expect("manifest was validated as an object above");
    obj.insert("id".to_string(), Value::String(id));
    obj.insert("title".to_string(), Value::String(title));
    let binding = obj
        .get_mut("binding")
        .and_then(Value::as_object_mut)
        .expect("binding was validated as an object above");
    binding.insert("receiver_id".to_string(), Value::String(receiver_id));
    binding.insert("method_name".to_string(), Value::String(method_name));
    Ok(normalized)
}

fn internal_error(context: &str, e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("{context}: {e}");
    (StatusCode::INTERNAL_SERVER_ERROR, context.to_string())
}

/// Trim an optional request string and reject a blank value (`""` or whitespace-only) so a
/// blank can never be silently stored as `""`. `None` (omitted / null) passes through unchanged.
fn trim_optional(
    value: Option<String>,
    field: &str,
) -> Result<Option<String>, (StatusCode, String)> {
    match value.as_deref().map(str::trim) {
        Some("") => Err((
            StatusCode::BAD_REQUEST,
            format!("{field} must not be blank"),
        )),
        Some(trimmed) => Ok(Some(trimmed.to_string())),
        None => Ok(None),
    }
}

/// Re-fetch a full template (with creator wallet) after a mutation, scoped to the DAO.
async fn fetch_template_by_id(
    pool: &PgPool,
    dao_id: &str,
    id: Uuid,
) -> Result<Option<ProposalTemplateRow>, sqlx::Error> {
    sqlx::query_as!(
        ProposalTemplateRow,
        r#"
        SELECT pt.id, pt.dao_id, pt.name, pt.description,
               pt.manifest AS "manifest: serde_json::Value",
               pt.enabled, pt.pinned, pt.created_at, pt.updated_at,
               u.account_id AS "created_by_wallet?"
        FROM proposal_templates pt
        LEFT JOIN users u ON u.id = pt.created_by
        WHERE pt.dao_id = $1 AND pt.id = $2
        "#,
        dao_id,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn list_proposal_templates(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
) -> Result<Json<Vec<ProposalTemplate>>, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &dao_id)
        .await?;

    let templates: Vec<ProposalTemplate> = sqlx::query_as!(
        ProposalTemplateRow,
        r#"
        SELECT pt.id, pt.dao_id, pt.name, pt.description,
               pt.manifest AS "manifest: serde_json::Value",
               pt.enabled, pt.pinned, pt.created_at, pt.updated_at,
               u.account_id AS "created_by_wallet?"
        FROM proposal_templates pt
        LEFT JOIN users u ON u.id = pt.created_by
        WHERE pt.dao_id = $1
        ORDER BY pt.created_at DESC
        "#,
        dao_id.as_str()
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to list proposal templates", e))?
    .into_iter()
    .map(ProposalTemplate::try_from)
    .collect::<Result<_, _>>()
    .map_err(|e| internal_error("Invalid account in proposal template", e))?;

    Ok(Json(templates))
}

pub async fn create_proposal_template(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
    Json(req): Json<CreateProposalTemplateRequest>,
) -> Result<(StatusCode, Json<ProposalTemplate>), (StatusCode, String)> {
    // Authoring a template defines a reusable on-chain action shape that members fill and execute,
    // so gate writes on the DAO's policy-management permission (ChangePolicy) — reads/fills stay at
    // membership. Unit-testable via `seed_treasury_policy`.
    auth_user
        .verify_can_perform_action(&state, &dao_id, "ChangePolicy")
        .await?;

    let manifest = validate_manifest(&req.manifest).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // Normalize name/description like the manifest's own strings, so whitespace variants
    // ("Guestbook Tip" vs " Guestbook Tip ") can't slip past the unique (dao_id, name) index.
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "name must not be blank".to_string(),
        ));
    }
    let description = trim_optional(req.description, "description")?;

    let user_id = sqlx::query_scalar!(
        "SELECT id FROM users WHERE account_id = $1",
        auth_user.account_id.as_str()
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to look up user", e))?;
    if user_id.is_none() {
        // A valid session implies a users row (FK); a missing one is server corruption, not a
        // reason to silently drop the created_by attribution.
        tracing::error!(
            "Authenticated user {} has no profile row; refusing to store a NULL created_by",
            auth_user.account_id
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Authenticated user has no profile".to_string(),
        ));
    }

    let id: Uuid = sqlx::query_scalar!(
        r#"
        INSERT INTO proposal_templates (dao_id, name, description, manifest, enabled, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        dao_id.as_str(),
        name,
        description,
        manifest,
        req.enabled,
        user_id
    )
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        if e.as_database_error()
            .map(|db| db.is_unique_violation())
            .unwrap_or(false)
        {
            (
                StatusCode::CONFLICT,
                "A template with this name or id already exists for this DAO".to_string(),
            )
        } else {
            internal_error("Failed to create proposal template", e)
        }
    })?;

    let row = fetch_template_by_id(&state.db_pool, dao_id.as_str(), id)
        .await
        .map_err(|e| internal_error("Failed to load created template", e))?
        .ok_or_else(|| internal_error("Created template vanished", "not found"))?;

    let template = ProposalTemplate::try_from(row)
        .map_err(|e| internal_error("Invalid account in template", e))?;

    Ok((StatusCode::CREATED, Json(template)))
}

pub async fn update_proposal_template(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path((dao_id, id)): Path<(AccountId, Uuid)>,
    Json(req): Json<UpdateProposalTemplateRequest>,
) -> Result<Json<ProposalTemplate>, (StatusCode, String)> {
    auth_user
        .verify_can_perform_action(&state, &dao_id, "ChangePolicy")
        .await?;

    let manifest = match &req.manifest {
        Some(m) => Some(validate_manifest(m).map_err(|e| (StatusCode::BAD_REQUEST, e))?),
        None => None,
    };

    // Normalize the same way create does, so a whitespace-padded rename collides with the
    // existing row instead of duplicating it. A blank name/description is rejected, not stored.
    let name = trim_optional(req.name, "name")?;
    let description = trim_optional(req.description, "description")?;

    // COALESCE keeps existing values for any field omitted from the request.
    let updated = sqlx::query_scalar!(
        r#"
        UPDATE proposal_templates
        SET name        = COALESCE($3, name),
            description = COALESCE($4, description),
            manifest    = COALESCE($5, manifest),
            enabled     = COALESCE($6, enabled),
            pinned      = COALESCE($7, pinned)
        WHERE dao_id = $1 AND id = $2
        RETURNING id
        "#,
        dao_id.as_str(),
        id,
        name,
        description,
        manifest,
        req.enabled,
        req.pinned,
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        if e.as_database_error()
            .map(|db| db.is_unique_violation())
            .unwrap_or(false)
        {
            (
                StatusCode::CONFLICT,
                "A template with this name or id already exists for this DAO".to_string(),
            )
        } else {
            internal_error("Failed to update proposal template", e)
        }
    })?;

    if updated.is_none() {
        return Err((StatusCode::NOT_FOUND, "Template not found".to_string()));
    }

    let row = fetch_template_by_id(&state.db_pool, dao_id.as_str(), id)
        .await
        .map_err(|e| internal_error("Failed to load updated template", e))?
        .ok_or_else(|| internal_error("Updated template vanished", "not found"))?;

    let template = ProposalTemplate::try_from(row)
        .map_err(|e| internal_error("Invalid account in template", e))?;

    Ok(Json(template))
}

pub async fn delete_proposal_template(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path((dao_id, id)): Path<(AccountId, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    auth_user
        .verify_can_perform_action(&state, &dao_id, "ChangePolicy")
        .await?;

    let result = sqlx::query!(
        "DELETE FROM proposal_templates WHERE dao_id = $1 AND id = $2",
        dao_id.as_str(),
        id
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to delete proposal template", e))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Template not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use crate::{
        routes::create_routes,
        utils::test_utils::{
            DAO_ID, USER_ACCOUNT_ID, issue_auth_cookie, policy_granting, seed_change_policy_member,
            seed_policy_member, seed_treasury_policy, send, test_state,
        },
    };
    use axum::http::StatusCode;
    use serde_json::{Value, json};
    use sqlx::PgPool;
    use uuid::Uuid;

    fn valid_manifest() -> Value {
        json!({
            "version": 1,
            "id": "guestbook-tip",
            "title": "Guestbook Tip",
            "binding": { "receiver_id": "guestbook.near", "method_name": "add_message",
                         "deposit": "1", "gas": "30000000000000" },
            "fields": [{ "name": "amount", "label": "Amount", "type": "uint", "required": true }],
            "args": { "amount": "{{amount}}" },
            "summary": "Tip {{amount}}"
        })
    }

    /// A template whose creator is unknown (`created_by = NULL`, e.g. an imported or directly-seeded
    /// row) must list without crashing: the `LEFT JOIN users` yields a NULL `created_by_wallet`,
    /// which the query has to decode as `None`. Regression for the missing `?` nullability override
    /// — the API create path always sets a creator, so only a non-API row ever hits the null path.
    #[sqlx::test]
    async fn test_list_tolerates_null_creator(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let manifest = valid_manifest();
        sqlx::query!(
            r#"
            INSERT INTO proposal_templates (dao_id, name, manifest, enabled, created_by)
            VALUES ($1, $2, $3, true, NULL)
            "#,
            DAO_ID,
            "Imported",
            manifest,
        )
        .execute(&pool)
        .await
        .expect("insert null-creator template");

        let (status, body) = send(app, "GET", base, &cookie, None).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let templates: Value = serde_json::from_str(&body).expect("json body");
        let templates = templates.as_array().expect("array body");
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0]["name"], "Imported");
        assert_eq!(templates[0]["createdBy"], Value::Null);
    }

    /// `id` is the route slug, so the create endpoint rejects a reserved one — it would shadow a
    /// static `/custom-templates/<slug>` route. Mirrors the frontend `RESERVED_TEMPLATE_SLUGS`.
    #[sqlx::test]
    async fn test_create_rejects_reserved_slug_id(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");
        seed_change_policy_member(&state, &pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let mut manifest = valid_manifest();
        manifest["id"] = json!("create");
        let (status, body) = send(
            app,
            "POST",
            base,
            &cookie,
            Some(json!({ "name": "Reserved", "manifest": manifest })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    }

    #[sqlx::test]
    async fn test_proposal_template_crud(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());

        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");
        seed_change_policy_member(&state, &pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        // CREATE
        let (status, body) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(json!({ "name": "Guestbook Tip", "manifest": valid_manifest() })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "create should succeed: {body}");
        let created: Value = serde_json::from_str(&body).unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["createdBy"].as_str(), Some(USER_ACCOUNT_ID));
        assert_eq!(created["enabled"].as_bool(), Some(true));
        assert_eq!(
            created["pinned"].as_bool(),
            Some(false),
            "pinned defaults to false on create"
        );
        assert_eq!(
            created["manifest"],
            valid_manifest(),
            "manifest should round-trip through JSONB unchanged"
        );

        // CREATE duplicate name -> 409
        let (status, _) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(json!({ "name": "Guestbook Tip", "manifest": valid_manifest() })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // CREATE invalid manifest -> 400
        let (status, _) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(json!({ "name": "Bad", "manifest": { "id": "" } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // CREATE with a whitespace-only name -> 400
        let (status, _) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(json!({ "name": "   ", "manifest": valid_manifest() })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // CREATE with a whitespace-only description -> 400 (not silently stored as "")
        let (status, _) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(
                json!({ "name": "Blank Desc", "description": "   ", "manifest": valid_manifest() }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // CREATE a second template (target for the rename-collision check below). Distinct
        // manifest id — manifest_id is unique per DAO now.
        let mut other_manifest = valid_manifest();
        other_manifest["id"] = json!("other-template");
        let (status, _) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(json!({ "name": "Other Template", "manifest": other_manifest })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        // A whitespace-padded duplicate of an existing name must collide on the trimmed name —
        // give it a distinct manifest id so the collision is purely the name, not manifest_id.
        let mut padded_manifest = valid_manifest();
        padded_manifest["id"] = json!("padded-twin");
        let (status, _) = send(
            app.clone(),
            "POST",
            base.clone(),
            &cookie,
            Some(json!({ "name": "  Other Template  ", "manifest": padded_manifest })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // LIST -> two templates
        let (status, body) = send(app.clone(), "GET", base.clone(), &cookie, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&body)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let item = format!("{base}/{id}");

        // UPDATE happy path (rename + disable)
        let (status, body) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "name": "Guestbook Tip v2", "enabled": false })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let updated: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(updated["name"].as_str(), Some("Guestbook Tip v2"));
        assert_eq!(updated["enabled"].as_bool(), Some(false));
        // Fields omitted from the body must be preserved (COALESCE), not cleared/overwritten.
        assert!(
            updated["description"].is_null(),
            "omitted description must stay null, not be cleared to ''"
        );
        assert_eq!(
            updated["manifest"],
            valid_manifest(),
            "omitted manifest must be preserved, not overwritten"
        );
        // The BEFORE UPDATE trigger must bump updated_at while leaving created_at fixed.
        assert_eq!(
            updated["createdAt"], created["createdAt"],
            "created_at must not change on update"
        );
        assert_ne!(
            updated["updatedAt"], created["updatedAt"],
            "updated_at must advance on update (BEFORE UPDATE trigger must be load-bearing)"
        );

        // UPDATE setting description explicitly -> round-trips through UPDATE,
        // and leaves the other (omitted) fields untouched.
        let (status, body) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "description": "  new desc  " })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let updated: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            updated["description"].as_str(),
            Some("new desc"),
            "description should be trimmed on update"
        );
        assert_eq!(
            updated["name"].as_str(),
            Some("Guestbook Tip v2"),
            "name must be preserved when only description is updated"
        );

        // PIN: set it to true.
        let (status, body) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "pinned": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["pinned"].as_bool(),
            Some(true),
            "pinned should be set to true"
        );

        // A name-only update must NOT clear pinned — COALESCE($7, pinned) is load-bearing; without
        // it, pin state would silently reset on every other field's update.
        let (status, body) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "name": "renamed" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["pinned"].as_bool(),
            Some(true),
            "pinned must survive a name-only update, not silently clear"
        );

        // UNPIN: toggle true -> false and read it back.
        let (status, body) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "pinned": false })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["pinned"].as_bool(),
            Some(false),
            "pinned should toggle back to false"
        );

        // UPDATE with a whitespace-only description -> 400
        let (status, _) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "description": "   " })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // UPDATE with a structurally-invalid manifest -> 400
        let (status, _) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "manifest": { "id": "" } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // UPDATE renaming onto an existing template's name -> 409
        let (status, _) = send(
            app.clone(),
            "PUT",
            item.clone(),
            &cookie,
            Some(json!({ "name": "Other Template" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // UPDATE a non-existent id -> 404
        let (status, _) = send(
            app.clone(),
            "PUT",
            format!("{base}/{}", Uuid::new_v4()),
            &cookie,
            Some(json!({ "enabled": true })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // DELETE -> 204
        let (status, _) = send(app.clone(), "DELETE", item.clone(), &cookie, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // DELETE again (already gone) -> 404
        let (status, _) = send(app.clone(), "DELETE", item.clone(), &cookie, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // LIST -> only the second template remains
        let (_, body) = send(app.clone(), "GET", base.clone(), &cookie, None).await;
        let remaining: Value = serde_json::from_str(&body).unwrap();
        let remaining = remaining.as_array().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["name"].as_str(), Some("Other Template"));
    }

    #[sqlx::test]
    async fn test_non_member_is_forbidden(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");

        // The DAO is fully onboarded (monitored + present in `daos`) and HAS a policy member
        // — just not our caller. So a 403 reflects a genuine non-member, not an unknown DAO.
        seed_policy_member(&pool, DAO_ID, "someone-else.near").await;
        // Seed a policy (ChangePolicy to someone else) so the write endpoints reach a real 403
        // rather than an RPC to a non-existent DAO.
        let dao: near_api::AccountId = DAO_ID.parse().unwrap();
        seed_treasury_policy(
            &state,
            &dao,
            policy_granting("someone-else.near", &["*:ChangePolicy"]),
        )
        .await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let item = format!("{base}/{}", Uuid::new_v4());

        // Every endpoint must reject a non-member before doing anything else.
        let cases: [(&str, String, Option<Value>); 4] = [
            ("GET", base.clone(), None),
            (
                "POST",
                base.clone(),
                Some(json!({ "name": "x", "manifest": valid_manifest() })),
            ),
            ("PUT", item.clone(), Some(json!({ "enabled": true }))),
            ("DELETE", item.clone(), None),
        ];
        for (method, uri, body) in cases {
            let (status, _) = send(app.clone(), method, uri, &cookie, body).await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "{method} must be forbidden for a non-member"
            );
        }
    }

    /// A policy member who lacks `ChangePolicy` can read/list templates but cannot author them —
    /// the read/write split the gate exists to enforce.
    #[sqlx::test]
    async fn test_member_without_change_policy_cannot_write(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");

        // member.near is a policy member, but ChangePolicy is granted to someone else.
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let dao: near_api::AccountId = DAO_ID.parse().unwrap();
        seed_treasury_policy(
            &state,
            &dao,
            policy_granting("admin.near", &["*:ChangePolicy"]),
        )
        .await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        // Reads are allowed (membership).
        let (status, body) = send(app.clone(), "GET", base.clone(), &cookie, None).await;
        assert_eq!(status, StatusCode::OK, "a member may list: {body}");

        // ...but every write (create/update/delete) is rejected without ChangePolicy.
        let item = format!("{base}/{}", Uuid::new_v4());
        let writes: [(&str, String, Option<Value>); 3] = [
            (
                "POST",
                base.clone(),
                Some(json!({ "name": "X", "manifest": valid_manifest() })),
            ),
            ("PUT", item.clone(), Some(json!({ "enabled": true }))),
            ("DELETE", item.clone(), None),
        ];
        for (method, uri, body) in writes {
            let (status, _) = send(app.clone(), method, uri, &cookie, body).await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "{method} must be forbidden without ChangePolicy"
            );
        }
    }

    #[sqlx::test]
    async fn test_manifest_strings_are_normalized_on_store(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");

        seed_change_policy_member(&state, &pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let padded = json!({
            "version": 1,
            "id": "  guestbook-tip  ",
            "title": "  Guestbook Tip  ",
            "binding": { "receiver_id": "  guestbook.near  ", "method_name": "  add_message  " },
            "fields": [],
            "args": {}
        });
        let (status, body) = send(
            app,
            "POST",
            base,
            &cookie,
            Some(json!({ "name": "Padded", "manifest": padded })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "create should succeed: {body}");

        let created: Value = serde_json::from_str(&body).unwrap();
        let m = &created["manifest"];
        assert_eq!(m["id"].as_str(), Some("guestbook-tip"));
        assert_eq!(m["title"].as_str(), Some("Guestbook Tip"));
        assert_eq!(m["binding"]["receiver_id"].as_str(), Some("guestbook.near"));
        assert_eq!(m["binding"]["method_name"].as_str(), Some("add_message"));
    }

    #[sqlx::test]
    async fn test_db_error_during_membership_check_is_500_not_403(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        let base = format!("/api/treasury/{DAO_ID}/proposal-templates");

        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        // Break the membership lookup at the DB layer. A DB failure must surface as 500, not be
        // collapsed into a misleading 403 (the bug behind verify_dao_member_for_http).
        sqlx::query("DROP TABLE dao_members CASCADE")
            .execute(&pool)
            .await
            .unwrap();

        let (status, _) = send(app, "GET", base, &cookie, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn test_validate_manifest_rejects_malformed_shapes() {
        assert!(super::validate_manifest(&valid_manifest()).is_ok());

        let binding = json!({ "receiver_id": "a.near", "method_name": "m" });
        let rejected = [
            json!("not an object"),
            json!({ "id": "", "title": "t", "binding": binding.clone(), "fields": [] }),
            json!({ "id": "x", "title": "", "binding": binding.clone(), "fields": [] }),
            json!({ "id": "x", "title": "t", "fields": [] }), // missing binding
            json!({ "id": "x", "title": "t", "binding": { "method_name": "m" }, "fields": [] }),
            json!({ "id": "x", "title": "t", "binding": { "receiver_id": "a.near" }, "fields": [] }),
            json!({ "id": "x", "title": "t", "binding": binding.clone() }), // missing fields
            json!({ "id": "x", "title": "t", "binding": binding.clone(), "fields": {} }), // fields not array
            // free-text receiver / method that can't name a real account or method
            json!({ "id": "x", "title": "t", "binding": { "receiver_id": "I m the receiver", "method_name": "m" }, "fields": [] }),
            json!({ "id": "x", "title": "t", "binding": { "receiver_id": "a.near", "method_name": "the method" }, "fields": [] }),
        ];
        for case in rejected {
            assert!(
                super::validate_manifest(&case).is_err(),
                "should reject manifest: {case}"
            );
        }
    }
}

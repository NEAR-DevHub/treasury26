//! The per-treasury "Custom Requests" feature flag (custom proposal templates).
//!
//! The feature ships disabled for every treasury. A DAO turns it on from Settings → Developer,
//! which reveals the Request Templates section in the app. Reading the flag only needs DAO
//! membership; flipping it is gated on the on-chain `ChangePolicy` (admin) permission — the same
//! gate as deleting a template — so a privileged member opts the whole treasury in. The flag lives on
//! `monitored_accounts` (the per-treasury record `proposal_templates` already references).

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::services::monitored_accounts::{
    RegisterMonitoredAccountError, register_or_refresh_monitored_account,
};
use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, Deserialize)]
pub struct CustomRequestsSetting {
    pub enabled: bool,
}

fn internal_error(context: &str, e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("{context}: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error".to_string(),
    )
}

/// `GET /api/treasury/{dao_id}/custom-requests` — whether the feature is enabled for this treasury.
/// Membership-gated; a treasury with no `monitored_accounts` row yet reads as disabled.
pub async fn get_custom_requests_setting(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
) -> Result<Json<CustomRequestsSetting>, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &dao_id)
        .await?;

    let enabled = sqlx::query_scalar!(
        "SELECT custom_requests_enabled FROM monitored_accounts WHERE account_id = $1",
        dao_id.as_str()
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to read custom-requests flag", e))?
    .unwrap_or(false);

    Ok(Json(CustomRequestsSetting { enabled }))
}

/// `PUT /api/treasury/{dao_id}/custom-requests` — enable or disable the feature for this treasury.
/// Gated on `ChangePolicy` (admin), matching template deletion. The treasury row is ensured through the
/// canonical `register_or_refresh_monitored_account` registrar (not a bare upsert) so it goes
/// through the same `.sputnik-dao.near` suffix gate as every other treasury, then the flag is set.
pub async fn set_custom_requests_setting(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(dao_id): Path<AccountId>,
    Json(req): Json<CustomRequestsSetting>,
) -> Result<Json<CustomRequestsSetting>, (StatusCode, String)> {
    auth_user
        .verify_can_perform_action(&state, &dao_id, "ChangePolicy")
        .await?;

    // Ensure the monitored_accounts row exists via the canonical path: it enforces the
    // *.sputnik-dao.near suffix gate (and on an already-tracked treasury also re-marks the daos row
    // dirty for the sync loop). A ChangePolicy holder implies a real DAO (the policy was fetched
    // above), so NotSputnikDao is a defensive 400.
    register_or_refresh_monitored_account(&state.db_pool, &dao_id, false)
        .await
        .map_err(|e| match e {
            RegisterMonitoredAccountError::NotSputnikDao => (
                StatusCode::BAD_REQUEST,
                "Account is not a SputnikDAO treasury".to_string(),
            ),
            RegisterMonitoredAccountError::Db(e) => {
                internal_error("Failed to register treasury", e)
            }
        })?;

    let enabled = sqlx::query_scalar!(
        "UPDATE monitored_accounts SET custom_requests_enabled = $2 WHERE account_id = $1 RETURNING custom_requests_enabled",
        dao_id.as_str(),
        req.enabled
    )
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to set custom-requests flag", e))?;

    Ok(Json(CustomRequestsSetting { enabled }))
}

#[cfg(test)]
mod tests {
    use crate::{
        config::{PlanType, get_initial_credits},
        routes::create_routes,
        utils::test_utils::{
            DAO_ID, USER_ACCOUNT_ID, issue_auth_cookie, policy_granting, seed_full_admin_member,
            seed_policy_member, seed_treasury_policy, send, test_state,
        },
    };
    use axum::http::StatusCode;
    use serde_json::{Value, json};
    use sqlx::PgPool;

    fn uri() -> String {
        format!("/api/treasury/{DAO_ID}/custom-requests")
    }

    fn enabled_of(body: &str) -> Option<bool> {
        serde_json::from_str::<Value>(body).unwrap()["enabled"].as_bool()
    }

    #[sqlx::test]
    async fn test_defaults_to_disabled_for_a_member(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(app, "GET", uri(), &cookie, None).await;
        assert_eq!(status, StatusCode::OK, "a member can read the flag: {body}");
        assert_eq!(
            enabled_of(&body),
            Some(false),
            "the flag defaults to disabled"
        );
    }

    #[sqlx::test]
    async fn test_enable_then_disable_round_trips(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_full_admin_member(&state, &pool, DAO_ID, USER_ACCOUNT_ID).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        // ENABLE -> 200, and a follow-up GET reflects it.
        let (status, body) = send(
            app.clone(),
            "PUT",
            uri(),
            &cookie,
            Some(json!({ "enabled": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "enable should succeed: {body}");
        assert_eq!(enabled_of(&body), Some(true));
        let (_, body) = send(app.clone(), "GET", uri(), &cookie, None).await;
        assert_eq!(enabled_of(&body), Some(true), "GET reflects the enable");

        // DISABLE -> 200, and the flag toggles back.
        let (status, body) = send(
            app.clone(),
            "PUT",
            uri(),
            &cookie,
            Some(json!({ "enabled": false })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "disable should succeed: {body}");
        assert_eq!(enabled_of(&body), Some(false));
        let (_, body) = send(app, "GET", uri(), &cookie, None).await;
        assert_eq!(enabled_of(&body), Some(false), "GET reflects the disable");
    }

    #[sqlx::test]
    async fn test_enable_forbidden_without_change_policy(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        // A policy member, but ChangePolicy is granted to someone else — so the write must 403.
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        let dao: near_api::AccountId = DAO_ID.parse().unwrap();
        seed_treasury_policy(
            &state,
            &dao,
            policy_granting("admin.near", &["*:ChangePolicy"]),
        )
        .await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, _) = send(app, "PUT", uri(), &cookie, Some(json!({ "enabled": true }))).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "flipping the flag requires ChangePolicy"
        );
    }

    #[sqlx::test]
    async fn test_read_forbidden_for_non_member(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        // A real, onboarded DAO whose only member is someone else (seed both the member row and a
        // policy), so a 403 reflects a genuine non-member rather than an RPC to an unknown DAO.
        seed_policy_member(&pool, DAO_ID, "someone-else.near").await;
        let dao: near_api::AccountId = DAO_ID.parse().unwrap();
        seed_treasury_policy(
            &state,
            &dao,
            policy_granting("someone-else.near", &["*:ChangePolicy"]),
        )
        .await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, _) = send(app, "GET", uri(), &cookie, None).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "a non-member cannot read the flag"
        );
    }

    #[sqlx::test]
    async fn test_enable_registers_a_fresh_treasury(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        // Grant ChangePolicy but DO NOT seed a monitored_accounts row, so the PUT exercises the
        // *fresh-DAO* branch of register_or_refresh_monitored_account (the `.sputnik-dao.near` suffix
        // check + INSERT with default credits) — the reason the handler routes through it at all.
        let dao: near_api::AccountId = DAO_ID.parse().unwrap();
        seed_treasury_policy(
            &state,
            &dao,
            policy_granting(USER_ACCOUNT_ID, &["*:ChangePolicy"]),
        )
        .await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let before: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM monitored_accounts WHERE account_id = $1")
                .bind(DAO_ID)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(
            before.is_none(),
            "precondition: no monitored_accounts row before the PUT"
        );

        let (status, body) =
            send(app, "PUT", uri(), &cookie, Some(json!({ "enabled": true }))).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "enabling a fresh DAO should register it and set the flag: {body}"
        );
        assert_eq!(enabled_of(&body), Some(true));

        // The registrar created the row with Plus-plan defaults — the load-bearing reason the handler
        // routes through it (cf. set_custom_requests_setting doc). Assert against the same source of
        // truth so a refactor that quietly drops the defaults fails here.
        let (plan, export_credits, batch_payment_credits, gas_covered): (String, i32, i32, i32) =
            sqlx::query_as(
                "SELECT plan_type::text, export_credits, batch_payment_credits, gas_covered_transactions \
                 FROM monitored_accounts WHERE account_id = $1",
            )
            .bind(DAO_ID)
            .fetch_one(&pool)
            .await
            .expect("the fresh treasury's monitored_accounts row was created by the registrar");
        let (want_export, want_batch, want_gas) = get_initial_credits(PlanType::Plus);
        assert_eq!(plan, "plus", "fresh DAO registers on the Plus plan");
        assert_eq!(
            (export_credits, batch_payment_credits, gas_covered),
            (want_export, want_batch, want_gas),
            "fresh DAO inherits get_initial_credits(Plus)"
        );
    }
}

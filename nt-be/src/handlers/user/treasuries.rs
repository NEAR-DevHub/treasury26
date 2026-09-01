use crate::auth::AuthUser;
use crate::handlers::treasury::config::{TreasuryConfig, fetch_treasury_config};
use crate::services::{NOT_MANAGED_TREASURY_MESSAGE, is_managed_treasury, register_new_dao};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use futures::stream::{self, StreamExt};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTreasuriesQuery {
    pub account_id: String,
    pub include_hidden: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Treasury {
    pub dao_id: AccountId,
    pub config: TreasuryConfig,
    pub is_member: bool,
    pub is_saved: bool,
    pub is_hidden: bool,
    pub is_confidential: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveUserTreasuryRequest {
    pub account_id: AccountId,
    pub dao_id: AccountId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HideUserTreasuryRequest {
    pub account_id: AccountId,
    pub dao_id: AccountId,
    pub hidden: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveUserTreasuryRequest {
    pub account_id: AccountId,
    pub dao_id: AccountId,
}

#[derive(Debug, sqlx::FromRow)]
struct UserTreasuryRow {
    dao_id: String,
    is_member: bool,
    is_saved: bool,
    is_hidden: bool,
    is_confidential: bool,
}

/// DAOs the user is a policy member of or has saved. Hidden entries are
/// included only when `include_hidden` is set. With `managed_only`
/// (`MANAGED_TREASURIES_ONLY`) only DAOs tracked in `monitored_accounts` are
/// returned, so a stray `dao_members` row can never surface an untracked DAO.
async fn fetch_user_treasury_rows(
    pool: &sqlx::PgPool,
    account_id: &str,
    include_hidden: bool,
    managed_only: bool,
) -> sqlx::Result<Vec<UserTreasuryRow>> {
    sqlx::query_as::<_, UserTreasuryRow>(
        r#"
        SELECT
            dm.dao_id,
            dm.is_policy_member AS is_member,
            dm.is_saved,
            dm.is_hidden,
            COALESCE(ma.is_confidential_account, false) AS is_confidential
        FROM dao_members dm
        LEFT JOIN monitored_accounts ma ON ma.account_id = dm.dao_id
        WHERE dm.account_id = $1
          AND (dm.is_policy_member = true OR dm.is_saved = true)
          AND ($2::bool = true OR dm.is_hidden = false)
          AND ($3::bool = false OR ma.account_id IS NOT NULL)
        ORDER BY dm.dao_id
        "#,
    )
    .bind(account_id)
    .bind(include_hidden)
    .bind(managed_only)
    .fetch_all(pool)
    .await
}

/// Under `MANAGED_TREASURIES_ONLY`, user actions may only touch treasuries
/// already tracked in `monitored_accounts`; otherwise `register_new_dao` would
/// pull arbitrary DAOs into the policy sync loop.
async fn ensure_managed_treasury(
    state: &AppState,
    dao_id: &AccountId,
) -> Result<(), (StatusCode, String)> {
    if !state.env_vars.managed_treasuries_only {
        return Ok(());
    }

    let managed = is_managed_treasury(&state.db_pool, dao_id.as_str())
        .await
        .map_err(|e| {
            tracing::error!("Failed to check whether {} is managed: {}", dao_id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to check treasury".to_string(),
            )
        })?;

    if managed {
        Ok(())
    } else {
        Err((
            StatusCode::NOT_FOUND,
            NOT_MANAGED_TREASURY_MESSAGE.to_string(),
        ))
    }
}

pub async fn get_user_treasuries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserTreasuriesQuery>,
) -> Result<Json<Vec<Treasury>>, (StatusCode, String)> {
    let account_id = params.account_id.clone();
    let include_hidden = params.include_hidden.unwrap_or(false);

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let rows = fetch_user_treasury_rows(
        &state.db_pool,
        &account_id,
        include_hidden,
        state.env_vars.managed_treasuries_only,
    )
    .await
    .map_err(|e| {
        tracing::error!("Error fetching user DAOs from database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch user DAOs".to_string(),
        )
    })?;

    if rows.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let fetches = rows.into_iter().map(|row| {
        let state = state.clone();
        async move {
            let dao_id_str = row.dao_id;
            let dao_id: AccountId = match dao_id_str.parse() {
                Ok(id) => id,
                Err(e) => {
                    tracing::warn!("Invalid DAO ID in database: {} - {}", dao_id_str, e);
                    return Ok(None);
                }
            };

            let config = fetch_treasury_config(&state, &dao_id, None).await?;

            Ok(Some(Treasury {
                dao_id,
                config,
                is_member: row.is_member,
                is_saved: row.is_saved,
                is_hidden: row.is_hidden,
                is_confidential: row.is_confidential,
            }))
        }
    });

    let mut treasuries = Vec::new();
    let results = stream::iter(fetches)
        .buffer_unordered(8)
        .collect::<Vec<Result<Option<Treasury>, (StatusCode, String)>>>()
        .await;

    for result in results {
        match result {
            Ok(Some(treasury)) => treasuries.push(treasury),
            Ok(None) => {}
            Err(err) => return Err(err),
        }
    }

    // Sort: member treasuries first, then by treasury name (fallback: dao_id).
    treasuries.sort_by(|a, b| {
        b.is_member.cmp(&a.is_member).then_with(|| {
            let a_name = a
                .config
                .name
                .as_deref()
                .map(str::to_lowercase)
                .unwrap_or_else(|| a.dao_id.to_string().to_lowercase());
            let b_name = b
                .config
                .name
                .as_deref()
                .map(str::to_lowercase)
                .unwrap_or_else(|| b.dao_id.to_string().to_lowercase());
            a_name.cmp(&b_name)
        })
    });

    Ok(Json(treasuries))
}

pub async fn save_user_treasury(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(payload): Json<SaveUserTreasuryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if user.account_id != payload.account_id.as_str() {
        return Err((
            StatusCode::FORBIDDEN,
            "You are not allowed to save this treasury".to_string(),
        ));
    }

    ensure_managed_treasury(&state, &payload.dao_id).await?;

    save_user_treasury_in_db(
        &state.db_pool,
        payload.account_id.as_str(),
        payload.dao_id.as_str(),
    )
    .await
    .map_err(|e| {
        tracing::error!(
            "Failed to save treasury {} for user {}: {}",
            payload.dao_id,
            payload.account_id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to save treasury".to_string(),
        )
    })?;

    Ok(StatusCode::OK)
}

pub async fn hide_user_treasury(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(payload): Json<HideUserTreasuryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if user.account_id != payload.account_id.as_str() {
        return Err((
            StatusCode::FORBIDDEN,
            "You are not allowed to hide this treasury".to_string(),
        ));
    }

    let hidden = payload.hidden.unwrap_or(true);

    ensure_managed_treasury(&state, &payload.dao_id).await?;

    set_user_treasury_hidden_in_db(
        &state.db_pool,
        payload.account_id.as_str(),
        payload.dao_id.as_str(),
        hidden,
    )
    .await
    .map_err(|e| {
        tracing::error!(
            "Failed to update hidden state for treasury {} and user {}: {}",
            payload.dao_id,
            payload.account_id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update treasury visibility".to_string(),
        )
    })?;

    Ok(StatusCode::OK)
}

pub async fn remove_user_treasury(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(payload): Json<RemoveUserTreasuryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if user.account_id != payload.account_id.as_str() {
        return Err((
            StatusCode::FORBIDDEN,
            "You are not allowed to remove this treasury".to_string(),
        ));
    }

    remove_user_treasury_in_db(
        &state.db_pool,
        payload.account_id.as_str(),
        payload.dao_id.as_str(),
    )
    .await
    .map_err(|e| {
        tracing::error!(
            "Failed to remove saved treasury {} for user {}: {}",
            payload.dao_id,
            payload.account_id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to remove saved treasury".to_string(),
        )
    })?;

    Ok(StatusCode::OK)
}

async fn save_user_treasury_in_db(
    pool: &sqlx::PgPool,
    account_id: &str,
    dao_id: &str,
) -> Result<(), sqlx::Error> {
    register_new_dao(pool, dao_id).await?;

    sqlx::query!(
        r#"
        INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
        VALUES ($1, $2, false, true, false)
        ON CONFLICT (dao_id, account_id) DO UPDATE SET
            is_saved = true,
            is_hidden = false
        "#,
        dao_id,
        account_id
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn set_user_treasury_hidden_in_db(
    pool: &sqlx::PgPool,
    account_id: &str,
    dao_id: &str,
    hidden: bool,
) -> Result<(), sqlx::Error> {
    register_new_dao(pool, dao_id).await?;

    sqlx::query!(
        r#"
        INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
        VALUES ($1, $2, false, false, $3)
        ON CONFLICT (dao_id, account_id) DO UPDATE SET
            is_hidden = $3
        "#,
        dao_id,
        account_id,
        hidden
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn remove_user_treasury_in_db(
    pool: &sqlx::PgPool,
    account_id: &str,
    dao_id: &str,
) -> Result<(), sqlx::Error> {
    // If this is a pure saved guest row (non-policy), removing saved treasury should
    // remove the entire row so it disappears from the user's list.
    sqlx::query!(
        r#"
        DELETE FROM dao_members
        WHERE dao_id = $1
          AND account_id = $2
          AND is_policy_member = false
        "#,
        dao_id,
        account_id
    )
    .execute(pool)
    .await?;

    // If the user is an actual policy member, keep the row but clear saved flag.
    sqlx::query!(
        r#"
        UPDATE dao_members
        SET is_saved = false
        WHERE dao_id = $1
          AND account_id = $2
          AND is_policy_member = true
        "#,
        dao_id,
        account_id
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::create_routes;
    use crate::utils::test_utils::{build_test_state, issue_auth_cookie, seed_policy_member, send};
    use serde_json::json;
    use sqlx::PgPool;

    const USER: &str = "alice.near";
    const MANAGED_DAO: &str = "managed.sputnik-dao.near";
    const UNMANAGED_DAO: &str = "public.sputnik-dao.near";

    fn managed_only_state(pool: PgPool) -> Arc<AppState> {
        let mut state = build_test_state(pool);
        state.env_vars.managed_treasuries_only = true;
        Arc::new(state)
    }

    /// A DAO known only from the factory mirror: `daos` + `dao_members`, no `monitored_accounts`.
    async fn seed_unmanaged_member(pool: &PgPool, dao_id: &str, account_id: &str) {
        sqlx::query("INSERT INTO daos (dao_id, is_dirty, source) VALUES ($1, false, 'factory')")
            .bind(dao_id)
            .execute(pool)
            .await
            .expect("seed factory dao");
        sqlx::query(
            "INSERT INTO dao_members (dao_id, account_id, is_policy_member) VALUES ($1, $2, true)",
        )
        .bind(dao_id)
        .bind(account_id)
        .execute(pool)
        .await
        .expect("seed dao member");
    }

    async fn dao_exists(pool: &PgPool, dao_id: &str) -> bool {
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM daos WHERE dao_id = $1)")
            .bind(dao_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn managed_only_rows_exclude_untracked_daos(pool: PgPool) {
        seed_unmanaged_member(&pool, UNMANAGED_DAO, USER).await;
        seed_policy_member(&pool, MANAGED_DAO, USER).await;

        let all = fetch_user_treasury_rows(&pool, USER, false, false)
            .await
            .unwrap();
        assert_eq!(
            all.iter().map(|r| r.dao_id.as_str()).collect::<Vec<_>>(),
            vec![MANAGED_DAO, UNMANAGED_DAO],
            "default mode lists every membership"
        );

        let managed = fetch_user_treasury_rows(&pool, USER, false, true)
            .await
            .unwrap();
        assert_eq!(
            managed
                .iter()
                .map(|r| r.dao_id.as_str())
                .collect::<Vec<_>>(),
            vec![MANAGED_DAO],
            "managed-only mode drops DAOs without a monitored_accounts row"
        );
        assert!(managed[0].is_member);
        assert!(!managed[0].is_confidential);
    }

    #[sqlx::test]
    async fn managed_only_save_rejects_untracked_dao_without_registering_it(pool: PgPool) {
        let state = managed_only_state(pool.clone());
        let cookie = issue_auth_cookie(&pool, &state, USER).await;
        let app = create_routes(state);

        let (status, body) = send(
            app,
            "POST",
            "/api/user/treasuries/save".to_string(),
            &cookie,
            Some(json!({ "accountId": USER, "daoId": UNMANAGED_DAO })),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND, "unexpected body: {body}");
        assert!(
            !dao_exists(&pool, UNMANAGED_DAO).await,
            "rejected save must not register the DAO for policy sync"
        );
    }

    #[sqlx::test]
    async fn managed_only_save_and_hide_work_for_tracked_dao(pool: PgPool) {
        sqlx::query("INSERT INTO monitored_accounts (account_id) VALUES ($1)")
            .bind(MANAGED_DAO)
            .execute(&pool)
            .await
            .unwrap();
        let state = managed_only_state(pool.clone());
        let cookie = issue_auth_cookie(&pool, &state, USER).await;
        let app = create_routes(state);

        let (status, body) = send(
            app.clone(),
            "POST",
            "/api/user/treasuries/save".to_string(),
            &cookie,
            Some(json!({ "accountId": USER, "daoId": MANAGED_DAO })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected body: {body}");

        let (status, body) = send(
            app,
            "POST",
            "/api/user/treasuries/hide".to_string(),
            &cookie,
            Some(json!({ "accountId": USER, "daoId": MANAGED_DAO, "hidden": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected body: {body}");

        let rows = fetch_user_treasury_rows(&pool, USER, true, true)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_saved);
        assert!(rows[0].is_hidden);
    }

    #[sqlx::test]
    async fn test_save_user_treasury_creates_saved_visible_row(pool: PgPool) -> sqlx::Result<()> {
        save_user_treasury_in_db(&pool, "alice.near", "guest.sputnik-dao.near").await?;

        let row = sqlx::query!(
            r#"
            SELECT is_policy_member, is_saved, is_hidden
            FROM dao_members
            WHERE dao_id = 'guest.sputnik-dao.near' AND account_id = 'alice.near'
            "#
        )
        .fetch_one(&pool)
        .await?;

        assert!(
            !row.is_policy_member,
            "Saved guest should not be policy member"
        );
        assert!(row.is_saved, "Saved flag should be true");
        assert!(!row.is_hidden, "Saved treasury should be visible");

        Ok(())
    }

    #[sqlx::test]
    async fn test_hide_user_treasury_hides_existing_saved_row(pool: PgPool) -> sqlx::Result<()> {
        sqlx::query!(
            r#"
            INSERT INTO daos (dao_id, is_dirty, source)
            VALUES ('guest-hide.sputnik-dao.near', true, 'manual')
            "#
        )
        .execute(&pool)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ('guest-hide.sputnik-dao.near', 'alice.near', false, true, false)
            "#
        )
        .execute(&pool)
        .await?;

        set_user_treasury_hidden_in_db(&pool, "alice.near", "guest-hide.sputnik-dao.near", true)
            .await?;

        let row = sqlx::query!(
            r#"
            SELECT is_saved, is_hidden
            FROM dao_members
            WHERE dao_id = 'guest-hide.sputnik-dao.near' AND account_id = 'alice.near'
            "#
        )
        .fetch_one(&pool)
        .await?;

        assert!(row.is_saved, "Hide should not clear saved flag");
        assert!(row.is_hidden, "Treasury should be hidden");

        Ok(())
    }

    #[sqlx::test]
    async fn test_remove_saved_guest_treasury_deletes_non_member_row(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        sqlx::query!(
            r#"
            INSERT INTO daos (dao_id, is_dirty, source)
            VALUES ('guest-remove.sputnik-dao.near', true, 'manual')
            "#
        )
        .execute(&pool)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ('guest-remove.sputnik-dao.near', 'alice.near', false, true, false)
            "#
        )
        .execute(&pool)
        .await?;

        remove_user_treasury_in_db(&pool, "alice.near", "guest-remove.sputnik-dao.near").await?;

        let count = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) as "count!"
            FROM dao_members
            WHERE dao_id = 'guest-remove.sputnik-dao.near' AND account_id = 'alice.near'
            "#
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(count, 0, "Guest saved row should be deleted");

        Ok(())
    }

    #[sqlx::test]
    async fn test_remove_saved_member_treasury_keeps_member_row(pool: PgPool) -> sqlx::Result<()> {
        sqlx::query!(
            r#"
            INSERT INTO daos (dao_id, is_dirty, source)
            VALUES ('member-remove.sputnik-dao.near', true, 'factory')
            "#
        )
        .execute(&pool)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ('member-remove.sputnik-dao.near', 'alice.near', true, true, false)
            "#
        )
        .execute(&pool)
        .await?;

        remove_user_treasury_in_db(&pool, "alice.near", "member-remove.sputnik-dao.near").await?;

        let row = sqlx::query!(
            r#"
            SELECT is_policy_member, is_saved
            FROM dao_members
            WHERE dao_id = 'member-remove.sputnik-dao.near' AND account_id = 'alice.near'
            "#
        )
        .fetch_one(&pool)
        .await?;
        assert!(row.is_policy_member, "Policy member row should remain");
        assert!(!row.is_saved, "Saved flag should be cleared");

        Ok(())
    }
}

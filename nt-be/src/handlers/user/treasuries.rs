use crate::handlers::treasury::config::{TreasuryConfig, fetch_treasury_config};
use crate::services::register_new_dao;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTreasuriesQuery {
    pub account_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Treasury {
    pub dao_id: AccountId,
    pub config: TreasuryConfig,
    pub is_member: bool,
    pub is_saved: bool,
    pub is_hidden: bool,
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

pub async fn get_user_treasuries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserTreasuriesQuery>,
) -> Result<Json<Vec<Treasury>>, (StatusCode, String)> {
    let account_id = params.account_id.clone();

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    // Query local database for user's DAO memberships and saved treasuries.
    // Hidden entries are returned as well; frontend decides visibility.
    let rows = sqlx::query!(
        r#"
        SELECT
            dao_id,
            is_policy_member AS "is_member!",
            is_saved AS "is_saved!",
            is_hidden AS "is_hidden!"
        FROM dao_members
        WHERE account_id = $1
          AND (is_policy_member = true OR is_saved = true)
        ORDER BY dao_id
        "#,
        &account_id
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Error fetching user DAOs from database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch user DAOs".to_string(),
        )
    })?;

    if rows.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let mut treasuries = Vec::new();

    for row in rows {
        let dao_id_str = row.dao_id;
        let dao_id: AccountId = match dao_id_str.parse() {
            Ok(id) => id,
            Err(e) => {
                log::warn!("Invalid DAO ID in database: {} - {}", dao_id_str, e);
                continue;
            }
        };

        let config = fetch_treasury_config(&state, &dao_id, None).await?;

        treasuries.push(Treasury {
            dao_id,
            config,
            is_member: row.is_member,
            is_saved: row.is_saved,
            is_hidden: row.is_hidden,
        })
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
    Json(payload): Json<SaveUserTreasuryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    save_user_treasury_in_db(
        &state.db_pool,
        payload.account_id.as_str(),
        payload.dao_id.as_str(),
    )
    .await
    .map_err(|e| {
        log::error!(
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
    Json(payload): Json<HideUserTreasuryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let hidden = payload.hidden.unwrap_or(true);

    set_user_treasury_hidden_in_db(
        &state.db_pool,
        payload.account_id.as_str(),
        payload.dao_id.as_str(),
        hidden,
    )
    .await
    .map_err(|e| {
        log::error!(
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
    Json(payload): Json<RemoveUserTreasuryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    remove_user_treasury_in_db(
        &state.db_pool,
        payload.account_id.as_str(),
        payload.dao_id.as_str(),
    )
    .await
    .map_err(|e| {
        log::error!(
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
    use sqlx::PgPool;

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

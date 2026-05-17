use crate::AppState;
use crate::auth::{AuthError, jwt::hash_token, verify_jwt};
use crate::handlers::treasury::policy::fetch_treasury_policy_cached;
use axum::http::StatusCode;
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::CookieJar;
use near_account_id::AccountIdRef;
use near_api::AccountId;
use serde_json::Value;
use std::sync::Arc;

/// The name of the auth cookie
pub const AUTH_COOKIE_NAME: &str = "auth_token";

/// Authenticated user extracted from JWT cookie
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub account_id: AccountId,
}

impl AuthUser {
    /// Verify this user is a policy member of the given DAO.
    ///
    /// Returns `AuthError::NotDaoMember` (403) if not found in `dao_members`
    /// with `is_policy_member = true`.
    pub async fn verify_dao_member(
        &self,
        db: &sqlx::PgPool,
        dao_id: &AccountIdRef,
    ) -> Result<(), AuthError> {
        let member = sqlx::query!(
            r#"
            SELECT 1 AS ok FROM dao_members
            WHERE account_id = $1 AND dao_id = $2 AND is_policy_member = true
            "#,
            self.account_id.as_str(),
            dao_id.as_str()
        )
        .fetch_optional(db)
        .await
        .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

        member.map(|_| ()).ok_or(AuthError::NotDaoMember)
    }

    fn role_has_action_permission(role: &Value, action_name: &str) -> bool {
        role.get("permissions")
            .and_then(Value::as_array)
            .map(|permissions| {
                permissions.iter().any(|permission| {
                    permission
                        .as_str()
                        .and_then(|permission| permission.split(':').nth(1))
                        .map(|action| action == action_name || action == "*")
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    fn role_applies_to_account(role: &Value, account_id: &AccountIdRef) -> bool {
        let Some(kind) = role.get("kind") else {
            return false;
        };

        if kind.as_str() == Some("Everyone") {
            return true;
        }

        kind.get("Group")
            .and_then(Value::as_array)
            .map(|group| {
                group
                    .iter()
                    .any(|member| member.as_str() == Some(account_id.as_str()))
            })
            .unwrap_or(false)
    }

    fn policy_allows_action_for_account(
        policy: &Value,
        account_id: &AccountIdRef,
        action_name: &str,
    ) -> bool {
        policy
            .get("roles")
            .and_then(Value::as_array)
            .map(|roles| {
                roles.iter().any(|role| {
                    Self::role_has_action_permission(role, action_name)
                        && Self::role_applies_to_account(role, account_id)
                })
            })
            .unwrap_or(false)
    }

    pub async fn fetch_dao_policy(
        &self,
        state: &Arc<AppState>,
        dao_id: &AccountIdRef,
    ) -> Result<Value, (StatusCode, String)> {
        fetch_treasury_policy_cached(state, dao_id, None).await
    }

    pub fn verify_can_perform_action_with_policy(
        &self,
        policy: &Value,
        dao_id: &AccountIdRef,
        action_name: &str,
    ) -> Result<(), (StatusCode, String)> {
        if Self::policy_allows_action_for_account(policy, &self.account_id, action_name) {
            Ok(())
        } else {
            Err((
                StatusCode::FORBIDDEN,
                format!(
                    "Account '{}' is not allowed to perform '{}' for treasury '{}'",
                    self.account_id, action_name, dao_id
                ),
            ))
        }
    }

    /// Verify this user can perform a policy action according to on-chain roles.
    ///
    /// This honors `Everyone` roles and wildcard permissions (e.g. `*:*`).
    pub async fn verify_can_perform_action(
        &self,
        state: &Arc<AppState>,
        dao_id: &AccountIdRef,
        action_name: &str,
    ) -> Result<(), (StatusCode, String)> {
        let policy = self.fetch_dao_policy(state, dao_id).await?;

        self.verify_can_perform_action_with_policy(&policy, dao_id, action_name)
    }

    /// Verify this user can submit proposals according to on-chain policy.
    pub async fn verify_can_add_proposal(
        &self,
        state: &Arc<AppState>,
        dao_id: &AccountIdRef,
    ) -> Result<(), (StatusCode, String)> {
        self.verify_can_perform_action(state, dao_id, "AddProposal")
            .await
    }

    pub async fn verify_member_if_confidential(
        &self,
        db: &sqlx::PgPool,
        dao_id: &AccountIdRef,
    ) -> Result<bool, (StatusCode, String)> {
        OptionalAuthUser::verify_member_if_confidential(
            &OptionalAuthUser(Some(self.clone())),
            db,
            dao_id,
        )
        .await
    }
}

impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        // Extract the cookie jar
        let jar = CookieJar::from_request_parts(parts, state)
            .await
            .map_err(|_| AuthError::MissingToken)?;

        // Get the auth token from cookie
        let token = jar
            .get(AUTH_COOKIE_NAME)
            .map(|c| c.value().to_string())
            .ok_or(AuthError::MissingToken)?;

        // Verify the JWT signature and expiry
        let claims = verify_jwt(&token, state.env_vars.jwt_secret.as_bytes())?;

        // Check if the session is still valid (not revoked)
        let token_hash = hash_token(&token);
        let session = sqlx::query!(
            r#"
            SELECT id FROM user_sessions 
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
            "#,
            token_hash
        )
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

        if session.is_none() {
            return Err(AuthError::RevokedToken);
        }

        Ok(AuthUser {
            account_id: claims.sub.parse()?,
        })
    }
}

/// Optional auth user - doesn't fail if no token is present
#[derive(Debug, Clone)]
pub struct OptionalAuthUser(pub Option<AuthUser>);

impl OptionalAuthUser {
    /// If the given account is a confidential treasury, verify that the caller
    /// is an authenticated DAO policy member.
    ///
    /// Returns `true` if the account is confidential, `false` otherwise.
    /// Fails with 401/403 when confidential but the caller is missing or not a member.
    pub async fn verify_member_if_confidential(
        &self,
        db: &sqlx::PgPool,
        dao_id: &AccountIdRef,
    ) -> Result<bool, (StatusCode, String)> {
        let row = sqlx::query!(
            r#"
            SELECT
                ma.is_confidential_account,
                dm.account_id AS "member_account_id?"
            FROM monitored_accounts ma
            LEFT JOIN dao_members dm
                ON dm.dao_id = ma.account_id
                AND dm.account_id = $2
                AND dm.is_policy_member = true
            WHERE ma.account_id = $1
            "#,
            dao_id.as_str(),
            self.0.as_ref().map(|u| u.account_id.as_str()),
        )
        .fetch_optional(db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to check confidential status: {}", e),
            )
        })?;

        let is_confidential = row
            .as_ref()
            .and_then(|r| r.is_confidential_account)
            .unwrap_or(false);

        if !is_confidential {
            return Ok(false);
        }

        if self.0.is_none() {
            return Err((
                StatusCode::UNAUTHORIZED,
                "Authentication required for confidential treasury".to_string(),
            ));
        }

        if row.unwrap().member_account_id.is_none() {
            return Err((StatusCode::FORBIDDEN, "Not a DAO member".to_string()));
        }

        Ok(true)
    }
}

impl FromRequestParts<Arc<AppState>> for OptionalAuthUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        match AuthUser::from_request_parts(parts, state).await {
            Ok(user) => Ok(OptionalAuthUser(Some(user))),
            Err(_) => Ok(OptionalAuthUser(None)),
        }
    }
}

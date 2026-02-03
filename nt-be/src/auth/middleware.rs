use crate::AppState;
use crate::auth::{AuthError, jwt::hash_token, verify_jwt};
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::CookieJar;
use std::sync::Arc;

/// The name of the auth cookie
pub const AUTH_COOKIE_NAME: &str = "auth_token";

/// Authenticated user extracted from JWT cookie
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub account_id: String,
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
            account_id: claims.sub,
        })
    }
}

/// Optional auth user - doesn't fail if no token is present
#[derive(Debug, Clone)]
pub struct OptionalAuthUser(pub Option<AuthUser>);

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

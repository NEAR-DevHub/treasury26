use crate::AppState;
use crate::auth::resolve_auth::verify_resolve_auth;
use crate::auth::{AuthError, AuthUser, create_jwt, jwt::hash_token, middleware::AUTH_COOKIE_NAME};
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use base64::Engine;
use near_api::AccountId;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::sync::Arc;

/// NEP-641 authorization purpose used for dApp authentication.
const AUTH_PURPOSE: &str = "PROVE_OWNERSHIP";
/// Bare recipient bound into the authorization. Must match the value the
/// frontend passes to `wallet.resolveAuth(...)`.
const AUTH_RECIPIENT: &str = "Trezu App";

/// Response body for challenge creation.
///
/// The `payload` is the unique message the wallet authorizes (via NEP-641
/// `resolveAuth`). It is echoed back unchanged inside the resolved
/// authorization, which the backend matches against the issued challenge.
#[derive(Debug, Serialize)]
pub struct ChallengeResponse {
    pub payload: String,
}

/// Request body for login.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub account_id: AccountId,
    /// JSON-stringified NEP-641 authorization blob produced by `resolveAuth`.
    pub authorization: String,
}

/// Response body for /me endpoint
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub account_id: String,
    pub terms_accepted: bool,
    pub has_accepted_v1_terms: bool,
}

#[derive(Debug, FromRow)]
struct UserTermsRow {
    id: uuid::Uuid,
    account_id: String,
    v1_terms_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    v2_terms_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Create a new authentication challenge for the account.
///
/// Issues a unique, human-readable `payload` that the wallet authorizes via
/// NEP-641 `resolveAuth`. The payload is stored (in the `nonce` column) so the
/// resolved authorization can be matched against it on login and consumed once.
pub async fn create_challenge(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ChallengeResponse>, AuthError> {
    // A fresh random component guarantees uniqueness per session and prevents
    // replay; the timestamp makes the prompt meaningful in the wallet UI.
    let mut random = [0u8; 16];
    rand::rng().fill_bytes(&mut random);
    let request_id = base64::engine::general_purpose::STANDARD.encode(random);
    let issued_at = chrono::Utc::now().to_rfc3339();
    let payload = format!("Login to Trezu initiated at {issued_at} with request ID: {request_id}");

    // Store the challenge payload (its bytes) so login can match and consume it.
    sqlx::query!(
        r#"
        INSERT INTO auth_challenges (account_id, nonce, expires_at)
        VALUES ('', $1, NOW() + INTERVAL '15 minutes')
        "#,
        payload.as_bytes()
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    // Clean up expired challenges
    sqlx::query!("DELETE FROM auth_challenges WHERE expires_at < NOW()")
        .execute(&state.db_pool)
        .await
        .ok(); // Ignore errors for cleanup

    Ok(Json(ChallengeResponse { payload }))
}

/// Login with a NEP-641 authorization.
///
/// Resolves the authorization on-chain (recursively, via `w_resolve_auth`, with
/// NEP-413 fallback for regular accounts), then confirms the resolved payload
/// matches a challenge this backend issued and consumes it.
pub async fn login(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<(CookieJar, Json<MeResponse>), AuthError> {
    // NEP-641: resolve the authorization to its unwrapped payload. The account
    // contract (or NEP-413 fallback) is the authority for whether the holder is
    // willing to authenticate.
    let payload = verify_resolve_auth(
        &state.network,
        request.account_id.as_str(),
        AUTH_PURPOSE,
        AUTH_RECIPIENT,
        &request.authorization,
    )
    .await
    .map_err(AuthError::InvalidSignature)?;

    // Confirm the resolved payload is a challenge we issued (not expired) and
    // consume it atomically so it can't be replayed.
    let consumed = sqlx::query!(
        r#"
        DELETE FROM auth_challenges
        WHERE nonce = $1 AND expires_at > NOW()
        RETURNING id
        "#,
        payload.as_bytes()
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    if consumed.is_none() {
        return Err(AuthError::ChallengeNotFound);
    }

    let user = sqlx::query_as::<_, UserTermsRow>(
        r#"
        INSERT INTO users (account_id)
        VALUES ($1)
        ON CONFLICT (account_id) DO UPDATE SET updated_at = NOW()
        RETURNING id, account_id, v1_terms_accepted_at, v2_terms_accepted_at
        "#,
    )
    .bind(request.account_id.as_str())
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    // Create JWT
    let jwt_result = create_jwt(
        &user.account_id,
        state.env_vars.jwt_secret.as_bytes(),
        state.env_vars.jwt_expiry_hours,
    )?;

    // Store the session in the database
    sqlx::query!(
        r#"
        INSERT INTO user_sessions (user_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
        "#,
        user.id,
        jwt_result.token_hash,
        jwt_result.expires_at
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    // Clean up expired sessions periodically
    sqlx::query!("DELETE FROM user_sessions WHERE expires_at < NOW()")
        .execute(&state.db_pool)
        .await
        .ok();

    // Create auth cookie
    let cookie = Cookie::build((AUTH_COOKIE_NAME, jwt_result.token))
        .path("/")
        .http_only(true)
        .secure(true) // Only send over HTTPS
        .same_site(SameSite::Strict)
        .max_age(time::Duration::hours(
            state.env_vars.jwt_expiry_hours as i64,
        ))
        .build();

    let jar = jar.add(cookie);

    Ok((
        jar,
        Json(MeResponse {
            account_id: user.account_id,
            terms_accepted: user.v2_terms_accepted_at.is_some(),
            has_accepted_v1_terms: user.v1_terms_accepted_at.is_some(),
        }),
    ))
}

/// Accept terms of service
pub async fn accept_terms(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
) -> Result<impl IntoResponse, AuthError> {
    sqlx::query!(
        r#"
        UPDATE users
        SET
            v2_terms_accepted_at = NOW(),
            updated_at = NOW()
        WHERE account_id = $1
        "#,
        auth_user.account_id.as_str()
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    Ok(StatusCode::OK)
}

/// Get current user info
pub async fn get_me(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
) -> Result<Json<MeResponse>, AuthError> {
    let user = sqlx::query_as::<_, UserTermsRow>(
        r#"
        SELECT id, account_id, v1_terms_accepted_at, v2_terms_accepted_at
        FROM users
        WHERE account_id = $1
        "#,
    )
    .bind(auth_user.account_id.as_str())
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    match user {
        Some(user) => Ok(Json(MeResponse {
            account_id: user.account_id,
            terms_accepted: user.v2_terms_accepted_at.is_some(),
            has_accepted_v1_terms: user.v1_terms_accepted_at.is_some(),
        })),
        None => Err(AuthError::InvalidToken("User not found".to_string())),
    }
}

/// Logout - revoke session and clear the auth cookie
pub async fn logout(State(state): State<Arc<AppState>>, jar: CookieJar) -> impl IntoResponse {
    // Get the token from the cookie and revoke the session
    if let Some(token_cookie) = jar.get(AUTH_COOKIE_NAME) {
        let token_hash = hash_token(token_cookie.value());

        // Revoke the session
        sqlx::query!(
            "UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1",
            token_hash
        )
        .execute(&state.db_pool)
        .await
        .ok();
    }

    let cookie = Cookie::build((AUTH_COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(0))
        .build();

    (jar.add(cookie), StatusCode::OK)
}

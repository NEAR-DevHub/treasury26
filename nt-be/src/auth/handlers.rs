use crate::AppState;
use crate::auth::{AuthError, AuthUser, create_jwt, jwt::hash_token, middleware::AUTH_COOKIE_NAME};
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use near_api::signer::NEP413Payload;
use near_api::types::Signature;
use near_api::types::json::Base64VecU8;
use near_api::{AccountId, PublicKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Request body for creating a challenge
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeRequest {
    pub account_id: String,
}

/// Response body for challenge creation
#[derive(Debug, Serialize)]
pub struct ChallengeResponse {
    pub nonce: String, // Base64 encoded
}

/// Request body for login
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub account_id: AccountId,
    pub public_key: PublicKey,
    pub signature: Base64VecU8,
    pub message: String,
    pub nonce: Base64VecU8,
    pub recipient: String,
    #[serde(default)]
    pub callback_url: Option<String>,
}

/// Response body for /me endpoint
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub account_id: String,
    pub terms_accepted: bool,
}

/// Create a new authentication challenge (nonce) for the account
pub async fn create_challenge(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, AuthError> {
    // Generate a 32-byte random nonce
    let mut nonce = [0u8; 32];
    rand::rng().fill_bytes(&mut nonce);

    // Store the challenge in the database
    sqlx::query!(
        r#"
        INSERT INTO auth_challenges (account_id, nonce, expires_at)
        VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
        "#,
        request.account_id,
        &nonce[..]
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    // Clean up expired challenges
    sqlx::query!("DELETE FROM auth_challenges WHERE expires_at < NOW()")
        .execute(&state.db_pool)
        .await
        .ok(); // Ignore errors for cleanup

    let nonce_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce);

    Ok(Json(ChallengeResponse { nonce: nonce_b64 }))
}

/// Login with a signed message
pub async fn login(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<(CookieJar, Json<MeResponse>), AuthError> {
    // Verify the challenge exists and hasn't expired
    let challenge = sqlx::query!(
        r#"
        SELECT id FROM auth_challenges
        WHERE account_id = $1 AND nonce = $2 AND expires_at > NOW()
        "#,
        request.account_id.as_str(),
        &request.nonce.0[..]
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    if challenge.is_none() {
        return Err(AuthError::ChallengeNotFound);
    }

    // Delete the used challenge
    sqlx::query!(
        "DELETE FROM auth_challenges WHERE account_id = $1 AND nonce = $2",
        request.account_id.as_str(),
        &request.nonce.0[..]
    )
    .execute(&state.db_pool)
    .await
    .ok();

    let signature_type = request.public_key.key_type();
    let signature = Signature::from_parts(signature_type, &request.signature.0)
        .map_err(|e| AuthError::InvalidSignature(format!("Invalid signature: {}", e)))?;
    let verified = NEP413Payload {
        message: request.message,
        nonce: request.nonce.0[..32]
            .try_into()
            .map_err(|_| AuthError::InvalidNonce("Nonce must be 32 bytes".to_string()))?,
        recipient: request.recipient,
        callback_url: request.callback_url,
    }
    .verify(
        &request.account_id,
        request.public_key,
        &signature,
        &state.network,
    )
    .await
    .map_err(|e| AuthError::InvalidSignature(e.to_string()))?;

    if !verified {
        return Err(AuthError::InvalidSignature(
            "Signature verification failed".to_string(),
        ));
    }

    let user = sqlx::query!(
        r#"
        INSERT INTO users (account_id)
        VALUES ($1)
        ON CONFLICT (account_id) DO UPDATE SET updated_at = NOW()
        RETURNING id, account_id, terms_accepted_at
        "#,
        request.account_id.as_str()
    )
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
            terms_accepted: user.terms_accepted_at.is_some(),
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
        UPDATE users SET terms_accepted_at = NOW(), updated_at = NOW()
        WHERE account_id = $1
        "#,
        auth_user.account_id
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
    let user = sqlx::query!(
        r#"
        SELECT account_id, terms_accepted_at FROM users
        WHERE account_id = $1
        "#,
        auth_user.account_id
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AuthError::DatabaseError(e.to_string()))?;

    match user {
        Some(user) => Ok(Json(MeResponse {
            account_id: user.account_id,
            terms_accepted: user.terms_accepted_at.is_some(),
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

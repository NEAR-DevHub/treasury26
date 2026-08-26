use near_account_id::AccountIdRef;
use near_api::AccountId;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::observability::sanitize_sensitive_text;
use crate::services::{CredentialScope, TokenBundle};

pub mod balances;
pub mod bronze;
pub mod bulk_activation;
pub mod bulk_payment_confirm;
pub mod bulk_payment_prepare;
pub mod generate_intent;
pub mod gold;
pub mod history_refresh;
pub mod prepare_auth;
pub mod types;

pub use bronze::store::link_intent_to_history_event;
pub use bronze::{
    HistoryEvent, HistoryPage, fetch_history, fetch_history_with_token,
    trigger_confidential_history_refresh,
};
pub use gold::{
    mark_gold_dirty_for_history_event, mark_gold_dirty_tx, project_confidential_gold_for_dao,
    refresh_gold_metadata_for_intent, snapshot_confidential_dao_balances,
};
pub use types::{ConfidentialTxType, HistoryStatus, accounts_equal, bare_account};

/// Request body for authenticating a DAO with the 1Click confidential intents API.
/// The signed data is a NEP-413 signature over an empty-intents auth payload,
/// produced by v1.signer (MPC chain-signatures) on behalf of the DAO.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateRequest {
    /// The DAO account ID (e.g., "mydao.sputnik-dao.near")
    pub dao_id: AccountId,
    /// The signed authentication data
    pub signed_data: serde_json::Value,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AuthenticateResponse {
    access_token: String,
    /// Access token lifetime in seconds
    expires_in: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateResult {
    pub success: bool,
    pub dao_id: AccountId,
    pub expires_in: i64,
}

/// Bundle of token columns loaded from DB.
struct StoredTokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

struct RefreshOutcome {
    access_token: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    /// False when the stored access token was still valid and is returned
    /// as-is — nothing to persist.
    refreshed: bool,
}

/// Generic JWT-refresh core. Takes already-loaded tokens and the account label
/// (for log/error messages). Returns the access token to use plus whether a
/// new one was minted; the caller persists refreshed credentials.
async fn refresh_jwt_inner(
    state: &AppState,
    account_label: &str,
    tokens: StoredTokens,
) -> Result<RefreshOutcome, (StatusCode, String)> {
    let access_token = tokens.access_token.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            format!("No JWT stored for {}", account_label),
        )
    })?;

    let refresh_token = tokens.refresh_token.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            format!("No refresh token for {}", account_label),
        )
    })?;

    // If access token is still valid (more than 60s remaining), return it as-is.
    if let Some(expires_at) = tokens.expires_at {
        let remaining = expires_at.signed_duration_since(chrono::Utc::now());
        if remaining.num_seconds() > 60 {
            return Ok(RefreshOutcome {
                access_token,
                expires_at,
                refreshed: false,
            });
        }
    }

    let url = format!("{}/v0/auth/refresh", state.env_vars.confidential_api_url);
    let mut req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json");
    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }
    let response = req
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Error refreshing JWT for {}: {}", account_label, e);
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to refresh JWT: {}", e),
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        let sanitized_error = sanitize_sensitive_text(&error_text);
        tracing::error!(
            "JWT refresh failed for {} ({}): {}",
            account_label,
            status,
            sanitized_error
        );
        return Err((
            StatusCode::UNAUTHORIZED,
            format!(
                "JWT refresh failed for {}: {}",
                account_label, sanitized_error
            ),
        ));
    }

    let auth_response: AuthenticateResponse = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse refresh response: {}", e),
        )
    })?;

    let new_expires_at = chrono::Utc::now() + chrono::Duration::seconds(auth_response.expires_in);
    Ok(RefreshOutcome {
        access_token: auth_response.access_token,
        expires_at: new_expires_at,
        refreshed: true,
    })
}

/// Load-refresh-persist cycle for one credential scope, entirely through the
/// credential store. The refresh token is never rotated by 1Click's refresh
/// endpoint, so the re-encrypted bundle keeps the stored one.
async fn refresh_scoped_jwt(
    state: &AppState,
    account_id: &str,
    scope: CredentialScope,
    label: &str,
) -> Result<String, (StatusCode, String)> {
    let store = state.confidential_credentials();
    let creds = store
        .load(account_id, scope)
        .await
        .map_err(|e| {
            tracing::error!("Failed to load JWT for {}: {}", label, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to load JWT for {}: {}", label, e),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("DAO {} not found in monitored_accounts", account_id),
            )
        })?;

    let attempt = refresh_jwt_inner(
        state,
        label,
        StoredTokens {
            access_token: creds.access_token.clone(),
            refresh_token: creds.refresh_token.clone(),
            expires_at: creds.expires_at,
        },
    )
    .await;

    let (outcome, refresh_token) = match attempt {
        Ok(outcome) => (outcome, creds.refresh_token),
        // A rejected envelope refresh token can be a deploy-overlap artifact:
        // the previous release re-authenticated and wrote the new pair to the
        // legacy plaintext columns only, leaving the envelope stale. Retry
        // with the legacy refresh token and re-encrypt it on success. This
        // path dies with the plaintext columns (legacy_refresh_token becomes
        // permanently None).
        Err((status, message)) => {
            let legacy_refresh = creds.legacy_refresh_token.filter(|legacy| {
                status == StatusCode::UNAUTHORIZED
                    && creds.from_envelope
                    && creds.refresh_token.is_some()
                    && Some(legacy) != creds.refresh_token.as_ref()
            });
            let Some(legacy_refresh) = legacy_refresh else {
                return Err((status, message));
            };
            tracing::warn!(
                "Envelope refresh token rejected for {}; retrying with legacy refresh token",
                label
            );
            let outcome = refresh_jwt_inner(
                state,
                label,
                StoredTokens {
                    access_token: creds.access_token,
                    refresh_token: Some(legacy_refresh.clone()),
                    expires_at: None,
                },
            )
            .await?;
            (outcome, Some(legacy_refresh))
        }
    };

    if !outcome.refreshed {
        return Ok(outcome.access_token);
    }

    let bundle = TokenBundle {
        access_token: outcome.access_token.clone(),
        refresh_token: refresh_token
            .expect("refresh_jwt_inner cannot mint a token without a refresh token"),
    };
    store
        .store_refreshed(account_id, scope, &bundle, outcome.expires_at)
        .await
        .map_err(|e| {
            tracing::error!("Failed to update JWT for {}: {}", label, e);
            // A stale-generation fence rejection is transient during a key
            // rotation rollout: retryable, and a retry lands on a pod
            // holding the promoted keyring.
            let status = if e.is_retryable() {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, format!("Failed to update JWT tokens: {}", e))
        })?;

    tracing::info!("Refreshed confidential JWT for {}", label);
    Ok(outcome.access_token)
}

/// Refresh the DAO-side confidential JWT.
pub async fn refresh_dao_jwt(
    state: &AppState,
    dao_id: &AccountIdRef,
) -> Result<String, (StatusCode, String)> {
    let label = format!("DAO {}", dao_id);
    refresh_scoped_jwt(state, dao_id.as_str(), CredentialScope::Dao, &label).await
}

/// Refresh the bulk-payment-subaccount confidential JWT.
pub async fn refresh_bulk_dao_jwt(
    state: &AppState,
    dao_id: &str,
) -> Result<String, (StatusCode, String)> {
    let label = format!("bulk-payment for DAO {}", dao_id);
    refresh_scoped_jwt(state, dao_id, CredentialScope::BulkPayment, &label).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sqlx::PgPool;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::services::TokenKeyring;
    use crate::utils::test_utils::build_test_state;

    const DAO: &str = "heal-test.sputnik-dao.near";
    const KEYRING: &str =
        r#"{"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}"#;

    fn keyring() -> TokenKeyring {
        TokenKeyring::parse(KEYRING).expect("valid test keyring")
    }

    async fn seed_dao_with_envelope(
        pool: &PgPool,
        envelope_refresh: &str,
        plaintext_access: Option<&str>,
        plaintext_refresh: &str,
    ) {
        sqlx::query(
            "INSERT INTO monitored_accounts (account_id, is_confidential_account) VALUES ($1, TRUE)",
        )
        .bind(DAO)
        .execute(pool)
        .await
        .expect("seed account");

        let envelope = keyring()
            .encrypt(
                DAO,
                CredentialScope::Dao,
                &TokenBundle {
                    access_token: "stale-access".to_string(),
                    refresh_token: envelope_refresh.to_string(),
                },
            )
            .expect("encrypt seed envelope");
        sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET confidential_credentials_enc = $1,
                confidential_token_expires_at = NOW() - INTERVAL '1 minute',
                confidential_access_token = $2,
                confidential_refresh_token = $3
            WHERE account_id = $4
            "#,
        )
        .bind(envelope)
        .bind(plaintext_access)
        .bind(plaintext_refresh)
        .bind(DAO)
        .execute(pool)
        .await
        .expect("seed tokens");
    }

    fn state_with_mock(pool: PgPool, mock: &MockServer) -> AppState {
        let mut state = build_test_state(pool);
        state.env_vars.confidential_api_url = mock.uri();
        state.confidential_keyring = Some(Arc::new(keyring()));
        state
    }

    #[sqlx::test]
    async fn refresh_heals_stale_envelope_with_legacy_refresh_token(pool: PgPool) {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v0/auth/refresh"))
            .and(body_string_contains("dead-refresh"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"error": "invalid refresh token"})),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v0/auth/refresh"))
            .and(body_string_contains("live-refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"accessToken": "healed-access", "expiresIn": 3600}),
            ))
            .expect(1)
            .mount(&mock)
            .await;

        // Plaintext access is NULL (partial row), so read-time healing can't
        // apply and the refresh-401 fallback is what must recover.
        seed_dao_with_envelope(&pool, "dead-refresh", None, "live-refresh").await;
        let state = state_with_mock(pool, &mock);

        let token = refresh_dao_jwt(&state, AccountIdRef::new(DAO).unwrap())
            .await
            .expect("legacy fallback heals the stale envelope");
        assert_eq!(token, "healed-access");

        let creds = state
            .confidential_credentials()
            .load(DAO, CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(creds.from_envelope);
        assert_eq!(creds.access_token.as_deref(), Some("healed-access"));
        assert_eq!(creds.refresh_token.as_deref(), Some("live-refresh"));
    }

    #[sqlx::test]
    async fn refresh_does_not_retry_when_legacy_token_matches(pool: PgPool) {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v0/auth/refresh"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"error": "invalid refresh token"})),
            )
            .expect(1)
            .mount(&mock)
            .await;

        // Plaintext identical to the envelope: no divergence to heal, and
        // the fallback must not retry the same dead token.
        seed_dao_with_envelope(&pool, "dead-refresh", Some("stale-access"), "dead-refresh").await;
        let state = state_with_mock(pool, &mock);

        let err = refresh_dao_jwt(&state, AccountIdRef::new(DAO).unwrap())
            .await
            .expect_err("identical legacy token must not be retried");
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }
}

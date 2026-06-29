//! Test utilities for balance change tests
//!
//! Provides common setup functions used across multiple test modules.

#[cfg(test)]
use crate::AppState;

#[cfg(test)]
use crate::utils::cache::Cache;

#[cfg(test)]
use near_account_id::AccountIdRef;

#[cfg(test)]
use near_api::{NetworkConfig, RPCEndpoint, Signer};

#[cfg(test)]
use std::sync::Once;

#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
static INIT: Once = Once::new();

/// Load environment files in the correct order for tests
///
/// Loads `.env` first for base config (API keys etc.), then `.env.test` (no override).
/// Uses plain `from_filename` (not `override`) to avoid changing DATABASE_URL at runtime,
/// which would conflict with `#[sqlx::test]` macro that reads DATABASE_URL at compile time.
///
/// NOTE: When recording RPC fixtures, set `DATABASE_URL` to the test database explicitly
/// (via the recording script) so tests that shortcut via DB data still hit the RPC.
#[cfg(test)]
pub fn load_test_env() {
    INIT.call_once(|| {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();
    });
}

/// Initialize app state with loaded environment variables
///
/// This creates a minimal AppState for unit tests that only need
/// network configuration (no database connection or migrations).
/// Use this for tests that query the blockchain but don't need DB.
#[cfg(test)]
pub async fn init_test_state() -> AppState {
    load_test_env();

    let env_vars = crate::utils::env::EnvVars::default();
    // Create a dummy pool that won't be used in unit tests
    // Tests that need DB should use sqlx::test macro instead
    let db_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(1))
        .connect_lazy(&env_vars.database_url)
        .expect("Failed to create lazy pool");

    build_test_state(db_pool)
}

/// Initialize app state with a provided database pool.
///
/// Use this in `#[sqlx::test]` tests that receive a pool from the macro
/// but also need a full AppState (e.g. for integration tests that take AppState).
#[cfg(test)]
pub fn build_test_state(db_pool: sqlx::PgPool) -> AppState {
    use std::sync::Arc;

    load_test_env();

    let env_vars = crate::utils::env::EnvVars::default();
    let http_client = reqwest::Client::new();

    // Initialize price service with DeFiLlama provider (free, no API key required)
    let base_url = &env_vars.defillama_api_base_url;
    let defillama_client =
        crate::services::DeFiLlamaClient::with_base_url(http_client.clone(), base_url.clone());
    let price_service = crate::services::PriceLookupService::new(db_pool.clone(), defillama_client);

    // Create network configs first (needed for transfer hint service)
    // Respects NEAR_RPC_URL / NEAR_ARCHIVAL_RPC_URL env vars for proxy/cache override
    let rpc_url = env_vars
        .near_rpc_url
        .clone()
        .unwrap_or_else(|| "https://rpc.mainnet.fastnear.com/".to_string());
    let archival_rpc_url = env_vars
        .near_archival_rpc_url
        .clone()
        .unwrap_or_else(|| "https://archival-rpc.mainnet.fastnear.com/".to_string());

    let network = NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(rpc_url.parse().unwrap())
                .with_api_key(env_vars.fastnear_api_key.clone()),
        ],
        ..NetworkConfig::mainnet()
    };

    let archival_network = NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(archival_rpc_url.parse().unwrap())
                .with_api_key(env_vars.fastnear_api_key.clone()),
        ],
        ..NetworkConfig::mainnet()
    };

    // Create transfer hint service if enabled
    let transfer_hint_service = if env_vars.transfer_hints_enabled {
        use crate::handlers::balance_changes::transfer_hints::{
            TransferHintService, fastnear::FastNearProvider,
        };
        let provider = if let Some(base_url) = &env_vars.transfer_hints_base_url {
            FastNearProvider::with_base_url(archival_network.clone(), base_url.clone())
        } else {
            FastNearProvider::new(archival_network.clone())
        }
        .with_api_key(&env_vars.fastnear_api_key);
        Some(TransferHintService::new().with_provider(provider))
    } else {
        None
    };

    AppState {
        cache: Cache::new(),
        telegram_client: crate::utils::telegram::TelegramClient::default(),
        http_client,
        signer: Signer::from_secret_key(env_vars.signer_key.clone())
            .expect("Failed to create signer."),
        bulk_payment_signer: Signer::from_secret_key(env_vars.bulk_payment_signer.clone())
            .expect("Failed to create bulk payment signer"),
        signer_id: env_vars.signer_id.clone(),
        network,
        archival_network,
        bulk_payment_contract_id: env_vars.bulk_payment_contract_id.clone(),
        env_vars,
        db_pool,
        price_service,
        transfer_hint_service: transfer_hint_service.map(Arc::new),
        goldsky_pool: None,
        neardata_client: None,
    }
}

/// A minimal SputnikDAO policy granting `account_id` the given `<kind>:<action>` permissions via a
/// group role — enough for `AuthUser::verify_can_perform_action` to evaluate.
#[cfg(test)]
pub fn policy_granting(account_id: &str, permissions: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "roles": [{
            "name": "test-role",
            "kind": { "Group": [account_id] },
            "permissions": permissions,
        }],
    })
}

/// Seed the treasury-policy cache so policy-gated handlers (`verify_can_perform_action`) can be
/// unit-tested without an RPC `get_policy` call. Uses the same `treasury_policy_cache_key` the fetch
/// path builds, so the seeded key can't desync from the lookup; the seeded policy is then served
/// from cache and the RPC closure never runs.
#[cfg(test)]
pub async fn seed_treasury_policy(
    state: &AppState,
    dao_id: &AccountIdRef,
    policy: serde_json::Value,
) {
    let key = crate::handlers::treasury::policy::treasury_policy_cache_key(dao_id, 0);
    state.cache.short_term.insert(key, policy).await;
}

// --- Treasury handler-test scaffolding ----------------------------------------------------------
// Shared by the policy-gated handler tests (`proposal_templates`, `custom_requests`): an `AppState`
// wrapper, the DAO/user seeding, an auth cookie, and a one-shot request helper. Hoisted here once a
// third copy appeared, so a new handler test imports these instead of re-rolling the same recipe.

#[cfg(test)]
pub const DAO_ID: &str = "test-dao.sputnik-dao.near";
#[cfg(test)]
pub const USER_ACCOUNT_ID: &str = "member.near";

#[cfg(test)]
pub fn test_state(pool: sqlx::PgPool) -> std::sync::Arc<AppState> {
    std::sync::Arc::new(build_test_state(pool))
}

/// Seed `account_id` as a policy member of `dao_id` — enough for the membership-gated reads.
#[cfg(test)]
pub async fn seed_policy_member(pool: &sqlx::PgPool, dao_id: &str, account_id: &str) {
    sqlx::query!(
        "INSERT INTO monitored_accounts (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
        dao_id,
    )
    .execute(pool)
    .await
    .expect("seed monitored account");

    sqlx::query!(
        "INSERT INTO daos (dao_id) VALUES ($1) ON CONFLICT (dao_id) DO NOTHING",
        dao_id,
    )
    .execute(pool)
    .await
    .expect("seed dao");

    sqlx::query!(
        r#"
        INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
        VALUES ($1, $2, true, false, false)
        ON CONFLICT (dao_id, account_id) DO UPDATE SET is_policy_member = true
        "#,
        dao_id,
        account_id,
    )
    .execute(pool)
    .await
    .expect("seed policy member");
}

/// Seed a policy member who also holds the on-chain `ChangePolicy` permission — i.e. someone
/// allowed to author templates / flip the custom-requests flag.
#[cfg(test)]
pub async fn seed_change_policy_member(
    state: &std::sync::Arc<AppState>,
    pool: &sqlx::PgPool,
    dao_id: &str,
    account_id: &str,
) {
    seed_policy_member(pool, dao_id, account_id).await;
    let dao: near_api::AccountId = dao_id.parse().expect("valid dao id");
    seed_treasury_policy(
        state,
        &dao,
        policy_granting(account_id, &["*:ChangePolicy"]),
    )
    .await;
}

/// Create a user + session for `account_id` and return its auth `cookie` header value.
#[cfg(test)]
pub async fn issue_auth_cookie(
    pool: &sqlx::PgPool,
    state: &std::sync::Arc<AppState>,
    account_id: &str,
) -> String {
    use crate::auth::{create_jwt, middleware::AUTH_COOKIE_NAME};

    let user_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO users (account_id) VALUES ($1) ON CONFLICT (account_id) DO UPDATE SET updated_at = NOW() RETURNING id",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .expect("create test user");

    let jwt = create_jwt(
        account_id,
        state.env_vars.jwt_secret.as_bytes(),
        state.env_vars.jwt_expiry_hours,
    )
    .expect("create JWT");

    sqlx::query!(
        "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        user_id,
        jwt.token_hash,
        jwt.expires_at,
    )
    .execute(pool)
    .await
    .expect("create session");

    format!("{AUTH_COOKIE_NAME}={}", jwt.token)
}

#[cfg(test)]
pub async fn response_text(response: axum::response::Response) -> String {
    use axum::body::to_bytes;
    String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body")
            .to_vec(),
    )
    .expect("utf-8 body")
}

/// Send one request through the router and return `(status, body text)`.
#[cfg(test)]
pub async fn send(
    app: axum::Router,
    method: &str,
    uri: String,
    cookie: &str,
    body: Option<serde_json::Value>,
) -> (axum::http::StatusCode, String) {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie);
    let body = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let resp = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    (status, response_text(resp).await)
}

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Contract};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    auth::{AuthUser, OptionalAuthUser},
    handlers::treasury::config::fetch_contract_treasury_config,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileQuery {
    pub account_id: String,
    /// When provided and the caller is an authenticated DAO member, the address
    /// book name for this treasury will be returned as `addressBookName`.
    pub dao_id: Option<AccountId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProfileQuery {
    pub account_ids: String, // Comma-separated account IDs
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileData {
    pub name: Option<String>,
    pub address_book_name: Option<String>,
    pub image: Option<serde_json::Value>,
    pub background_image: Option<String>,
    pub description: Option<String>,
    pub linktree: Option<serde_json::Value>,
    pub tags: Option<serde_json::Value>,
    pub is_in_address_book: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileRequest {
    /// Display name override stored in `user_profiles`. Empty string clears it.
    pub display_name: Option<String>,
    /// Avatar image URL stored in `user_profiles.avatar_url` (IPFS/https).
    /// `null` / empty explicitly clears the avatar (including NEAR Social fallback).
    /// Clients should always send the current form value on save.
    pub avatar_url: Option<String>,
}

const SOCIAL_DB_CONTRACT: &str = "social.near";
const MAX_DISPLAY_NAME_LEN: usize = 100;
/// IPFS/https avatar URLs are short; keep a modest cap for safety.
const MAX_AVATAR_URL_LEN: usize = 2_000;

fn internal_error(context: &str, e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("{context}: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error".to_string(),
    )
}

/// Display name is required on profile update (non-empty after trim).
fn normalize_display_name(raw: Option<String>) -> Result<String, (StatusCode, String)> {
    let name = raw
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "displayName is required".to_string(),
            )
        })?;

    if name.chars().count() > MAX_DISPLAY_NAME_LEN {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("displayName must be at most {MAX_DISPLAY_NAME_LEN} characters"),
        ));
    }

    Ok(name)
}

/// Normalize avatar for a profile update write.
///
/// - `None` / empty → empty string (explicit clear; do not fall back to NEAR Social)
/// - non-empty → must be `https://`
///
/// Distinct from SQL `NULL` on the column, which means "never set locally" and
/// still allows the NEAR Social image.
fn normalize_avatar_url_for_update(raw: Option<String>) -> Result<String, (StatusCode, String)> {
    let Some(url) = raw.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) else {
        return Ok(String::new());
    };

    if url.len() > MAX_AVATAR_URL_LEN {
        return Err((
            StatusCode::BAD_REQUEST,
            "avatarUrl is too large".to_string(),
        ));
    }

    if !url.starts_with("https://") {
        return Err((
            StatusCode::BAD_REQUEST,
            "avatarUrl must be an https:// URL".to_string(),
        ));
    }

    Ok(url)
}

/// Fetch profile data from NEAR Social DB for a single account
async fn fetch_profile(state: &Arc<AppState>, account_id: &str) -> Result<ProfileData, String> {
    let keys = vec![format!("{}/profile/**", account_id)];

    let result: serde_json::Value = Contract(SOCIAL_DB_CONTRACT.parse().unwrap())
        .call_function("get", serde_json::json!({ "keys": keys }))
        .read_only()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching profile for {}: {}", account_id, e);
            format!("Failed to fetch profile: {}", e)
        })?
        .data;

    // Extract profile data from the result
    let profile = result
        .get(account_id)
        .and_then(|v| v.get("profile"))
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let profile_data = ProfileData {
        name: profile
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from),
        address_book_name: None,
        image: profile.get("image").cloned(),
        background_image: profile
            .get("backgroundImage")
            .and_then(|v| v.as_str())
            .map(String::from),
        description: profile
            .get("description")
            .and_then(|v| v.as_str())
            .map(String::from),
        linktree: profile.get("linktree").cloned(),
        tags: profile.get("tags").cloned(),
        is_in_address_book: false,
    };

    Ok(profile_data)
}

fn empty_profile() -> ProfileData {
    ProfileData {
        name: None,
        address_book_name: None,
        image: None,
        background_image: None,
        description: None,
        linktree: None,
        tags: None,
        is_in_address_book: false,
    }
}

/// Social is best-effort. A DAO with no NEAR Social profile (or a transient RPC
/// failure) must still receive local / treasury branding below.
async fn load_social_profile(state: &Arc<AppState>, account_id: &str) -> ProfileData {
    let cache_key = CacheKey::new("profile").with(account_id).build();
    let state_clone = state.clone();
    let account_id = account_id.to_string();

    match state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            fetch_profile(&state_clone, &account_id).await.map_err(|e| {
                tracing::warn!("Error fetching social profile for {account_id}: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, e)
            })
        })
        .await
    {
        Ok(profile) => profile,
        Err(e) => {
            tracing::warn!("Social profile unavailable, using empty profile: {e:?}");
            empty_profile()
        }
    }
}

async fn apply_treasury_branding(
    state: &Arc<AppState>,
    profile: &mut ProfileData,
    account_id: &str,
) {
    // One round-trip: local settings (if any) + whether this is a monitored treasury.
    let row = match sqlx::query!(
        r#"
        SELECT
            ts.display_name,
            ts.flag_logo,
            (ma.account_id IS NOT NULL) AS "is_treasury!"
        FROM (SELECT $1::text AS account_id) AS q
        LEFT JOIN treasury_settings ts ON ts.account_id = q.account_id
        LEFT JOIN monitored_accounts ma ON ma.account_id = q.account_id
        "#,
        account_id
    )
    .fetch_one(&state.db_pool)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("Failed to load treasury branding for {account_id}: {e}");
            return;
        }
    };

    apply_treasury_settings_to_profile(profile, row.display_name, row.flag_logo);

    if profile
        .name
        .as_ref()
        .is_some_and(|name| !name.trim().is_empty())
    {
        return;
    }

    if !row.is_treasury {
        return;
    }

    let Ok(treasury_id) = account_id.parse::<AccountId>() else {
        return;
    };

    // Settings already checked — only need on-chain config (cached RPC), not another
    // pass through fetch_treasury_config which would re-query the same tables.
    if let Ok(config) = fetch_contract_treasury_config(state, &treasury_id, None).await {
        if let Some(name) = config
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
        {
            profile.name = Some(name);
        }
        if let Some(logo) = config.metadata.and_then(|m| m.flag_logo) {
            apply_treasury_settings_to_profile(profile, None, Some(logo));
        }
    }
}

fn apply_local_profile_overrides(
    profile: &mut ProfileData,
    display_name: Option<String>,
    avatar_url: Option<String>,
) {
    if display_name
        .as_ref()
        .is_some_and(|name| !name.trim().is_empty())
    {
        profile.name = display_name;
    }

    // NULL column = unset locally → keep NEAR Social image.
    // Empty string = user cleared avatar → hide Social image too.
    // Non-empty = local override URL.
    match avatar_url {
        None => {}
        Some(url) if url.trim().is_empty() => {
            profile.image = None;
        }
        Some(url) => {
            profile.image = Some(serde_json::json!({ "url": url.trim() }));
        }
    }
}

/// Apply DAO branding from `treasury_settings` onto a profile response.
///
/// Display name always wins when non-empty (treasury branding is the source of
/// truth for DAO accounts). Logo fills image when present as https or raw CID.
fn apply_treasury_settings_to_profile(
    profile: &mut ProfileData,
    display_name: Option<String>,
    flag_logo: Option<String>,
) {
    if let Some(name) = display_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
    {
        profile.name = Some(name);
    }

    if let Some(logo) = flag_logo
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        let url = if logo.starts_with("https://") || logo.starts_with("http://") {
            logo
        } else {
            format!("https://ipfs.near.social/ipfs/{logo}")
        };
        profile.image = Some(serde_json::json!({ "url": url }));
    }
}

/// Main handler for single profile endpoint
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    auth: OptionalAuthUser,
    Query(params): Query<ProfileQuery>,
) -> Result<Json<ProfileData>, (StatusCode, String)> {
    let account_id = params.account_id.trim().to_string();

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let mut profile = load_social_profile(&state, &account_id).await;

    // If the caller is authenticated and provided a dao_id, check whether the
    // address has an address book entry in that treasury.
    if let (Some(user), Some(dao_id)) = (auth.0, params.dao_id)
        && user
            .verify_dao_member(&state.db_pool, &dao_id)
            .await
            .is_ok()
    {
        let ab_name = sqlx::query_scalar!(
            "SELECT name FROM address_book WHERE dao_id = $1 AND address = $2",
            dao_id.as_str(),
            params.account_id.trim()
        )
        .fetch_optional(&state.db_pool)
        .await
        .unwrap_or(None);

        if let Some(name) = ab_name {
            profile.address_book_name = Some(name);
            profile.is_in_address_book = true;
        }
    }

    // Local profile fields override NEAR Social; query after cache so they stay fresh.
    if let Ok(Some(row)) = sqlx::query!(
        "SELECT display_name, avatar_url FROM user_profiles WHERE account_id = $1",
        params.account_id.trim()
    )
    .fetch_optional(&state.db_pool)
    .await
    {
        apply_local_profile_overrides(&mut profile, row.display_name, row.avatar_url);
    }

    // DAO branding must match /api/treasury/config for the same account.
    apply_treasury_branding(&state, &mut profile, params.account_id.trim()).await;

    Ok(Json(profile))
}

/// `PUT /api/user/profile` — update the authenticated user's local profile.
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(body): Json<UpdateProfileRequest>,
) -> Result<Json<ProfileData>, (StatusCode, String)> {
    let display_name = normalize_display_name(body.display_name)?;
    let avatar_url = normalize_avatar_url_for_update(body.avatar_url)?;
    let account_id = auth_user.account_id.as_str();

    sqlx::query!(
        r#"
        INSERT INTO user_profiles (account_id, display_name, avatar_url)
        VALUES ($1, $2, $3)
        ON CONFLICT (account_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW()
        "#,
        account_id,
        &display_name,
        avatar_url
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| internal_error("Failed to upsert user profile", e))?;

    // Return the merged profile the same way GET does (Social + local overrides).
    let mut profile = fetch_profile(&state, account_id)
        .await
        .unwrap_or_else(|_| empty_profile());
    apply_local_profile_overrides(&mut profile, Some(display_name), Some(avatar_url));

    Ok(Json(profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_display_name_trims_and_requires_value() {
        assert_eq!(
            normalize_display_name(Some("  harry  ".into())).unwrap(),
            "harry"
        );
        assert_eq!(
            normalize_display_name(Some("   ".into())).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            normalize_display_name(None).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn normalize_display_name_rejects_too_long() {
        let long = "a".repeat(MAX_DISPLAY_NAME_LEN + 1);
        let err = normalize_display_name(Some(long)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn normalize_avatar_url_for_update_accepts_https_and_clears() {
        assert_eq!(
            normalize_avatar_url_for_update(Some("https://ipfs.near.social/ipfs/cid".into()))
                .unwrap(),
            "https://ipfs.near.social/ipfs/cid"
        );
        assert_eq!(
            normalize_avatar_url_for_update(Some("".into())).unwrap(),
            ""
        );
        assert_eq!(normalize_avatar_url_for_update(None).unwrap(), "");
    }

    #[test]
    fn normalize_avatar_url_for_update_rejects_invalid() {
        let err =
            normalize_avatar_url_for_update(Some("http://example.com/a.png".into())).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        let err =
            normalize_avatar_url_for_update(Some("data:image/png;base64,abc".into())).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        let err = normalize_avatar_url_for_update(Some("javascript:alert(1)".into())).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn apply_local_overrides_prefers_local_fields() {
        let mut profile = ProfileData {
            name: Some("social".into()),
            address_book_name: None,
            image: Some(serde_json::json!({ "ipfs_cid": "old" })),
            background_image: None,
            description: None,
            linktree: None,
            tags: None,
            is_in_address_book: false,
        };

        apply_local_profile_overrides(
            &mut profile,
            Some("harry".into()),
            Some("https://ipfs.near.social/ipfs/cid".into()),
        );

        assert_eq!(profile.name.as_deref(), Some("harry"));
        assert_eq!(
            profile.image,
            Some(serde_json::json!({ "url": "https://ipfs.near.social/ipfs/cid" }))
        );
    }

    #[test]
    fn apply_local_overrides_empty_avatar_clears_social_image() {
        let mut profile = ProfileData {
            name: Some("social".into()),
            address_book_name: None,
            image: Some(serde_json::json!({ "ipfs_cid": "social-cid" })),
            background_image: None,
            description: None,
            linktree: None,
            tags: None,
            is_in_address_book: false,
        };

        apply_local_profile_overrides(&mut profile, None, Some("".into()));
        assert_eq!(profile.image, None);

        // Unset local avatar (SQL NULL) keeps Social.
        profile.image = Some(serde_json::json!({ "ipfs_cid": "social-cid" }));
        apply_local_profile_overrides(&mut profile, None, None);
        assert_eq!(
            profile.image,
            Some(serde_json::json!({ "ipfs_cid": "social-cid" }))
        );
    }

    #[test]
    fn apply_treasury_settings_overrides_name_and_logo() {
        let mut profile = ProfileData {
            name: Some("social".into()),
            address_book_name: None,
            image: None,
            background_image: None,
            description: None,
            linktree: None,
            tags: None,
            is_in_address_book: false,
        };

        apply_treasury_settings_to_profile(
            &mut profile,
            Some("  Treasury One  ".into()),
            Some("bafytestcid".into()),
        );

        assert_eq!(profile.name.as_deref(), Some("Treasury One"));
        assert_eq!(
            profile.image,
            Some(serde_json::json!({
                "url": "https://ipfs.near.social/ipfs/bafytestcid"
            }))
        );
    }
}

#[cfg(test)]
mod integration_tests {
    use crate::{AppState, routes::create_routes, utils::test_utils::build_test_state};
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::Value;
    use sqlx::PgPool;
    use std::sync::Arc;
    use tower::ServiceExt;

    const TREASURY_ID: &str = "branded-dao.sputnik-dao.near";
    const TREASURY_NAME: &str = "Ergosum Private";

    fn test_state(pool: PgPool) -> Arc<AppState> {
        Arc::new(build_test_state(pool))
    }

    async fn seed_treasury_settings(pool: &PgPool, account_id: &str, display_name: &str) {
        sqlx::query(
            "INSERT INTO monitored_accounts (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
        )
        .bind(account_id)
        .execute(pool)
        .await
        .expect("Should insert monitored account for branded treasury");

        sqlx::query(
            r#"
            INSERT INTO treasury_settings (account_id, display_name)
            VALUES ($1, $2)
            ON CONFLICT (account_id) DO UPDATE
            SET display_name = EXCLUDED.display_name
            "#,
        )
        .bind(account_id)
        .bind(display_name)
        .execute(pool)
        .await
        .expect("Should insert treasury_settings row");
    }

    async fn response_json(response: axum::response::Response) -> (StatusCode, Value) {
        let status = response.status();
        let body = String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("Should read response body")
                .to_vec(),
        )
        .expect("Response body should be valid UTF-8");
        let json: Value = serde_json::from_str(&body)
            .unwrap_or_else(|_| panic!("Response should be JSON. Body: {body}"));
        (status, json)
    }

    /// Regression for #1328: a treasury with Settings → General display name must
    /// surface that name on GET /api/user/profile, not a raw address.
    #[sqlx::test]
    async fn get_profile_returns_treasury_settings_display_name(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state);
        seed_treasury_settings(&pool, TREASURY_ID, TREASURY_NAME).await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/user/profile?accountId={TREASURY_ID}"))
                    .body(Body::empty())
                    .expect("Should build profile request"),
            )
            .await
            .expect("Profile request should complete");

        let (status, body) = response_json(response).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "Profile should succeed. Body: {body}"
        );
        assert_eq!(
            body["name"].as_str(),
            Some(TREASURY_NAME),
            "GET /api/user/profile must return treasury_settings.display_name"
        );
    }

    /// Monitored treasury with no `treasury_settings` row falls back to on-chain
    /// `get_config` name (via the short-term cache in tests).
    #[sqlx::test]
    async fn get_profile_falls_back_to_on_chain_treasury_name(pool: PgPool) {
        use crate::handlers::treasury::config::{
            TreasuryConfigFromContract, treasury_config_cache_key,
        };
        use near_account_id::AccountId;

        const ON_CHAIN_NAME: &str = "On-Chain Branded DAO";

        let state = test_state(pool.clone());
        sqlx::query(
            "INSERT INTO monitored_accounts (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
        )
        .bind(TREASURY_ID)
        .execute(&pool)
        .await
        .expect("Should insert monitored account without treasury_settings");

        let treasury_id: AccountId = TREASURY_ID.parse().expect("Valid treasury id");
        let cache_key = treasury_config_cache_key(&treasury_id, 0);
        let cached = serde_json::to_value(TreasuryConfigFromContract {
            metadata: None,
            name: Some(ON_CHAIN_NAME.to_string()),
            purpose: None,
        })
        .expect("Should serialize on-chain config for cache");
        state.cache.short_term.insert(cache_key, cached).await;

        let app = create_routes(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/user/profile?accountId={TREASURY_ID}"))
                    .body(Body::empty())
                    .expect("Should build profile request"),
            )
            .await
            .expect("Profile request should complete");

        let (status, body) = response_json(response).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "Profile should succeed. Body: {body}"
        );
        assert_eq!(
            body["name"].as_str(),
            Some(ON_CHAIN_NAME),
            "Without treasury_settings, profile must fall back to on-chain config.name"
        );
    }
}

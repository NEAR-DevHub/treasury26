use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Contract, Reference, types::json::U64};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;
use std::sync::Arc;

use crate::auth::AuthUser;
use crate::utils::base64json::Base64Json;
use crate::utils::cache::CacheKey;
use crate::{AppState, utils::cache::CacheTier};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTreasuryConfigQuery {
    pub treasury_id: AccountId,
    pub at_before: Option<U64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryMetadata {
    #[serde(default)]
    pub primary_color: Option<String>,
    #[serde(default)]
    pub flag_logo: Option<String>,
}

#[serde_as]
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryConfigFromContract {
    #[serde_as(as = "Base64Json<TreasuryMetadata>")]
    pub metadata: Option<TreasuryMetadata>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryConfig {
    pub metadata: Option<TreasuryMetadata>,
    pub name: Option<String>,
    pub purpose: Option<String>,
    pub is_confidential: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Treasury {
    pub dao_id: String,
    pub config: TreasuryConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTreasurySettingsRequest {
    pub treasury_id: AccountId,
    pub display_name: String,
    pub flag_logo: Option<String>,
    pub primary_color: Option<String>,
}

const MAX_DISPLAY_NAME_LEN: usize = 100;
const MAX_FLAG_LOGO_LEN: usize = 2_000;
const MAX_PRIMARY_COLOR_LEN: usize = 32;

fn internal_error(context: &str, e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("{context}: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error".to_string(),
    )
}

struct LocalTreasurySettings {
    display_name: Option<String>,
    flag_logo: Option<String>,
    primary_color: Option<String>,
}

/// When a `treasury_settings` row exists, prefer its fields over on-chain config.
/// Null/empty logo or color in the row clears the on-chain value.
/// Empty display name keeps the on-chain name.
fn apply_local_treasury_settings(config: &mut TreasuryConfig, local: LocalTreasurySettings) {
    if let Some(name) = local
        .display_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
    {
        config.name = Some(name);
    }

    let metadata = config.metadata.get_or_insert(TreasuryMetadata {
        primary_color: None,
        flag_logo: None,
    });

    metadata.flag_logo = local
        .flag_logo
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    metadata.primary_color = local
        .primary_color
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
}

type NormalizedTreasurySettings = (String, Option<String>, Option<String>);
type SettingsHttpError = (StatusCode, String);

fn normalize_settings_input(
    display_name: String,
    flag_logo: Option<String>,
    primary_color: Option<String>,
) -> Result<NormalizedTreasurySettings, SettingsHttpError> {
    let display_name = display_name.trim().to_string();
    if display_name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "displayName is required".to_string(),
        ));
    }
    if display_name.chars().count() > MAX_DISPLAY_NAME_LEN {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("displayName must be at most {MAX_DISPLAY_NAME_LEN} characters"),
        ));
    }

    let flag_logo = flag_logo
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let Some(logo) = &flag_logo {
        if logo.len() > MAX_FLAG_LOGO_LEN {
            return Err((StatusCode::BAD_REQUEST, "flagLogo is too long".to_string()));
        }
        if !(logo.starts_with("https://") || logo.starts_with("data:image/")) {
            return Err((
                StatusCode::BAD_REQUEST,
                "flagLogo must be a https:// or data:image/... URL".to_string(),
            ));
        }
    }

    let primary_color = primary_color
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let Some(color) = &primary_color {
        if color.len() > MAX_PRIMARY_COLOR_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                "primaryColor is too long".to_string(),
            ));
        }
        if !color.starts_with('#') {
            return Err((
                StatusCode::BAD_REQUEST,
                "primaryColor must be a hex color like #0953FF".to_string(),
            ));
        }
    }

    Ok((display_name, flag_logo, primary_color))
}

/// Fetch treasury config from contract with caching
///
/// - `at_before`: Optional timestamp in nanoseconds. If provided, fetches historical config.
pub async fn fetch_treasury_config(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    at_before: Option<u64>,
) -> Result<TreasuryConfig, (StatusCode, String)> {
    let at_before = at_before.unwrap_or(0);
    let cache_key = CacheKey::new("treasury-config")
        .with(treasury_id)
        .with(at_before)
        .build();

    let network = if at_before > 0 {
        state.archival_network.clone()
    } else {
        state.network.clone()
    };

    let result = {
        let treasury_id = treasury_id.clone();
        let state_clone = state.clone();

        state
            .cache
            .cached_contract_call(CacheTier::ShortTerm, cache_key, async move {
                let at = if at_before > 0 {
                    state_clone
                        .find_block_height(chrono::DateTime::<chrono::Utc>::from_timestamp_nanos(
                            at_before as i64,
                        ))
                        .await
                        .map(|at| Reference::AtBlock(at - 1))
                        .unwrap_or(Reference::Optimistic)
                } else {
                    Reference::Optimistic
                };
                Contract(treasury_id)
                    .call_function("get_config", ())
                    .read_only::<TreasuryConfigFromContract>()
                    .at(at)
                    .fetch_from(&network)
                    .await
                    .map(|r| r.data)
            })
            .await?
    };
    let is_confidential = sqlx::query_scalar!(
        "SELECT is_confidential_account FROM monitored_accounts WHERE account_id = $1",
        treasury_id.as_str()
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to check confidential status: {}", e),
        )
    })?;

    let mut config = TreasuryConfig {
        metadata: result.metadata,
        name: result.name,
        purpose: result.purpose,
        is_confidential: matches!(is_confidential, Some(Some(true))),
    };

    // Historical reads should reflect on-chain state only.
    if at_before == 0
        && let Ok(Some(row)) = sqlx::query!(
            r#"
            SELECT display_name, flag_logo, primary_color
            FROM treasury_settings
            WHERE account_id = $1
            "#,
            treasury_id.as_str()
        )
        .fetch_optional(&state.db_pool)
        .await
    {
        apply_local_treasury_settings(
            &mut config,
            LocalTreasurySettings {
                display_name: row.display_name,
                flag_logo: row.flag_logo,
                primary_color: row.primary_color,
            },
        );
    }

    Ok(config)
}

pub async fn get_treasury_config(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryConfigQuery>,
) -> Result<Json<TreasuryConfig>, (StatusCode, String)> {
    let at_before = params.at_before.map(|at| at.0);
    let config = fetch_treasury_config(&state, &params.treasury_id, at_before).await?;
    Ok(Json(config))
}

/// `PUT /api/treasury/config` — upsert local treasury branding settings (no on-chain proposal).
pub async fn update_treasury_settings(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(body): Json<UpdateTreasurySettingsRequest>,
) -> Result<Json<TreasuryConfig>, (StatusCode, String)> {
    auth_user
        .verify_dao_member_for_http(&state.db_pool, &body.treasury_id)
        .await?;

    let (display_name, flag_logo, primary_color) =
        normalize_settings_input(body.display_name, body.flag_logo, body.primary_color)?;

    sqlx::query!(
        r#"
        INSERT INTO treasury_settings (account_id, display_name, flag_logo, primary_color, updated_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            flag_logo = EXCLUDED.flag_logo,
            primary_color = EXCLUDED.primary_color,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        "#,
        body.treasury_id.as_str(),
        display_name,
        flag_logo,
        primary_color,
        auth_user.account_id.as_str()
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e
            && db_err.constraint() == Some("treasury_settings_account_id_fkey")
        {
            return (
                StatusCode::BAD_REQUEST,
                "Treasury is not registered".to_string(),
            );
        }
        internal_error("Failed to upsert treasury settings", e)
    })?;

    fetch_treasury_config(&state, &body.treasury_id, None)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_local_settings_overrides_on_chain() {
        let mut config = TreasuryConfig {
            name: Some("on-chain".into()),
            purpose: Some("purpose".into()),
            metadata: Some(TreasuryMetadata {
                primary_color: Some("#111111".into()),
                flag_logo: Some("https://example.com/old.png".into()),
            }),
            is_confidential: false,
        };

        apply_local_treasury_settings(
            &mut config,
            LocalTreasurySettings {
                display_name: Some("  Local Name  ".into()),
                flag_logo: Some("https://example.com/new.png".into()),
                primary_color: Some("#0953FF".into()),
            },
        );

        assert_eq!(config.name.as_deref(), Some("Local Name"));
        assert_eq!(
            config
                .metadata
                .as_ref()
                .and_then(|m| m.flag_logo.as_deref()),
            Some("https://example.com/new.png")
        );
        assert_eq!(
            config
                .metadata
                .as_ref()
                .and_then(|m| m.primary_color.as_deref()),
            Some("#0953FF")
        );
        assert_eq!(config.purpose.as_deref(), Some("purpose"));
    }

    #[test]
    fn apply_local_settings_empty_logo_clears() {
        let mut config = TreasuryConfig {
            name: Some("on-chain".into()),
            purpose: None,
            metadata: Some(TreasuryMetadata {
                primary_color: Some("#111111".into()),
                flag_logo: Some("https://example.com/old.png".into()),
            }),
            is_confidential: false,
        };

        apply_local_treasury_settings(
            &mut config,
            LocalTreasurySettings {
                display_name: None,
                flag_logo: Some("".into()),
                primary_color: Some("".into()),
            },
        );

        assert_eq!(config.name.as_deref(), Some("on-chain"));
        assert_eq!(
            config
                .metadata
                .as_ref()
                .and_then(|m| m.flag_logo.as_deref()),
            None
        );
        assert_eq!(
            config
                .metadata
                .as_ref()
                .and_then(|m| m.primary_color.as_deref()),
            None
        );
    }

    #[test]
    fn normalize_settings_input_validates() {
        let ok = normalize_settings_input(
            "  Treasury  ".into(),
            Some("https://ipfs.near.social/ipfs/cid".into()),
            Some("#0953FF".into()),
        )
        .unwrap();
        assert_eq!(ok.0, "Treasury");

        let err = normalize_settings_input("".into(), None, None).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        let err = normalize_settings_input("ok".into(), Some("ftp://x".into()), None).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }
}

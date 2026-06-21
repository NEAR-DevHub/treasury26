use std::{collections::HashMap, sync::Arc};

use axum::http::StatusCode;
use near_api::{AccountId, Contract};
use serde::{Deserialize, Serialize};
use sqlx::query_as;

use crate::{
    AppState,
    utils::{
        cache::{CacheKey, CacheTier},
        serde::{
            opt_u32_from_string_or_number, opt_u64_from_string_or_number,
            opt_u128_string_from_string_or_number,
        },
    },
};

#[derive(Deserialize, Serialize, Debug, Clone)]
pub(crate) struct FtLockupContractMetadata {
    pub token_account_id: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub(crate) struct FtLockupAccountData {
    pub deposited_amount: String,
    pub claimed_amount: String,
    pub unclaimed_amount: String,
    #[serde(default, deserialize_with = "opt_u64_from_string_or_number")]
    pub start_timestamp: Option<u64>,
    #[serde(default, deserialize_with = "opt_u64_from_string_or_number")]
    pub session_interval: Option<u64>,
    #[serde(default, deserialize_with = "opt_u32_from_string_or_number")]
    pub session_num: Option<u32>,
    #[serde(default, deserialize_with = "opt_u32_from_string_or_number")]
    pub last_claim_session: Option<u32>,
    #[serde(default, deserialize_with = "opt_u128_string_from_string_or_number")]
    pub release_per_session: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub(crate) struct FtLockupPosition {
    pub instance_id: String,
    pub token_account_id: String,
    pub deposited_amount: u128,
    pub claimed_amount: u128,
    pub unclaimed_amount: u128,
    pub start_timestamp: Option<u64>,
    pub session_interval: Option<u64>,
    pub session_num: Option<u32>,
    pub last_claim_session: Option<u32>,
    pub release_per_session: Option<u128>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub(crate) struct FtLockupListedAccount {
    pub account_id: String,
}

fn parse_u128_amount(value: &str) -> u128 {
    value.parse::<u128>().unwrap_or(0)
}

/// FT lockup lookup flow (backend-only):
/// 1) Fetch `ft-lockup.near` instances (`get_instances`) and cache for hours.
/// 2) For each instance, fetch `list_accounts` and cache for hours.
/// 3) Build/cache reverse index: `dao_account_id -> [instance_ids]` for hours.
/// 4) For current DAO, read matched instances from index.
/// 5) For each matched instance, fetch:
///    - `get_account(dao)` (short-term cache, live claimed/unclaimed values)
///    - `contract_metadata` (hours cache, token account id)
/// 6) Convert to portfolio buckets:
///    - total   = deposited - claimed
///    - locked  = deposited - claimed - unclaimed
///    - available = unclaimed
pub(crate) async fn fetch_ft_lockup_instance_ids(
    state: &Arc<AppState>,
) -> Result<Vec<String>, (StatusCode, String)> {
    tracing::info!("fetching registry instances");
    let cache_key = CacheKey::new("ft-lockup-instances").build();
    let state_clone = state.clone();

    state
        .cache
        .cached(CacheTier::VeryLongTerm, cache_key, async move {
            let ft_lockup_registry: AccountId = "ft-lockup.near".parse().map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Invalid ft-lockup registry account id: {}", e),
                )
            })?;

            let instances = Contract(ft_lockup_registry)
                .call_function("get_instances", serde_json::json!({}))
                .read_only::<Vec<(String, String)>>()
                .fetch_from(&state_clone.network)
                .await
                .map_err(|e| {
                    tracing::warn!("get_instances failed: {}", e);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to fetch FT lockup instances".to_string(),
                    )
                })?;

            let ids = instances
                .data
                .into_iter()
                .map(|(_, instance_id)| instance_id)
                .collect::<Vec<_>>();
            tracing::info!("registry instances fetched: {}", ids.len());

            Ok::<_, (StatusCode, String)>(ids)
        })
        .await
}

pub(crate) async fn fetch_ft_lockup_instance_accounts(
    state: &Arc<AppState>,
    instance_id: &str,
) -> Result<Vec<String>, (StatusCode, String)> {
    tracing::info!("list_accounts for instance={}", instance_id);
    let cache_key = CacheKey::new("ft-lockup-instance-accounts")
        .with(instance_id)
        .build();
    let state_clone = state.clone();
    let instance_id_owned = instance_id.to_string();

    state
        .cache
        .cached(CacheTier::VeryLongTerm, cache_key, async move {
            let instance_account: AccountId = instance_id_owned.parse().map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Invalid ft-lockup instance id: {}", e),
                )
            })?;

            let accounts = Contract(instance_account)
                .call_function("list_accounts", serde_json::json!({}))
                .read_only::<Vec<FtLockupListedAccount>>()
                .fetch_from(&state_clone.network)
                .await
                .map_err(|e| {
                    tracing::warn!(
                        "list_accounts failed for instance={}: {}",
                        instance_id_owned,
                        e
                    );
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to fetch FT lockup accounts".to_string(),
                    )
                })?;

            let account_ids = accounts
                .data
                .into_iter()
                .map(|a| a.account_id)
                .collect::<Vec<_>>();
            tracing::info!(
                "list_accounts instance={} accounts={}",
                instance_id_owned,
                account_ids.len()
            );
            Ok::<_, (StatusCode, String)>(account_ids)
        })
        .await
}

/// Build reverse index of DAO account -> ft-lockup instance IDs.
///
/// Uses cached `list_accounts` per instance and stores the full reverse map.
async fn fetch_ft_lockup_dao_instance_index(
    state: &Arc<AppState>,
    instance_ids: &[String],
) -> Result<HashMap<String, Vec<String>>, (StatusCode, String)> {
    tracing::info!(
        "building dao->instances index from instances={}",
        instance_ids.len()
    );
    let mut instance_ids_key_parts = instance_ids.to_vec();
    instance_ids_key_parts.sort();
    instance_ids_key_parts.dedup();
    let cache_key = CacheKey::new("ft-lockup-dao-instance-index")
        .with(instance_ids_key_parts.join(","))
        .build();
    let state_clone = state.clone();
    let instance_ids_for_cache = instance_ids.to_vec();

    state
        .cache
        .cached(CacheTier::VeryLongTerm, cache_key, async move {
            let mut index: HashMap<String, Vec<String>> = HashMap::new();

            for instance_id in instance_ids_for_cache {
                let accounts =
                    match fetch_ft_lockup_instance_accounts(&state_clone, &instance_id).await {
                        Ok(accounts) => accounts,
                        Err((status, message)) => {
                            tracing::warn!(
                                "skipping instance={} during index build: {} ({})",
                                instance_id,
                                message,
                                status
                            );
                            continue;
                        }
                    };
                for dao_account_id in accounts {
                    index
                        .entry(dao_account_id)
                        .or_default()
                        .push(instance_id.clone());
                }
            }
            tracing::info!("dao index built entries={}", index.len());

            Ok::<_, (StatusCode, String)>(index)
        })
        .await
}

pub(crate) async fn fetch_ft_lockup_contract_metadata(
    state: &Arc<AppState>,
    instance_id: &str,
) -> Result<FtLockupContractMetadata, (StatusCode, String)> {
    tracing::info!("contract_metadata for instance={}", instance_id);
    let cache_key = CacheKey::new("ft-lockup-contract-metadata")
        .with(instance_id)
        .build();
    let state_clone = state.clone();
    let instance_id_owned = instance_id.to_string();

    state
        .cache
        .cached(CacheTier::VeryLongTerm, cache_key, async move {
            let instance_account: AccountId = instance_id_owned.parse().map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Invalid ft-lockup instance id: {}", e),
                )
            })?;

            let metadata = Contract(instance_account)
                .call_function("contract_metadata", serde_json::json!({}))
                .read_only::<FtLockupContractMetadata>()
                .fetch_from(&state_clone.network)
                .await
                .map_err(|e| {
                    tracing::warn!(
                        "contract_metadata failed for instance={}: {}",
                        instance_id_owned,
                        e
                    );
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to fetch FT lockup metadata".to_string(),
                    )
                })?;

            Ok::<_, (StatusCode, String)>(metadata.data)
        })
        .await
}

pub(crate) async fn fetch_ft_lockup_account_data(
    state: &Arc<AppState>,
    instance_id: &str,
    account_id: &AccountId,
) -> Result<Option<FtLockupAccountData>, (StatusCode, String)> {
    tracing::info!("get_account instance={} dao={}", instance_id, account_id);
    let cache_key = CacheKey::new("ft-lockup-account")
        .with(instance_id)
        .with(account_id)
        .build();
    let state_clone = state.clone();
    let instance_id_owned = instance_id.to_string();
    let account_id_owned = account_id.to_string();

    state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            let instance_account: AccountId = instance_id_owned.parse().map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Invalid ft-lockup instance id: {}", e),
                )
            })?;

            let account_data_res = Contract(instance_account)
                .call_function(
                    "get_account",
                    serde_json::json!({
                        "account_id": account_id_owned
                    }),
                )
                .read_only::<serde_json::Value>()
                .fetch_from(&state_clone.network)
                .await;

            let account_data_value = match account_data_res {
                Ok(v) => v.data,
                Err(e) => {
                    tracing::warn!(
                        "get_account failed instance={} dao={}: {}",
                        instance_id_owned,
                        account_id_owned,
                        e
                    );
                    return Ok::<_, (StatusCode, String)>(None);
                }
            };

            if account_data_value.is_null() || !account_data_value.is_object() {
                tracing::info!(
                    "get_account empty instance={} dao={}",
                    instance_id_owned,
                    account_id_owned
                );
                return Ok::<_, (StatusCode, String)>(None);
            }

            let account_data =
                match serde_json::from_value::<FtLockupAccountData>(account_data_value) {
                    Ok(data) => data,
                    Err(e) => {
                        tracing::warn!(
                            "get_account parse failed instance={} dao={}: {}",
                            instance_id_owned,
                            account_id_owned,
                            e
                        );
                        return Ok::<_, (StatusCode, String)>(None);
                    }
                };

            tracing::info!(
                "get_account ok instance={} dao={}",
                instance_id_owned,
                account_id_owned
            );
            Ok::<_, (StatusCode, String)>(Some(account_data))
        })
        .await
}

pub(crate) async fn fetch_ft_lockup_positions(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Vec<FtLockupPosition>, (StatusCode, String)> {
    tracing::info!("resolve positions dao={}", account_id);
    let matched_instance_ids = match query_as::<_, (bool, Vec<String>)>(
        r#"
        SELECT
            EXISTS(SELECT 1 FROM ft_lockup_dao_schedules) AS has_any_rows,
            COALESCE(
                (
                    SELECT array_agg(instance_id ORDER BY instance_id)
                    FROM ft_lockup_dao_schedules
                    WHERE dao_account_id = $1
                ),
                ARRAY[]::TEXT[]
            ) AS matched_instance_ids
        "#,
    )
    .bind(account_id.as_str())
    .fetch_one(&state.db_pool)
    .await
    {
        Ok((_, ids)) if !ids.is_empty() => {
            tracing::info!(
                "matched instances from db dao={} count={}",
                account_id,
                ids.len()
            );
            ids
        }
        Ok((true, _)) => {
            tracing::info!(
                "no db matches for dao={} while schedules table has data; skip reverse-index fallback",
                account_id
            );
            Vec::new()
        }
        Ok((false, _)) => {
            tracing::info!(
                "schedules table empty, fallback to reverse index dao={}",
                account_id
            );
            let instance_ids = fetch_ft_lockup_instance_ids(state).await?;
            if instance_ids.is_empty() {
                tracing::info!("no instances configured");
                return Ok(Vec::new());
            }

            let dao_instance_index =
                fetch_ft_lockup_dao_instance_index(state, &instance_ids).await?;
            let dao_account_key = account_id.to_string();
            let ids = dao_instance_index
                .get(&dao_account_key)
                .cloned()
                .unwrap_or_default();
            tracing::info!(
                "matched instances from reverse-index dao={} count={}",
                account_id,
                ids.len()
            );
            ids
        }
        Err(e) => {
            tracing::warn!(
                "db lookup failed for dao={}, fallback to reverse index: {}",
                account_id,
                e
            );
            let instance_ids = fetch_ft_lockup_instance_ids(state).await?;
            if instance_ids.is_empty() {
                tracing::info!("no instances configured");
                return Ok(Vec::new());
            }

            let dao_instance_index =
                fetch_ft_lockup_dao_instance_index(state, &instance_ids).await?;
            let dao_account_key = account_id.to_string();
            let ids = dao_instance_index
                .get(&dao_account_key)
                .cloned()
                .unwrap_or_default();
            tracing::info!(
                "matched instances from reverse-index dao={} count={}",
                account_id,
                ids.len()
            );
            ids
        }
    };

    let mut positions = Vec::new();

    for instance_id in matched_instance_ids {
        let account_data =
            match fetch_ft_lockup_account_data(state, &instance_id, account_id).await? {
                Some(data) => data,
                None => continue,
            };
        let metadata = match fetch_ft_lockup_contract_metadata(state, &instance_id).await {
            Ok(m) => m,
            Err(_) => continue,
        };

        let deposited_amount = parse_u128_amount(&account_data.deposited_amount);
        let claimed_amount = parse_u128_amount(&account_data.claimed_amount);
        let unclaimed_amount = parse_u128_amount(&account_data.unclaimed_amount);

        if deposited_amount == 0 || claimed_amount >= deposited_amount {
            tracing::info!(
                "skip instance={} dao={} deposited={} claimed={}",
                instance_id,
                account_id,
                deposited_amount,
                claimed_amount
            );
            continue;
        }

        positions.push(FtLockupPosition {
            instance_id: instance_id.clone(),
            token_account_id: metadata.token_account_id,
            deposited_amount,
            claimed_amount,
            unclaimed_amount,
            start_timestamp: account_data.start_timestamp,
            session_interval: account_data.session_interval,
            session_num: account_data.session_num,
            last_claim_session: account_data.last_claim_session,
            release_per_session: account_data
                .release_per_session
                .as_deref()
                .map(parse_u128_amount),
        });
    }

    tracing::info!(
        "positions ready dao={} count={}",
        account_id,
        positions.len()
    );
    Ok(positions)
}

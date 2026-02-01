use std::collections::HashSet;
use std::sync::Arc;

use axum::http::StatusCode;
use near_api::{AccountId, Contract, NearToken};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    handlers::user::lockup::StakingPoolAccount,
    utils::cache::{CacheKey, CacheTier},
};

/// API response from FastNear and NearTreasury staking pool APIs
#[derive(Deserialize, Debug)]
pub struct StakingPoolsApiResponse {
    pub pools: Option<Vec<StakingPoolEntry>>,
}

#[derive(Deserialize, Debug)]
pub struct StakingPoolEntry {
    pub pool_id: String,
}

/// Aggregated staking balance for an account
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StakingBalance {
    #[serde(rename = "stakedBalance")]
    pub staked_balance: NearToken,
    #[serde(rename = "unstakedBalance")]
    pub unstaked_balance: NearToken,
    #[serde(rename = "canWithdraw")]
    pub can_withdraw: bool,
    pub pools: Vec<StakingPoolAccountInfo>,
}

/// Per-pool staking balance info
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StakingPoolAccountInfo {
    #[serde(rename = "poolId")]
    pub pool_id: String,
    #[serde(rename = "stakedBalance")]
    pub staked_balance: NearToken,
    #[serde(rename = "unstakedBalance")]
    pub unstaked_balance: NearToken,
    #[serde(rename = "canWithdraw")]
    pub can_withdraw: bool,
}

/// Fetch staking pools from FastNear API
async fn fetch_staking_pools_fastnear(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Vec<String>, (StatusCode, String)> {
    let response = state
        .http_client
        .get(format!(
            "https://api.fastnear.com/v1/account/{}/staking",
            account_id
        ))
        .header(
            "Authorization",
            format!("Bearer {}", state.env_vars.fastnear_api_key),
        )
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching staking pools from FastNear: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch staking pools from FastNear".to_string(),
            )
        })?;

    let data: StakingPoolsApiResponse = response.json().await.map_err(|e| {
        eprintln!("Error parsing FastNear staking response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse FastNear staking response".to_string(),
        )
    })?;

    Ok(data.pools.unwrap_or_default().into_iter().map(|p| p.pool_id).collect())
}

/// Fetch staking pools from NearTreasury staking pools API
async fn fetch_staking_pools_neartreasury(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Vec<String>, (StatusCode, String)> {
    let response = state
        .http_client
        .get(format!(
            "https://staking-pools-api.neartreasury.com/v1/account/{}/staking",
            account_id
        ))
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching staking pools from NearTreasury API: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch staking pools from NearTreasury API".to_string(),
            )
        })?;

    let data: StakingPoolsApiResponse = response.json().await.map_err(|e| {
        eprintln!("Error parsing NearTreasury staking response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse NearTreasury staking response".to_string(),
        )
    })?;

    Ok(data.pools.unwrap_or_default().into_iter().map(|p| p.pool_id).collect())
}

/// Fetch and merge staking pools from both APIs (with deduplication)
async fn fetch_staking_pools(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<HashSet<String>, (StatusCode, String)> {
    let cache_key = CacheKey::new("staking-pools")
        .with(account_id.clone())
        .build();

    let state_clone = state.clone();
    let account_id_clone = account_id.clone();

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Fetch from both sources concurrently
            let (fastnear_result, neartreasury_result) = tokio::join!(
                fetch_staking_pools_fastnear(&state_clone, &account_id_clone),
                fetch_staking_pools_neartreasury(&state_clone, &account_id_clone)
            );

            // Merge results with graceful degradation
            let mut pools = HashSet::new();

            match fastnear_result {
                Ok(fastnear_pools) => {
                    pools.extend(fastnear_pools);
                }
                Err(e) => {
                    eprintln!("Warning: FastNear staking pools API failed: {:?}", e);
                }
            }

            match neartreasury_result {
                Ok(neartreasury_pools) => {
                    pools.extend(neartreasury_pools);
                }
                Err(e) => {
                    eprintln!("Warning: NearTreasury staking pools API failed: {:?}", e);
                }
            }

            Ok::<_, (StatusCode, String)>(pools)
        })
        .await
}

/// Fetch balance from a single staking pool
async fn fetch_staking_pool_balance(
    state: &Arc<AppState>,
    account_id: &AccountId,
    pool_id: &AccountId,
) -> Result<StakingPoolAccountInfo, (StatusCode, String)> {
    let result = Contract(pool_id.clone())
        .call_function(
            "get_account",
            serde_json::json!({ "account_id": account_id.to_string() }),
        )
        .read_only::<StakingPoolAccount>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!(
                "Error fetching staking balance from pool {}: {}",
                pool_id, e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch staking balance from {}", pool_id),
            )
        })?;

    Ok(StakingPoolAccountInfo {
        pool_id: pool_id.to_string(),
        staked_balance: result.data.staked_balance,
        unstaked_balance: result.data.unstaked_balance,
        can_withdraw: result.data.can_withdraw,
    })
}

/// Fetch balances from all staking pools for an account
pub async fn fetch_staking_balances(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Option<StakingBalance>, (StatusCode, String)> {
    let cache_key = CacheKey::new("staking-balances")
        .with(account_id.clone())
        .build();

    let state_clone = state.clone();
    let account_id_clone = account_id.clone();

    state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            // Get all staking pools for this account
            let pools = fetch_staking_pools(&state_clone, &account_id_clone).await?;

            if pools.is_empty() {
                return Ok::<_, (StatusCode, String)>(None);
            }

            // Fetch balances from all pools in parallel
            let balance_futures: Vec<_> = pools
                .iter()
                .filter_map(|pool_id| pool_id.parse::<AccountId>().ok())
                .map(|pool_id| {
                    let state = state_clone.clone();
                    let account_id = account_id_clone.clone();
                    async move { fetch_staking_pool_balance(&state, &account_id, &pool_id).await }
                })
                .collect();

            let results = futures::future::join_all(balance_futures).await;

            // Aggregate results (with graceful degradation for individual pool failures)
            let mut total_staked = NearToken::from_yoctonear(0);
            let mut total_unstaked = NearToken::from_yoctonear(0);
            let mut any_can_withdraw = false;
            let mut pool_balances = Vec::new();

            for result in results {
                match result {
                    Ok(pool_balance) => {
                        // Skip pools with zero balance
                        if pool_balance.staked_balance.as_yoctonear() == 0
                            && pool_balance.unstaked_balance.as_yoctonear() == 0
                        {
                            continue;
                        }
                        total_staked = total_staked.saturating_add(pool_balance.staked_balance);
                        total_unstaked =
                            total_unstaked.saturating_add(pool_balance.unstaked_balance);
                        if pool_balance.can_withdraw && pool_balance.unstaked_balance.as_yoctonear() > 0 {
                            any_can_withdraw = true;
                        }
                        pool_balances.push(pool_balance);
                    }
                    Err(e) => {
                        eprintln!("Warning: Failed to fetch balance from pool: {:?}", e);
                        // Continue with other pools (graceful degradation)
                    }
                }
            }

            if pool_balances.is_empty() {
                return Ok::<_, (StatusCode, String)>(None);
            }

            Ok::<_, (StatusCode, String)>(Some(StakingBalance {
                staked_balance: total_staked,
                unstaked_balance: total_unstaked,
                can_withdraw: any_can_withdraw,
                pools: pool_balances,
            }))
        })
        .await
}

use crate::{
    handlers::user::{
        ft_lockups::fetch_ft_lockup_positions,
        lockup::{LockupBalance, fetch_lockup_balance_of_account},
        staking::{StakingBalance, fetch_staking_balances},
    },
    utils::cache::CacheTier,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use bigdecimal::{BigDecimal, ToPrimitive};
use near_api::{AccountId, Contract, NearToken, Tokens, types::json::U128};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::{
    AppState,
    constants::{
        INTENTS_CONTRACT_ID, NEAR_DECIMALS, NEAR_ICON, REF_FINANCE_CONTRACT_ID,
        intents_chains::ChainIcons,
        intents_tokens::{find_token_by_symbol, find_unified_asset_id},
        near_ft_whitelist::NEAR_FT_WHITELIST,
    },
    handlers::intents::confidential::balances::fetch_confidential_balances,
    handlers::token::{TokenMetadata as TokenMetadataResponse, fetch_tokens_metadata_enriched},
};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalanceResponse {
    pub account_id: String,
    pub token_id: String,
    pub balance: U128,
    pub locked_balance: Option<U128>,
    pub decimals: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Balance {
    Standard { total: String, locked: String },
    Staked(StakingBalance),
    Vested(LockupBalance),
}

impl Balance {
    pub fn total_raw(&self) -> U128 {
        match self {
            Balance::Standard { total, .. } => total.parse::<u128>().unwrap_or(0).into(),
            Balance::Staked(staking) => staking
                .staked_balance
                .saturating_add(staking.unstaked_balance)
                .as_yoctonear()
                .into(),
            Balance::Vested(lockup) => lockup.total.as_yoctonear().into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAssetsQuery {
    pub account_id: AccountId,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenMetadata {
    pub decimals: u8,
    pub symbol: String,
    pub name: String,
    pub icon: String,
}

impl TokenMetadata {
    pub fn near() -> Self {
        Self {
            decimals: NEAR_DECIMALS,
            symbol: "NEAR".to_string(),
            name: "NEAR".to_string(),
            icon: NEAR_ICON.to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum TokenResidency {
    Near,
    Ft,
    Intents,
    Lockup,
    Staked,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FtLockupSchedule {
    pub start_timestamp: Option<u64>,
    pub round_interval: Option<u64>,
    pub rounds_total: Option<u32>,
    pub rounds_completed: Option<u32>,
    pub total_amount: Option<String>,
    pub unlocked_amount: Option<String>,
    pub locked_amount: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SimplifiedToken {
    pub id: String,
    pub contract_id: Option<String>,
    /// FT lockup instance contract ID (one token can have multiple lockup sessions).
    pub lockup_instance_id: Option<String>,
    /// Optional schedule metadata for FT lockup session rows.
    pub ft_lockup_schedule: Option<FtLockupSchedule>,
    pub residency: TokenResidency,
    pub network: String,
    pub chain_name: String,
    pub symbol: String,

    pub balance: Balance,
    pub decimals: u8,
    pub price: String,
    pub name: String,
    pub icon: Option<String>,
    pub chain_icons: Option<ChainIcons>,
}

#[derive(Deserialize, Debug)]
pub struct FastNearToken {
    pub contract_id: String,
    #[serde(deserialize_with = "deserialize_u128_or_empty")]
    pub balance: U128,
}

fn deserialize_u128_or_empty<'de, D>(deserializer: D) -> Result<U128, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    Ok(U128(s.parse::<u128>().unwrap_or(0)))
}

#[derive(Deserialize, Debug)]
pub struct FastNearResponse {
    pub tokens: Option<Vec<FastNearToken>>,
}

fn canonical_token_id(token_id: &str) -> &str {
    token_id
        .strip_prefix("intents.near:")
        .unwrap_or(token_id)
        .strip_prefix("nep141:")
        .unwrap_or(token_id)
}

fn is_near_or_wrap_near(token_id: &str) -> bool {
    matches!(canonical_token_id(token_id), "near" | "wrap.near")
}

fn resolve_token_meta_and_unified_id<'a>(
    token_id: &str,
    metadata_map: &'a HashMap<String, TokenMetadataResponse>,
    near_token_meta: &'a TokenMetadataResponse,
) -> Option<(&'a TokenMetadataResponse, String)> {
    if is_near_or_wrap_near(token_id) {
        return Some((near_token_meta, "near".to_string()));
    }

    let token_meta = metadata_map.get(token_id)?;
    let unified_id = find_token_by_symbol(&token_meta.symbol)
        .map(|u| u.unified_asset_id)
        .unwrap_or_else(|| token_meta.symbol.to_lowercase());

    Some((token_meta, unified_id))
}

/// Fetch full account data from the FastNear API.
///
/// Queries `https://api.fastnear.com/v1/account/{account_id}/full` and returns
/// the parsed response. Shared by the assets endpoint and the monitor cycle's
/// FT token discovery.
pub async fn fetch_fastnear_account_full(
    http_client: &reqwest::Client,
    fastnear_api_key: &str,
    account_id: &str,
) -> Result<FastNearResponse, Box<dyn std::error::Error + Send + Sync>> {
    let response = http_client
        .get(format!(
            "https://api.fastnear.com/v1/account/{}/full",
            account_id
        ))
        .header("Authorization", format!("Bearer {}", fastnear_api_key))
        .send()
        .await?
        .error_for_status()?;

    Ok(response.json().await?)
}

/// Fetches whitelisted token IDs from the Ref Finance contract via RPC
async fn fetch_whitelisted_tokens_from_rpc(
    state: &Arc<AppState>,
) -> Result<HashSet<String>, (StatusCode, String)> {
    let whitelisted_tokens = Contract(REF_FINANCE_CONTRACT_ID.into())
        .call_function("get_whitelisted_tokens", ())
        .read_only::<HashSet<String>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching whitelisted tokens from RPC: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch whitelisted tokens".to_string(),
            )
        })?;

    Ok(whitelisted_tokens.data)
}

/// Fetches all Ref Finance tokens and filters them by whitelist
pub(crate) async fn fetch_whitelisted_tokens(
    state: &Arc<AppState>,
) -> Result<HashSet<String>, (StatusCode, String)> {
    let cache_key = "ref-whitelisted-tokens".to_string();
    let state_clone = state.clone();

    state
        .cache
        .cached(CacheTier::VeryLongTerm, cache_key, async move {
            fetch_whitelisted_tokens_from_rpc(&state_clone).await
        })
        .await
}

/// Fetches user balances from FastNear API
async fn fetch_user_balances(
    state: &Arc<AppState>,
    account: &AccountId,
) -> Result<FastNearResponse, (StatusCode, String)> {
    fetch_fastnear_account_full(
        &state.http_client,
        &state.env_vars.fastnear_api_key,
        account.as_ref(),
    )
    .await
    .map_err(|e| {
        eprintln!("Error fetching user balances: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch user balances".to_string(),
        )
    })
}

/// Builds a map of token balances from FastNear response
fn build_balance_map(user_balances: &FastNearResponse) -> HashMap<String, U128> {
    let mut balance_map = HashMap::new();
    if let Some(tokens) = &user_balances.tokens {
        for token in tokens {
            balance_map.insert(token.contract_id.to_lowercase(), token.balance.clone());
        }
    }
    balance_map
}

#[derive(Deserialize, Debug)]
struct IntentsToken {
    token_id: String,
}

/// Fetches tokens owned by an account from intents.near
async fn fetch_intents_owned_tokens(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Vec<String>, (StatusCode, String)> {
    let owned_tokens = Contract(INTENTS_CONTRACT_ID.into())
        .call_function(
            "mt_tokens_for_owner",
            serde_json::json!({
                "account_id": account_id
            }),
        )
        .read_only::<Vec<IntentsToken>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching owned tokens from intents.near: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch owned tokens from intents.near".to_string(),
            )
        })?;

    Ok(owned_tokens.data.into_iter().map(|t| t.token_id).collect())
}

/// Fetches balances for multiple tokens from intents.near
async fn fetch_intents_balances(
    state: &Arc<AppState>,
    account_id: &AccountId,
    token_ids: &[String],
) -> Result<Vec<String>, (StatusCode, String)> {
    if token_ids.is_empty() {
        return Ok(Vec::new());
    }

    let balances = Contract(INTENTS_CONTRACT_ID.into())
        .call_function(
            "mt_batch_balance_of",
            serde_json::json!({
                "account_id": account_id,
                "token_ids": token_ids
            }),
        )
        .read_only::<Vec<String>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching balances from intents.near: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch balances from intents.near".to_string(),
            )
        })?;

    Ok(balances.data)
}

fn build_intents_tokens(
    tokens_with_balances: Vec<(String, String)>,
    metadata_map: &HashMap<String, TokenMetadataResponse>,
) -> Vec<(SimplifiedToken, U128)> {
    tokens_with_balances
        .into_iter()
        .filter_map(|(token_id, balance)| {
            let metadata = if token_id == "nep141:wrap.near" {
                metadata_map.get("near")
            } else {
                metadata_map.get(&format!("intents.near:{}", token_id))
            }?;
            let balance_raw: U128 = balance.parse::<u128>().unwrap_or(0).into();

            let unified_id = find_unified_asset_id(&token_id)
                .map(|s| s.to_string())
                .unwrap_or_else(|| metadata.symbol.to_lowercase());
            Some((
                SimplifiedToken {
                    id: unified_id,
                    contract_id: Some(token_id),
                    lockup_instance_id: None,
                    ft_lockup_schedule: None,
                    decimals: metadata.decimals,
                    balance: Balance::Standard {
                        total: balance_raw.0.to_string(),
                        locked: "0".to_string(),
                    },
                    price: metadata
                        .price
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "0".to_string()),
                    symbol: metadata.symbol.clone(),
                    name: metadata.name.clone(),
                    icon: metadata.icon.clone(),
                    network: metadata.network.clone().unwrap_or_default(),
                    residency: TokenResidency::Intents,
                    chain_icons: metadata.chain_icons.clone(),
                    chain_name: metadata.chain_name.clone().unwrap_or(metadata.name.clone()),
                },
                balance_raw,
            ))
        })
        .collect()
}

pub const MIN_NEAR_DISPLAY_BALANCE: NearToken = NearToken::from_millinear(1);

/// Fetch NEAR balance for an account
pub async fn fetch_near_balance(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<TokenBalanceResponse, (StatusCode, String)> {
    let balance_future = Tokens::account(account_id.clone())
        .near_balance()
        .fetch_from(&state.network);

    let paid_near_future = sqlx::query_scalar::<_, BigDecimal>(
        "SELECT paid_near FROM monitored_accounts WHERE account_id = $1",
    )
    .bind(account_id.as_str())
    .fetch_optional(&state.db_pool);

    let (balance_result, paid_near_result) = tokio::join!(balance_future, paid_near_future);

    let balance = balance_result.map_err(|e| {
        eprintln!("Error fetching NEAR balance for {}: {}", account_id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch NEAR balance: {}", e),
        )
    })?;

    let paid_near_u128 = paid_near_result
        .ok()
        .flatten()
        .and_then(|v: BigDecimal| v.to_u128())
        .unwrap_or(0);

    let storage_locked = balance.storage_locked.as_yoctonear();
    let deduction = storage_locked.max(paid_near_u128);
    let total = balance.total.as_yoctonear();
    let available_raw = total.saturating_sub(deduction);
    // Display zero if the available balance is below 0.001 NEAR (1 milliNEAR)
    let available = if available_raw < MIN_NEAR_DISPLAY_BALANCE.as_yoctonear() {
        0
    } else {
        available_raw
    };

    Ok(TokenBalanceResponse {
        account_id: account_id.to_string(),
        token_id: "near".to_string(),
        balance: available.into(),
        locked_balance: Some(storage_locked.into()),
        decimals: 24,
    })
}

pub async fn compute_user_assets(
    state: &Arc<AppState>,
    account: &AccountId,
    is_confidential: bool,
) -> Result<Vec<SimplifiedToken>, (StatusCode, String)> {
    // ── Fetch raw balances ──────────────────────────────────────────────
    // Confidential treasuries: balances only from the private (1Click) intents API;
    // no on-chain FT/NEAR/lockup/staking or public intents discovery.
    // Regular treasuries: FT whitelist, public intents, NEAR, lockups, staking, FT lockups.

    let intents_balances: Vec<(String, String)>;
    let mut ref_tokens_with_balances: Vec<(String, U128)>;
    let near_balance: Option<TokenBalanceResponse>;
    let lockup_balance: Option<LockupBalance>;
    let staking_balance: Option<StakingBalance>;
    let ft_lockup_positions;

    if is_confidential {
        intents_balances = fetch_confidential_balances(state, account).await?;
        ref_tokens_with_balances = Vec::new();
        near_balance = None;
        lockup_balance = None;
        staking_balance = None;
        ft_lockup_positions = Vec::new();
    } else {
        let ref_data_future = async {
            let tokens_future = fetch_whitelisted_tokens(state);
            let balances_future = fetch_user_balances(state, account);
            let near_balance = fetch_near_balance(state, account);
            let lockup_balance = fetch_lockup_balance_of_account(state, account);
            let staking_balance = fetch_staking_balances(state, account);
            let ft_lockup_positions_future = fetch_ft_lockup_positions(state, account);

            let (
                whitelist_set,
                user_balances,
                near_balance,
                lockup_balance,
                staking_balance,
                ft_lockup_positions,
            ) = tokio::try_join!(
                tokens_future,
                balances_future,
                near_balance,
                lockup_balance,
                staking_balance,
                ft_lockup_positions_future
            )?;

            Ok::<_, (StatusCode, String)>((
                whitelist_set,
                user_balances,
                near_balance,
                lockup_balance,
                staking_balance,
                ft_lockup_positions,
            ))
        };

        let intents_data_future = async {
            let owned_token_ids = fetch_intents_owned_tokens(state, account).await?;
            if owned_token_ids.is_empty() {
                return Ok::<_, (StatusCode, String)>(Vec::new());
            }

            let balances = fetch_intents_balances(state, account, &owned_token_ids).await?;

            let tokens_with_balances: Vec<(String, String)> = owned_token_ids
                .into_iter()
                .zip(balances)
                .filter(|(_, balance)| balance.parse::<u128>().unwrap_or(0) > 0)
                .collect();

            Ok(tokens_with_balances)
        };

        let (ref_data_result, intents_data_result) =
            tokio::join!(ref_data_future, intents_data_future);

        let (whitelist_set, user_balances, near_bal, lockup_bal, staking_bal, ft_lockup_pos) =
            ref_data_result?;

        intents_balances = intents_data_result.unwrap_or_else(|e| {
            eprintln!("Warning: Failed to fetch intents tokens: {:?}", e);
            Vec::new()
        });

        let balance_map = build_balance_map(&user_balances);
        let ref_token_ids: HashSet<String> = whitelist_set.iter().cloned().collect();

        ref_tokens_with_balances = whitelist_set
            .into_iter()
            .filter_map(|token_id| {
                let balance = balance_map
                    .get(&token_id)
                    .cloned()
                    .unwrap_or_else(|| U128::from(0));
                if balance != U128::from(0) {
                    Some((token_id, balance))
                } else {
                    None
                }
            })
            .collect();

        // Add custom-whitelisted NEAR FT tokens that have balance but aren't in Ref
        for &contract_id in NEAR_FT_WHITELIST {
            if ref_token_ids.contains(contract_id) {
                continue;
            }
            if let Some(balance) = balance_map.get(contract_id)
                && *balance != U128::from(0)
            {
                ref_tokens_with_balances.push((contract_id.to_string(), balance.clone()));
            }
        }

        near_balance = Some(near_bal);
        lockup_balance = lockup_bal;
        staking_balance = staking_bal;
        ft_lockup_positions = ft_lockup_pos;
    }

    // ── Fetch metadata (shared path) ────────────────────────────────────

    // Ref whitelist tokens + intents + lockup + NEAR (no NearBlocks)
    let mut ref_token_ids: Vec<String> = ref_tokens_with_balances
        .iter()
        .filter(|(id, _)| !NEAR_FT_WHITELIST.contains(&id.as_str()))
        .map(|(id, _)| id.clone())
        .collect();
    ref_token_ids.extend(
        intents_balances
            .iter()
            .map(|(id, _)| format!("intents.near:{}", id)),
    );
    ref_token_ids.extend(
        ft_lockup_positions
            .iter()
            .map(|p| p.token_account_id.clone()),
    );
    ref_token_ids.push("near".to_string());

    // Custom whitelist tokens (with NearBlocks fallback)
    let custom_token_ids: Vec<String> = ref_tokens_with_balances
        .iter()
        .filter(|(id, _)| NEAR_FT_WHITELIST.contains(&id.as_str()))
        .map(|(id, _)| id.clone())
        .collect();

    let mut metadata_map = if !ref_token_ids.is_empty() {
        fetch_tokens_metadata_enriched(state, &ref_token_ids, false).await
    } else {
        HashMap::new()
    };

    if !custom_token_ids.is_empty() {
        let custom_meta = fetch_tokens_metadata_enriched(state, &custom_token_ids, true).await;
        metadata_map.extend(custom_meta);
    }

    // ── Build SimplifiedToken list ──────────────────────────────────────

    let near_token_meta = metadata_map.get("near").cloned().unwrap_or_else(|| {
        eprintln!("[User Assets] Warning: wrap.near metadata not found, using fallback");
        TokenMetadataResponse::create_near_metadata(None, None)
    });

    // FT tokens from Ref whitelist + custom whitelist (non-confidential only)
    let mut all_simplified_tokens: Vec<(SimplifiedToken, U128)> = ref_tokens_with_balances
        .into_iter()
        .filter_map(|(token_id, balance)| {
            let (token_meta, unified_id) =
                resolve_token_meta_and_unified_id(&token_id, &metadata_map, &near_token_meta)?;

            let price = token_meta.price.unwrap_or(0.0).to_string();

            Some((
                SimplifiedToken {
                    id: unified_id,
                    contract_id: Some(token_id),
                    lockup_instance_id: None,
                    ft_lockup_schedule: None,
                    decimals: token_meta.decimals,
                    balance: Balance::Standard {
                        total: balance.0.to_string(),
                        locked: "0".to_string(),
                    },
                    price,
                    symbol: token_meta.symbol.clone(),
                    name: token_meta.name.clone(),
                    icon: token_meta.icon.clone(),
                    network: "near".to_string(),
                    residency: TokenResidency::Ft,
                    chain_icons: token_meta.chain_icons.clone(),
                    chain_name: token_meta
                        .chain_name
                        .clone()
                        .unwrap_or_else(|| "Near Protocol".to_string()),
                },
                balance.clone(),
            ))
        })
        .collect();

    // Intents tokens (both confidential and regular)
    all_simplified_tokens.extend(build_intents_tokens(intents_balances, &metadata_map));

    // Add FT lockup balances as standard token balances with a locked portion.
    // Note: the same FT token contract can be deposited in multiple lockup sessions
    // (different ft-lockup instances), so we keep each session as its own row.
    // total   = deposited - claimed
    // locked  = unreleased = deposited - claimed - unclaimed
    // available = total - locked = unclaimed
    for position in ft_lockup_positions {
        let Some((token_meta, unified_id)) = resolve_token_meta_and_unified_id(
            &position.token_account_id,
            &metadata_map,
            &near_token_meta,
        ) else {
            continue;
        };

        let total_raw = position
            .deposited_amount
            .saturating_sub(position.claimed_amount);
        if total_raw == 0 {
            continue;
        }

        let locked_raw = position
            .deposited_amount
            .saturating_sub(position.claimed_amount)
            .saturating_sub(position.unclaimed_amount);

        let rounds_total = position.session_num.unwrap_or(0);
        let rounds_completed = position.last_claim_session.unwrap_or(0).min(rounds_total);

        // Display metrics for FT lockup details:
        // show cumulative unlocked for the active schedule, including already-claimed rounds.
        let (display_total_raw, display_unlocked_raw, display_locked_raw) =
            if let Some(release_per_session) = position.release_per_session {
                if rounds_total > 0 {
                    let round_total_raw = release_per_session.saturating_mul(rounds_total as u128);
                    let claimed_by_rounds_raw =
                        release_per_session.saturating_mul(rounds_completed as u128);
                    let unlocked_cumulative_raw =
                        claimed_by_rounds_raw.saturating_add(position.unclaimed_amount);
                    let unlocked_clamped_raw = unlocked_cumulative_raw.min(round_total_raw);
                    let locked_round_raw = round_total_raw.saturating_sub(unlocked_clamped_raw);
                    (round_total_raw, unlocked_clamped_raw, locked_round_raw)
                } else {
                    (total_raw, position.unclaimed_amount, locked_raw)
                }
            } else {
                (total_raw, position.unclaimed_amount, locked_raw)
            };

        all_simplified_tokens.push((
            SimplifiedToken {
                id: unified_id,
                contract_id: Some(position.token_account_id),
                lockup_instance_id: Some(position.instance_id),
                ft_lockup_schedule: Some(FtLockupSchedule {
                    start_timestamp: position.start_timestamp,
                    round_interval: position.session_interval,
                    rounds_total: Some(rounds_total),
                    rounds_completed: Some(rounds_completed),
                    total_amount: Some(display_total_raw.to_string()),
                    unlocked_amount: Some(display_unlocked_raw.to_string()),
                    locked_amount: Some(display_locked_raw.to_string()),
                }),
                decimals: token_meta.decimals,
                balance: Balance::Standard {
                    total: total_raw.to_string(),
                    locked: locked_raw.to_string(),
                },
                price: token_meta.price.unwrap_or(0.0).to_string(),
                symbol: token_meta.symbol.clone(),
                name: token_meta.name.clone(),
                icon: token_meta.icon.clone(),
                network: token_meta.network.clone().unwrap_or_default(),
                residency: TokenResidency::Ft,
                chain_icons: token_meta.chain_icons.clone(),
                chain_name: token_meta
                    .chain_name
                    .clone()
                    .unwrap_or_else(|| "Near Protocol".to_string()),
            },
            total_raw.into(),
        ));
    }

    // NEAR-native balances (non-confidential only)
    if let Some(lockup) = lockup_balance {
        let total = lockup.total.as_yoctonear().into();
        all_simplified_tokens.push((
            SimplifiedToken {
                id: "near".to_string(),
                contract_id: None,
                lockup_instance_id: None,
                ft_lockup_schedule: None,
                decimals: near_token_meta.decimals,
                balance: Balance::Vested(lockup),
                price: near_token_meta.price.unwrap_or(0.0).to_string(),
                symbol: near_token_meta.symbol.clone(),
                name: near_token_meta.name.clone(),
                icon: near_token_meta.icon.clone(),
                network: near_token_meta.network.clone().unwrap_or_default(),
                residency: TokenResidency::Lockup,
                chain_name: near_token_meta
                    .chain_name
                    .clone()
                    .unwrap_or(near_token_meta.name.clone()),
                chain_icons: near_token_meta.chain_icons.clone(),
            },
            total,
        ));
    }

    if let Some(staking) = staking_balance {
        let total: U128 = staking
            .staked_balance
            .saturating_add(staking.unstaked_balance)
            .as_yoctonear()
            .into();
        all_simplified_tokens.push((
            SimplifiedToken {
                id: "near".to_string(),
                contract_id: None,
                lockup_instance_id: None,
                ft_lockup_schedule: None,
                decimals: near_token_meta.decimals,
                balance: Balance::Staked(staking),
                price: near_token_meta.price.unwrap_or(0.0).to_string(),
                symbol: near_token_meta.symbol.clone(),
                name: near_token_meta.name.clone(),
                icon: near_token_meta.icon.clone(),
                network: near_token_meta.network.clone().unwrap_or_default(),
                residency: TokenResidency::Staked,
                chain_name: near_token_meta
                    .chain_name
                    .clone()
                    .unwrap_or(near_token_meta.name.clone()),
                chain_icons: near_token_meta.chain_icons.clone(),
            },
            total,
        ));
    }

    if let Some(near_bal) = near_balance {
        all_simplified_tokens.push((
            SimplifiedToken {
                id: "near".to_string(),
                contract_id: None,
                lockup_instance_id: None,
                ft_lockup_schedule: None,
                decimals: near_token_meta.decimals,
                balance: Balance::Standard {
                    total: near_bal.balance.0.to_string(),
                    locked: "0".to_string(),
                },
                price: near_token_meta.price.unwrap_or(0.0).to_string(),
                symbol: near_token_meta.symbol.clone(),
                name: near_token_meta.name.clone(),
                icon: near_token_meta.icon.clone(),
                network: near_token_meta.network.clone().unwrap_or_default(),
                residency: TokenResidency::Near,
                chain_name: near_token_meta
                    .chain_name
                    .clone()
                    .unwrap_or(near_token_meta.name.clone()),
                chain_icons: near_token_meta.chain_icons.clone(),
            },
            near_bal.balance,
        ));
    }

    // Sort combined list by balance (highest first)
    all_simplified_tokens = all_simplified_tokens
        .into_iter()
        .filter(|(_, balance)| balance.0 > 0)
        .collect::<Vec<(SimplifiedToken, U128)>>();
    all_simplified_tokens.sort_by(|(_, a_balance), (_, b_balance)| {
        b_balance
            .0
            .partial_cmp(&a_balance.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(all_simplified_tokens
        .into_iter()
        .map(|(token, _)| token)
        .collect())
}

pub async fn get_user_assets(
    State(state): State<Arc<AppState>>,
    auth: crate::auth::OptionalAuthUser,
    Query(params): Query<UserAssetsQuery>,
) -> Result<Json<Vec<SimplifiedToken>>, (StatusCode, String)> {
    let account = params.account_id.clone();
    let is_confidential = auth
        .verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await?;

    let cache_key = format!("{}-user-assets", account);
    let state_clone = state.clone();
    let account_clone = account.clone();

    let all_simplified_tokens = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            compute_user_assets(&state_clone, &account_clone, is_confidential).await
        })
        .await?;

    Ok(Json(all_simplified_tokens))
}

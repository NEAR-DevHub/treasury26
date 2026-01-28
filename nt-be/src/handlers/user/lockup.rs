use std::sync::Arc;

use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use near_api::{AccountId, NearToken};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::{
    AppState,
    constants::LOCKUP_CONTRACT_ID,
    utils::cache::{CacheKey, CacheTier},
};

/// Derives the lockup account ID from an owner account ID using SHA256 hash
pub fn derive_lockup_account_id(account_id: &AccountId) -> AccountId {
    let hash = sha2::Sha256::digest(account_id.as_bytes()).to_vec();
    format!("{}.{}", hex::encode(&hash[..20]), LOCKUP_CONTRACT_ID)
        .parse()
        .expect("Invalid lockup account ID")
}

/// Transaction status for staking operations
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TransactionStatus {
    Idle,
    Busy,
}

/// Transfers information - whether transfers are enabled or disabled
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum TransfersInformation {
    TransfersEnabled { transfers_timestamp: u64 },
    TransfersDisabled { transfer_poll_account_id: String },
}

/// Vesting schedule timestamps
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct VestingSchedule {
    pub start_timestamp: u64,
    pub cliff_timestamp: u64,
    pub end_timestamp: u64,
}

/// Vesting information for the lockup contract
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum VestingInformation {
    None,
    VestingHash {
        hash: Vec<u8>,
    },
    VestingSchedule {
        schedule: VestingSchedule,
    },
    Terminating {
        unvested_amount: NearToken,
        status: u8,
    },
}

/// Lockup information containing amounts and timing details
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct LockupInformation {
    pub lockup_amount: NearToken,
    pub termination_withdrawn_tokens: NearToken,
    pub lockup_duration: u64,
    pub release_duration: Option<u64>,
    pub lockup_timestamp: Option<u64>,
    pub transfers_information: TransfersInformation,
}

/// Staking pool information
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct StakingInformation {
    pub staking_pool_account_id: String,
    pub status: TransactionStatus,
    pub deposit_amount: NearToken,
}

/// Full lockup contract state
#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct LockupContract {
    pub owner_account_id: String,
    pub lockup_information: LockupInformation,
    pub vesting_information: VestingInformation,
    pub staking_pool_whitelist_account_id: String,
    pub staking_information: Option<StakingInformation>,
    pub foundation_account_id: Option<String>,
}

pub async fn fetch_lockup_contract(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Option<LockupContract>, (StatusCode, String)> {
    let cache_key = CacheKey::new("lockup-contract")
        .with(account_id.clone())
        .build();
    let lockup_account_id = derive_lockup_account_id(account_id);

    let result = state
        .cache
        .cached_contract_call(CacheTier::LongTerm, cache_key, async move {
            Ok(near_api::Contract(lockup_account_id.clone())
                .view_storage()
                .fetch_from(&state.network)
                .await?
                .data)
        })
        .await;
    if let Err((_, error)) = &result
        && error.contains("UnknownAccount")
    {
        return Ok(None);
    }
    let result = result?;

    let lockup_contract: Option<LockupContract> = result
        .values
        .first()
        .and_then(|state| {
            base64::engine::general_purpose::STANDARD
                .decode(&state.value.0)
                .ok()
        })
        .and_then(|bytes| BorshDeserialize::try_from_slice(&bytes).ok());

    Ok(lockup_contract)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LockupBalanceOfAccountResponse {
    /// Available balance: vested + staking rewards
    pub available: NearToken,
    /// Locked balance: unvested amount (not yet vested)
    pub locked: NearToken,
}

pub async fn fetch_lockup_balance_of_account(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Option<LockupBalanceOfAccountResponse>, (StatusCode, String)> {
    let lockup_account_id = derive_lockup_account_id(account_id);
    let network = state.network.clone();

    // Fetch contract state first to check if lockup exists and get staking pool info
    let Some(lockup_contract) = fetch_lockup_contract(state, account_id).await? else {
        return Ok(None);
    };

    let total_allocated = lockup_contract.lockup_information.lockup_amount;
    let known_deposited = lockup_contract
        .staking_information
        .as_ref()
        .map(|s| s.deposit_amount)
        .unwrap_or(NearToken::from_yoctonear(0));
    let staking_pool_id = lockup_contract
        .staking_information
        .as_ref()
        .map(|s| s.staking_pool_account_id.clone());

    // Fetch locked amount from lockup contract
    let locked_future = {
        let lockup_account_id = lockup_account_id.clone();
        let network = network.clone();
        async move {
            near_api::Contract(lockup_account_id)
                .call_function("get_locked_amount", ())
                .read_only::<NearToken>()
                .fetch_from(&network)
                .await
        }
    };

    // Fetch actual staked balance from staking pool (if exists)
    let pool_balance_future = {
        let staking_pool_id = staking_pool_id.clone();
        let lockup_account_id = lockup_account_id.clone();
        let network = network.clone();
        async move {
            let Some(pool_id) = staking_pool_id else {
                return Ok::<_, (StatusCode, String)>(NearToken::from_yoctonear(0));
            };
            let pool_account_id: AccountId = pool_id.parse().map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Invalid staking pool ID: {}", e),
                )
            })?;

            // Call get_account_total_balance on the staking pool
            let result = near_api::Contract(pool_account_id)
                .call_function(
                    "get_account_total_balance",
                    serde_json::json!({ "account_id": lockup_account_id.to_string() }),
                )
                .read_only::<NearToken>()
                .fetch_from(&network)
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("get_account_total_balance: {}", e),
                    )
                })?;

            Ok(result.data)
        }
    };

    let (locked_result, pool_balance_result) = tokio::join!(locked_future, pool_balance_future);

    let locked = locked_result
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("get_locked_amount: {}", e),
            )
        })?
        .data;

    let pool_balance = pool_balance_result?;

    // Calculate staking rewards: actual pool balance - known deposited amount
    let staking_rewards = pool_balance.saturating_sub(known_deposited);

    // vested = total_allocated - locked (unvested)
    let vested = total_allocated.saturating_sub(locked);

    // available = vested + staking rewards
    let available = vested.saturating_add(staking_rewards);

    Ok(Some(LockupBalanceOfAccountResponse { available, locked }))
}

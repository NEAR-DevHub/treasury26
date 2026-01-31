use std::sync::Arc;

use axum::extract::{Query, State};
use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use near_account_id::AccountIdRef;
use near_api::{
    Account as AccountAPI, AccountId, Data, NearToken, Reference,
    advanced::{
        AccountViewHandler, CallResultHandler, MultiQueryHandler, MultiRequestBuilder,
        PostprocessHandler,
    },
    types::{Account, tokens::STORAGE_COST_PER_BYTE},
};
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

pub const GENERIC_POOL_ID: &AccountIdRef = AccountIdRef::new_or_panic("allnodes.poolv1.near");

/// Response from staking pool's get_account method
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct StakingPoolAccount {
    pub account_id: String,
    #[serde(rename = "unstaked_balance")]
    pub unstaked_balance: NearToken,
    #[serde(rename = "staked_balance")]
    pub staked_balance: NearToken,
    #[serde(rename = "can_withdraw")]
    pub can_withdraw: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LockupBalance {
    pub total: NearToken,
    #[serde(rename = "storageLocked")]
    pub storage_locked: NearToken,
    #[serde(rename = "totalAllocated")]
    pub total_allocated: NearToken,
    pub unvested: NearToken,
    pub staked: NearToken,
    #[serde(rename = "unstakedBalance")]
    pub unstaked_balance: NearToken,
    #[serde(rename = "canWithdraw")]
    pub can_withdraw: bool,
}

#[allow(clippy::type_complexity)]
pub fn blockchain_lockup_builder(
    lockup_original_amount: NearToken,
    lockup_account_id: AccountId,
    pool_account_id: AccountId,
) -> MultiRequestBuilder<
    PostprocessHandler<
        LockupBalance,
        MultiQueryHandler<(
            AccountViewHandler,
            CallResultHandler<NearToken>,
            CallResultHandler<StakingPoolAccount>,
        )>,
    >,
> {
    let postprocess = MultiQueryHandler::default();
    MultiRequestBuilder::new(postprocess, Reference::Final)
        .add_query_builder(AccountAPI(lockup_account_id.clone()).view())
        .add_query_builder(
            near_api::Contract(lockup_account_id.clone())
                .call_function("get_locked_amount", ())
                .read_only::<NearToken>(),
        )
        .add_query_builder(
            near_api::Contract(pool_account_id)
                .call_function(
                    "get_account",
                    serde_json::json!({ "account_id": lockup_account_id.to_string() }),
                )
                .read_only::<StakingPoolAccount>(),
        )
        .map(
            move |(account_view, unvested_amount, staking_account): (
                Data<Account>,
                Data<NearToken>,
                Data<StakingPoolAccount>,
            )| {
                let total_staked = staking_account
                    .data
                    .staked_balance
                    .saturating_add(staking_account.data.unstaked_balance);
                LockupBalance {
                    total: account_view.data.amount.saturating_add(total_staked),
                    storage_locked: STORAGE_COST_PER_BYTE
                        .saturating_mul(account_view.data.storage_usage as u128),
                    unvested: unvested_amount.data,
                    staked: staking_account.data.staked_balance,
                    unstaked_balance: staking_account.data.unstaked_balance,
                    can_withdraw: staking_account.data.can_withdraw,
                    total_allocated: lockup_original_amount,
                }
            },
        )
}

pub async fn fetch_lockup_balance_of_account(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<Option<LockupBalance>, (StatusCode, String)> {
    let lockup_account_id = derive_lockup_account_id(account_id);
    let network = state.network.clone();

    // Fetch contract state first to check if lockup exists and get staking pool info
    let Some(lockup_contract) = fetch_lockup_contract(state, account_id).await? else {
        return Ok(None);
    };
    // If pool is not set, we will fetch from predefined and it will return 0
    let staking_pool_id = lockup_contract
        .staking_information
        .as_ref()
        .and_then(|s| s.staking_pool_account_id.parse::<AccountId>().ok())
        .unwrap_or(GENERIC_POOL_ID.into());

    let cache_key = CacheKey::new("lockup-balance")
        .with(account_id.clone())
        .build();

    state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            blockchain_lockup_builder(
                lockup_contract.lockup_information.lockup_amount,
                lockup_account_id.clone(),
                staking_pool_id.clone(),
            )
            .fetch_from(&network)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("fetch_lockup_balance_of_account: {}", e),
                )
            })
            .map(Some)
        })
        .await
}

// API endpoint types and handler

#[derive(Deserialize)]
pub struct LockupQuery {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
}

#[derive(Serialize)]
pub struct VestingScheduleResponse {
    #[serde(rename = "startTimestamp")]
    pub start_timestamp: u64,
    #[serde(rename = "cliffTimestamp")]
    pub cliff_timestamp: u64,
    #[serde(rename = "endTimestamp")]
    pub end_timestamp: u64,
}

#[derive(Serialize)]
pub struct LockupContractResponse {
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "vestingSchedule")]
    pub vesting_schedule: Option<VestingScheduleResponse>,
    #[serde(rename = "lockupTimestamp")]
    pub lockup_timestamp: Option<u64>,
    #[serde(rename = "lockupDuration")]
    pub lockup_duration: u64,
    #[serde(rename = "releaseDuration")]
    pub release_duration: Option<u64>,
    #[serde(rename = "stakingPoolAccountId")]
    pub staking_pool_account_id: Option<String>,
}

pub async fn get_user_lockup(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LockupQuery>,
) -> Result<axum::Json<Option<LockupContractResponse>>, (StatusCode, String)> {
    let lockup_contract = fetch_lockup_contract(&state, &params.account_id).await?;

    let response = lockup_contract.map(|contract| {
        let vesting_schedule = match contract.vesting_information {
            VestingInformation::VestingSchedule { schedule } => Some(VestingScheduleResponse {
                start_timestamp: schedule.start_timestamp,
                cliff_timestamp: schedule.cliff_timestamp,
                end_timestamp: schedule.end_timestamp,
            }),
            _ => None,
        };

        LockupContractResponse {
            owner_account_id: contract.owner_account_id,
            vesting_schedule,
            lockup_timestamp: contract.lockup_information.lockup_timestamp,
            lockup_duration: contract.lockup_information.lockup_duration,
            release_duration: contract.lockup_information.release_duration,
            staking_pool_account_id: contract
                .staking_information
                .map(|s| s.staking_pool_account_id),
        }
    });

    Ok(axum::Json(response))
}

//! Sponsorship policy: how much NEAR the relayer is willing to attach and front.
//!
//! - Attached proposal deposits are capped per [`SponsorshipTier`]: treasuries
//!   onboarded before [`SPONSORSHIP_CUTOFF`] keep the legacy bond-based allowance;
//!   newer ones are limited to 1 yoctoNEAR (their proposal bonds are zero).
//! - For Sputnik DAOs the relayer tops up the DAO contract's balance to cover the
//!   on-chain storage a NEW proposal occupies — i.e. for `add_proposal` only.
//!   `act_proposal` (voting) does not grow the DAO contract's storage, so it gets
//!   no top-up. This is unrelated to NEP-141 `storage_deposit` registrations, which
//!   the sponsor pays separately (see [`crate::handlers::relay::effects::registrations`]).

use std::sync::Arc;

use axum::http::StatusCode;
use chrono::{DateTime, TimeZone, Utc};
use near_api::{AccountId, Contract, NearToken, types::tokens::STORAGE_COST_PER_BYTE};
use serde_json::Value;

use super::{
    Sponsor,
    retry::{RetryPolicy, retry},
};
use crate::{
    AppState,
    handlers::relay::parse::{RelayError, error_response},
};

/// Maximum DAO-contract storage (in bytes) the relayer will compensate for a single
/// `add_proposal`.
const MAX_PROPOSAL_STORAGE_BYTES: u128 = 4000;
/// Absolute ceiling on the NEAR the relayer will attach/front per relay.
const MAX_SPONSORING: NearToken = NearToken::from_millinear(1200);
/// Treasuries onboarded before this date keep bond-based attached-deposit sponsorship.
const SPONSORSHIP_CUTOFF: (i32, u32, u32) = (2026, 4, 1);

/// The attached-deposit allowance a treasury qualifies for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SponsorshipTier {
    /// Grandfathered: bond-based allowance (treasuries onboarded before the cutoff).
    Legacy,
    /// Modern: ~zero attached deposit.
    Standard,
}

impl SponsorshipTier {
    pub fn for_treasury(created_at: DateTime<Utc>) -> Self {
        if created_at < cutoff() {
            Self::Legacy
        } else {
            Self::Standard
        }
    }
}

fn cutoff() -> DateTime<Utc> {
    let (year, month, day) = SPONSORSHIP_CUTOFF;
    Utc.with_ymd_and_hms(year, month, day, 0, 0, 0)
        .single()
        .expect("sponsorship cutoff is a valid timestamp")
}

/// NEAR the relayer fronts to compensate the DAO contract for the storage an
/// `add_proposal` occupies (`storage_bytes` of new on-chain proposal state).
pub fn proposal_storage_cost(storage_bytes: u128) -> NearToken {
    STORAGE_COST_PER_BYTE.saturating_mul(storage_bytes)
}

/// NEAR the relayer fronts for a relay, broken down for `paid_near` accounting.
#[derive(Debug, Clone, Copy)]
pub struct SpentNear {
    /// Top-up to the DAO contract for `add_proposal` storage growth.
    pub proposal_storage: NearToken,
    /// Attached proposal bond on the relayed `add_proposal`.
    pub deposits: NearToken,
    /// Sponsor-paid NEP-141 `storage_deposit` registrations for approving votes.
    pub registrations: NearToken,
}

impl SpentNear {
    pub fn total(&self) -> NearToken {
        self.proposal_storage
            .saturating_add(self.deposits)
            .saturating_add(self.registrations)
    }
}

/// Enforce the attached-deposit sponsorship limit for the treasury's tier.
///
/// `Legacy` may attach up to the DAO `proposal_bond` (plus the proposal-storage
/// top-up), capped at [`MAX_SPONSORING`]; `Standard` is limited to 1 yoctoNEAR.
/// NEP-141 registrations are paid separately by the sponsor (see `storage_deposit`)
/// and so are not part of this allowance.
pub async fn enforce_deposit_limit(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    tier: SponsorshipTier,
    attached_deposit: NearToken,
    proposal_storage_cost: NearToken,
) -> Result<(), RelayError> {
    match tier {
        SponsorshipTier::Legacy => {
            let deposit_bond = fetch_treasury_deposit_bond(state, treasury_id).await?;
            let paid = attached_deposit.saturating_add(proposal_storage_cost);
            let limit = deposit_bond
                .saturating_add(proposal_storage_cost)
                .min(MAX_SPONSORING);
            if paid > limit {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "Total deposit exceeds sponsorship limit of {} millinear",
                        limit.as_millinear()
                    ),
                ));
            }
        }
        SponsorshipTier::Standard => {
            if attached_deposit > NearToken::from_yoctonear(1) {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    "Total deposit exceeds sponsorship limit of 1 yoctoNEAR",
                ));
            }
        }
    }
    Ok(())
}

/// Top up the DAO contract's balance to cover the storage a NEW proposal occupies,
/// before the `add_proposal` executes. Only call this for relays that add a proposal
/// — `act_proposal` does not grow DAO storage.
pub async fn top_up_proposal_storage(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    storage_bytes: u128,
    proposal_storage_cost: NearToken,
) -> Result<(), RelayError> {
    if storage_bytes > MAX_PROPOSAL_STORAGE_BYTES {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            format!(
                "Storage bytes must be less than {} bytes",
                MAX_PROPOSAL_STORAGE_BYTES
            ),
        ));
    }

    Sponsor::from_state(state)
        .transfer_once(treasury_id, proposal_storage_cost)
        .await
        .map_err(|e| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to send proposal-storage top-up transaction: {}", e),
            )
        })
}

/// Read the treasury's `proposal_bond` from its on-chain policy (retried).
async fn fetch_treasury_deposit_bond(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
) -> Result<NearToken, RelayError> {
    let policy = retry(RetryPolicy::rpc(), "fetch DAO policy", || async {
        Contract(treasury_id.clone())
            .call_function("get_policy", ())
            .read_only::<Value>()
            .fetch_from(&state.network)
            .await
    })
    .await
    .map_err(|e| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch DAO policy: {}", e),
        )
    })?
    .data;

    let deposit_bond_raw = policy
        .get("proposal_bond")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DAO policy is missing proposal_bond",
            )
        })?;

    let deposit_bond_yocto = deposit_bond_raw.parse::<u128>().map_err(|e| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid proposal_bond in DAO policy: {}", e),
        )
    })?;

    Ok(NearToken::from_yoctonear(deposit_bond_yocto))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, 0, 0, 0).unwrap()
    }

    #[test]
    fn tier_grandfathers_pre_cutoff() {
        assert_eq!(
            SponsorshipTier::for_treasury(at(2026, 3, 31)),
            SponsorshipTier::Legacy
        );
        assert_eq!(
            SponsorshipTier::for_treasury(at(2026, 4, 1)),
            SponsorshipTier::Standard
        );
    }

    #[test]
    fn spent_near_totals_provenance() {
        let spent = SpentNear {
            proposal_storage: NearToken::from_yoctonear(5),
            deposits: NearToken::from_yoctonear(3),
            registrations: NearToken::from_yoctonear(2),
        };
        assert_eq!(spent.total(), NearToken::from_yoctonear(10));
    }
}

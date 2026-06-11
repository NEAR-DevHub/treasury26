//! Allowlist of contracts a relayed action may target.
//!
//! The treasury (DAO) itself is always allowed; the rest is the union of the NEAR
//! Intents and Ref token whitelists, refreshed hourly and cached so validation
//! keeps working during upstream outages. Used as defense in depth — the proposal
//! parser already pins relayed calls to the treasury.

use std::{
    collections::HashSet,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use near_api::AccountId;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::{
    AppState,
    handlers::{
        intents::supported_tokens::fetch_supported_tokens_data,
        relay::dto::{RelayError, error_response},
        user::assets::fetch_whitelisted_tokens,
    },
};

const REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);

static CACHE: LazyLock<RwLock<CacheState>> = LazyLock::new(|| RwLock::new(CacheState::default()));

#[derive(Default)]
struct CacheState {
    contracts: HashSet<String>,
    last_refresh_attempt: Option<Instant>,
}

/// Reject the request when `receiver_id` is not an allowed relay target.
pub async fn verify_receiver_allowed(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    receiver_id: &AccountId,
) -> Result<(), RelayError> {
    let allowed = allowed_contracts(state, treasury_id).await;
    if allowed.contains(receiver_id.as_str()) {
        Ok(())
    } else {
        Err(error_response(
            StatusCode::FORBIDDEN,
            format!("Contract '{}' is not allowed for relayed actions", receiver_id),
        ))
    }
}

/// The set of contracts a relay may target for `treasury_id`.
async fn allowed_contracts(state: &Arc<AppState>, treasury_id: &AccountId) -> HashSet<String> {
    // Always allow DAO self-calls. We intentionally avoid an "empty allowlist"
    // fallback: when external whitelist sources are down, add_proposal/act_proposal
    // should still work.
    let mut allowed = HashSet::from([treasury_id.to_string()]);

    let now = Instant::now();
    let (cached, should_refresh) = {
        let cache = CACHE.read().await;
        let should_refresh = cache
            .last_refresh_attempt
            .map(|last| now.duration_since(last) >= REFRESH_INTERVAL)
            .unwrap_or(true);
        (cache.contracts.clone(), should_refresh)
    };

    if !should_refresh {
        allowed.extend(cached);
        return allowed;
    }

    let fetched = fetch_external_contracts(state).await;
    {
        let mut cache = CACHE.write().await;
        cache.last_refresh_attempt = Some(now);
        // Persist any successful fetch (full or partial) so we can still enforce
        // validation from cached data during upstream outages.
        if fetched.has_any_success() {
            cache.contracts = fetched.contracts.clone();
        }
    }

    if fetched.has_any_success() {
        allowed.extend(fetched.contracts);
    } else if !cached.is_empty() {
        log::warn!("Using stale allowed receiver contracts cache for relay validation");
        allowed.extend(cached);
    } else {
        log::warn!(
            "Allowed receiver contracts sources are unavailable and no cache exists; only treasury contract is allowed"
        );
    }
    allowed
}

struct FetchOutcome {
    contracts: HashSet<String>,
    intents_ok: bool,
    ref_ok: bool,
}

impl FetchOutcome {
    fn has_any_success(&self) -> bool {
        self.intents_ok || self.ref_ok
    }
}

async fn fetch_external_contracts(state: &Arc<AppState>) -> FetchOutcome {
    let (intents_result, ref_result) = tokio::join!(
        fetch_supported_tokens_data(state),
        fetch_whitelisted_tokens(state)
    );

    let mut contracts = HashSet::new();
    let intents_ok = match intents_result {
        Ok(supported_tokens) => {
            contracts.extend(intents_whitelist_contracts(&supported_tokens));
            true
        }
        Err((_, msg)) => {
            log::warn!(
                "Failed to fetch intents whitelist for relay receiver validation: {}",
                msg
            );
            false
        }
    };

    let ref_ok = match ref_result {
        Ok(ref_whitelist) => {
            contracts.extend(ref_whitelist);
            true
        }
        Err((_, msg)) => {
            log::warn!(
                "Failed to fetch Ref whitelist for relay receiver validation: {}",
                msg
            );
            false
        }
    };

    FetchOutcome {
        contracts,
        intents_ok,
        ref_ok,
    }
}

/// Extract the NEP-141 contract id from an Intents asset id
/// (`nep141:<contract>` or `nep245:<contract>:<token>`).
pub(crate) fn extract_intents_contract(asset_id: &str) -> Option<&str> {
    asset_id.strip_prefix("nep141:").or_else(|| {
        asset_id
            .strip_prefix("nep245:")
            .and_then(|s| s.split(":").next())
    })
}

fn intents_whitelist_contracts(supported_tokens: &Value) -> HashSet<String> {
    let mut contracts = HashSet::new();
    let Some(tokens) = supported_tokens.get("tokens").and_then(Value::as_array) else {
        return contracts;
    };

    for token in tokens {
        let is_nep141 = token
            .get("standard")
            .and_then(Value::as_str)
            .map(|standard| standard == "nep141")
            .unwrap_or(false);
        if !is_nep141 {
            continue;
        }

        for field in ["intents_token_id", "defuse_asset_identifier"] {
            if let Some(asset_id) = token.get(field).and_then(Value::as_str)
                && let Some(contract_id) = extract_intents_contract(asset_id)
            {
                contracts.insert(contract_id.to_string());
            }
        }
    }

    contracts
}

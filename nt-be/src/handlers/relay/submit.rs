use axum::{Json, extract::State, http::StatusCode};
use bigdecimal::BigDecimal;
use borsh::BorshDeserialize;
use near_api::{
    AccountId, Contract, NearToken, Tokens, Transaction,
    types::{
        Action,
        json::{Base64VecU8, U128},
        tokens::STORAGE_COST_PER_BYTE,
        transaction::delegate_action::SignedDelegateAction,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    ops::Deref,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

use crate::{
    AppState,
    auth::AuthUser,
    config::plans::{PlanType, has_gas_covered_credits},
    handlers::{
        intents::supported_tokens::fetch_supported_tokens_data,
        user::assets::fetch_whitelisted_tokens,
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRequest {
    pub treasury_id: AccountId,
    pub storage_bytes: U128,
    /// Base64-encoded borsh-serialized SignedDelegateAction
    pub signed_delegate_action: Base64VecU8,
    /// Optional proposal type hint for metrics. Only set on the actual proposal call,
    /// NOT on helper calls like storage_deposit.
    /// "swap" → swap_proposals, "payment" → payment_proposals, "vote" → votes_casted,
    /// "confidential_transfer" and others → other_proposals_submitted.
    /// Absent/null → no metric recorded.
    #[serde(default)]
    pub proposal_type: Option<String>,
    /// True when a payment proposal recipient was selected from address book.
    /// Only set on the actual proposal call.
    #[serde(default)]
    pub address_book_payment: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn error_response(status: StatusCode, msg: String) -> (StatusCode, Json<RelayResponse>) {
    (
        status,
        Json(RelayResponse {
            success: false,
            error: Some(msg),
        }),
    )
}

async fn verify_relay_access(
    state: &Arc<AppState>,
    auth_user: &AuthUser,
    request: &RelayRequest,
    signed_delegate_action: &SignedDelegateAction,
) -> Result<(), (StatusCode, Json<RelayResponse>)> {
    // Vote relays follow on-chain vote permissions (including Everyone roles),
    if request.proposal_type.as_deref() == Some("vote") {
        let mut requested_vote_actions = HashSet::new();
        for action in &signed_delegate_action.delegate_action.actions {
            if let Action::FunctionCall(function_call) = action.deref()
                && function_call.method_name == "act_proposal"
            {
                let args = serde_json::from_slice::<Value>(&function_call.args).map_err(|e| {
                    error_response(
                        StatusCode::BAD_REQUEST,
                        format!("Invalid act_proposal args: {}", e),
                    )
                })?;

                let vote_action = args.get("action").and_then(Value::as_str).ok_or_else(|| {
                    error_response(
                        StatusCode::BAD_REQUEST,
                        "Missing vote action in act_proposal args".to_string(),
                    )
                })?;

                match vote_action {
                    "VoteApprove" | "VoteReject" | "VoteRemove" => {
                        requested_vote_actions.insert(vote_action.to_string());
                    }
                    _ => {
                        return Err(error_response(
                            StatusCode::BAD_REQUEST,
                            format!("Unsupported vote action '{}'", vote_action),
                        ));
                    }
                }
            }
        }

        if requested_vote_actions.is_empty() {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "No vote actions found in delegate action".to_string(),
            ));
        }

        let policy = auth_user
            .fetch_dao_policy(state, &request.treasury_id)
            .await
            .map_err(|(status, msg)| error_response(status, msg))?;

        for vote_action in requested_vote_actions {
            auth_user
                .verify_can_perform_action_with_policy(&policy, &request.treasury_id, &vote_action)
                .map_err(|(status, msg)| error_response(status, msg))?;
        }

        return Ok(());
    }

    auth_user
        .verify_can_add_proposal(state, &request.treasury_id)
        .await
        .map_err(|(status, msg)| error_response(status, msg))
}

const MAX_STORAGE_BYTES: u128 = 4000;
const MAX_SPONSORING: NearToken = NearToken::from_millinear(1200);
// We need to multiply the buffer by 25 because this is the bulk payment limit for single transaction
// This is worse case scenario where all bulk payments recipients are not registered in the token contract
const TOKEN_STORAGE_BUFFER: NearToken = NearToken::from_micronear(1250).saturating_mul(25);
const SPUTNIK_DAO_SUFFIX: &str = ".sputnik-dao.near";
const ALLOWED_CONTRACTS_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
struct AllowedContractsCacheState {
    contracts: HashSet<String>,
    last_refresh_attempt: Option<Instant>,
}

static ALLOWED_CONTRACTS_CACHE: LazyLock<RwLock<AllowedContractsCacheState>> =
    LazyLock::new(|| RwLock::new(AllowedContractsCacheState::default()));

struct AllowedContractsFetchOutcome {
    contracts: HashSet<String>,
    intents_fetch_succeeded: bool,
    ref_fetch_succeeded: bool,
}

impl AllowedContractsFetchOutcome {
    fn has_any_success(&self) -> bool {
        self.intents_fetch_succeeded || self.ref_fetch_succeeded
    }
}

fn extract_intents_contract(asset_id: &str) -> Option<&str> {
    asset_id.strip_prefix("nep141:").or_else(|| {
        asset_id
            .strip_prefix("nep245:")
            .and_then(|s| s.split(":").next())
    })
}

fn extract_intents_whitelist_contracts(supported_tokens: &Value) -> HashSet<String> {
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

async fn fetch_external_allowed_contracts(state: &Arc<AppState>) -> AllowedContractsFetchOutcome {
    let (intents_result, ref_result) = tokio::join!(
        fetch_supported_tokens_data(state),
        fetch_whitelisted_tokens(state)
    );

    let mut contracts = HashSet::new();
    let intents_fetch_succeeded = match intents_result {
        Ok(supported_tokens) => {
            contracts.extend(extract_intents_whitelist_contracts(&supported_tokens));
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

    let ref_fetch_succeeded = match ref_result {
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

    AllowedContractsFetchOutcome {
        contracts,
        intents_fetch_succeeded,
        ref_fetch_succeeded,
    }
}

async fn fetch_allowed_receiver_contracts(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
) -> HashSet<String> {
    let mut allowed_contracts = HashSet::new();
    // Always allow DAO self-calls. We intentionally avoid an "empty allowlist" fallback:
    // when external whitelist sources are down, add_proposal/act_proposal should still work.
    allowed_contracts.insert(treasury_id.to_string());

    let now = Instant::now();
    let (cached_contracts, should_refresh) = {
        let cache_state = ALLOWED_CONTRACTS_CACHE.read().await;
        let should_refresh = cache_state
            .last_refresh_attempt
            .map(|last| now.duration_since(last) >= ALLOWED_CONTRACTS_REFRESH_INTERVAL)
            .unwrap_or(true);
        (cache_state.contracts.clone(), should_refresh)
    };

    if should_refresh {
        let fetch_outcome = fetch_external_allowed_contracts(state).await;

        {
            let mut cache_state = ALLOWED_CONTRACTS_CACHE.write().await;
            cache_state.last_refresh_attempt = Some(now);
            // Persist any successful fetch result (full or partial) so we can still enforce
            // contract validation from cached data during upstream outages.
            if fetch_outcome.has_any_success() {
                cache_state.contracts = fetch_outcome.contracts.clone();
            }
        }

        if fetch_outcome.has_any_success() {
            allowed_contracts.extend(fetch_outcome.contracts);
        } else if !cached_contracts.is_empty() {
            log::warn!("Using stale allowed receiver contracts cache for relay validation");
            allowed_contracts.extend(cached_contracts);
        } else {
            log::warn!(
                "Allowed receiver contracts sources are unavailable and no cache exists; only treasury contract is allowed"
            );
        }

        return allowed_contracts;
    }

    allowed_contracts.extend(cached_contracts);
    allowed_contracts
}

async fn fetch_treasury_deposit_bond(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
) -> Result<NearToken, (StatusCode, Json<RelayResponse>)> {
    let policy = Contract(treasury_id.clone())
        .call_function("get_policy", ())
        .read_only::<serde_json::Value>()
        .fetch_from(&state.network)
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
                "DAO policy is missing proposal_bond".to_string(),
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

/// True when the delegate action contains a `w_execute_signed` function call.
fn is_w_execute_signed_action(signed_delegate_action: &SignedDelegateAction) -> bool {
    signed_delegate_action
        .delegate_action
        .actions
        .iter()
        .map(Deref::deref)
        .all(|action| {
            matches!(
                action,
                Action::FunctionCall(fc) if fc.method_name == "w_execute_signed"
            )
        })
}

/// Execute a `w_execute_signed` delegate action as a regular transaction
/// signed and sent by the sponsor account, rather than relaying it as a
/// NEP-366 meta-transaction.
///
/// The delegate action's `sender_id` is a helper account, not the user <E2><80><94> the
/// user's authorization is the signature inside `w_execute_signed`, which the
/// wallet contract verifies on-chain. So instead we bind to the authenticated
/// identity: the receiver (the wallet-contract account being called) must equal
/// the logged-in user. The sponsor becomes the predecessor; inner actions are
/// replayed verbatim.
async fn relay_w_execute_signed(
    state: &Arc<AppState>,
    auth_user: &AuthUser,
    request: &RelayRequest,
    signed_delegate_action: &SignedDelegateAction,
) -> Result<Json<RelayResponse>, (StatusCode, Json<RelayResponse>)> {
    let receiver_id = signed_delegate_action.delegate_action.receiver_id.clone();

    // The sponsor only ever invokes `w_execute_signed` on the authenticated
    // user's own wallet-contract account.
    if receiver_id != auth_user.account_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            format!(
                "w_execute_signed receiver '{}' does not match authenticated user '{}'",
                receiver_id, auth_user.account_id
            ),
        ));
    }

    // Bound the sponsored deposit just like the meta-transaction path.
    let deposits = signed_delegate_action
        .delegate_action
        .actions
        .iter()
        .map(Deref::deref)
        .fold(NearToken::from_near(0), |acc, action| {
            if let Action::FunctionCall(fc) = action {
                acc.saturating_add(fc.deposit)
            } else {
                acc
            }
        });
    if deposits > NearToken::from_near(0) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Total deposit exceeds sponsorship limit of 0 NEAR".to_owned(),
        ));
    }

    // Build a regular transaction signed and sent by the sponsor account,
    // replaying the delegate action's inner actions directly to the receiver.
    let mut transaction = Transaction::construct(state.signer_id.clone(), receiver_id);
    for action in &signed_delegate_action.delegate_action.actions {
        transaction = transaction.add_action(action.deref().clone());
    }

    transaction
        .with_signer(state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| {
            log::error!("Failed to submit w_execute_signed transaction: {:?}", e);
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to relay: {}", e),
            )
        })?
        .into_result()
        .map_err(|e| {
            log::error!("w_execute_signed execution failed: {:?}", e);
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Execution failed: {}", e),
            )
        })?;

    // Consume a gas-covered credit and accumulate paid_near, mirroring the
    // meta-transaction relay path.
    let near_spent_yocto: BigDecimal = deposits.as_yoctonear().into();
    let db_result = sqlx::query_as::<_, (i32,)>(
        r#"
        UPDATE monitored_accounts
        SET gas_covered_transactions = GREATEST(gas_covered_transactions - 1, 0),
            paid_near = paid_near + $2,
            updated_at = NOW()
        WHERE account_id = $1
        RETURNING gas_covered_transactions
        "#,
    )
    .bind(request.treasury_id.as_str())
    .bind(near_spent_yocto)
    .fetch_optional(&state.db_pool)
    .await;
    if let Err(e) = db_result {
        log::error!(
            "Failed to decrement gas credits for {}: {}",
            request.treasury_id.as_str(),
            e
        );
        // Don't fail - the transaction already succeeded.
    }

    crate::services::platform_metrics::record_events(
        &state.db_pool,
        request.treasury_id.as_str(),
        &[crate::services::platform_metrics::PlatformMetric::GasCoveredTransactions],
    )
    .await;

    Ok(Json(RelayResponse {
        success: true,
        error: None,
    }))
}

/// Relay a signed delegate action (NEP-366 meta-transaction) to the NEAR network.
///
/// The backend wraps the user's signed delegate action in a regular transaction,
/// signs it with the relayer key (paying for gas), and submits to the network.
/// On success, decrements the treasury's gas-covered transaction credits.
pub async fn relay_delegate_action(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(request): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, (StatusCode, Json<RelayResponse>)> {
    // Step 1: Decode and deserialize SignedDelegateAction
    let signed_delegate_action =
        SignedDelegateAction::try_from_slice(&request.signed_delegate_action.0).map_err(|e| {
            error_response(
                StatusCode::BAD_REQUEST,
                format!("Invalid delegate action: {}", e),
            )
        })?;

    // `w_execute_signed` is not a DAO meta-transaction: the delegate action is
    // assembled by a helper account (its `sender_id`) and carries the user's
    // own signature, verified on-chain by the wallet contract. The sponsor
    // executes it as a regular transaction on the authenticated user's account,
    // so it bypasses the DAO proposal/sender checks below.
    if is_w_execute_signed_action(&signed_delegate_action) {
        return relay_w_execute_signed(&state, &auth_user, &request, &signed_delegate_action).await;
    }

    verify_relay_access(&state, &auth_user, &request, &signed_delegate_action).await?;

    // Step 2: Verify sender_id matches authenticated user
    let sender_id = signed_delegate_action.delegate_action.sender_id.to_string();
    if sender_id != auth_user.account_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            format!(
                "Delegate action sender '{}' does not match authenticated user '{}'",
                sender_id, auth_user.account_id
            ),
        ));
    }

    // Step 3: Check gas-covered transaction credits
    let credits_result = sqlx::query_as::<_, (i32, PlanType)>(
        r#"
        SELECT gas_covered_transactions, plan_type
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(request.treasury_id.as_str())
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Database error: {}", e),
        )
    })?;

    match credits_result {
        None => {
            return Err(error_response(
                StatusCode::NOT_FOUND,
                format!(
                    "Treasury '{}' not found in monitored accounts",
                    request.treasury_id.as_str()
                ),
            ));
        }
        Some((current_credits, plan_type)) => {
            if !has_gas_covered_credits(plan_type, current_credits) {
                return Err(error_response(
                    StatusCode::PAYMENT_REQUIRED,
                    "No gas-covered transaction credits remaining. Please upgrade your plan."
                        .to_string(),
                ));
            }
        }
    }

    // Step 4: Validate allowed receiver contract and sponsorship limits
    // Per NEP-366, the relayer sends a transaction to the delegate action's sender_id.
    let receiver_id = signed_delegate_action.delegate_action.sender_id.clone();
    let action_receiver_id = signed_delegate_action.delegate_action.receiver_id.clone();

    // Extract v1.signer payload hash before the delegate action is consumed.
    let confidential_payload_hash = crate::handlers::relay::confidential::extract_v1_signer_hash(
        &signed_delegate_action.delegate_action.actions,
    );

    let allowed_contracts = fetch_allowed_receiver_contracts(&state, &request.treasury_id).await;
    if !allowed_contracts.contains(action_receiver_id.as_str()) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            format!(
                "Contract '{}' is not allowed for relayed actions",
                action_receiver_id
            ),
        ));
    }

    let should_balance_storage = action_receiver_id.as_str().ends_with(SPUTNIK_DAO_SUFFIX);

    let storage_cost = STORAGE_COST_PER_BYTE.saturating_mul(request.storage_bytes.0);
    let deposits = signed_delegate_action
        .delegate_action
        .actions
        .iter()
        .map(Deref::deref)
        .fold(NearToken::from_millinear(0), |acc, action| {
            if let Action::FunctionCall(action) = action {
                acc.saturating_add(action.deposit)
            } else {
                acc
            }
        });

    let deposit_bond = fetch_treasury_deposit_bond(&state, &request.treasury_id).await?;
    let max_deposit = deposit_bond.saturating_add(TOKEN_STORAGE_BUFFER);
    let (paid, limit) = if should_balance_storage {
        (
            deposits.saturating_add(storage_cost),
            max_deposit.saturating_add(storage_cost).min(MAX_SPONSORING),
        )
    } else {
        (deposits, max_deposit.min(MAX_SPONSORING))
    };

    if paid > limit {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            format!(
                "Total deposit exceeds sponsorship limit of {} millinear",
                limit.as_millinear()
            ),
        ));
    }

    // Step 5: For Sputnik DAOs only, top up near balance for storage before executing delegate action.
    if should_balance_storage {
        if request.storage_bytes.0 > MAX_STORAGE_BYTES {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                format!(
                    "Storage bytes must be less than {} bytes",
                    MAX_STORAGE_BYTES
                ),
            ));
        }

        Tokens::account(state.signer_id.clone())
            .send_to(request.treasury_id.clone())
            .near(storage_cost)
            .with_signer(state.signer.clone())
            .send_to(&state.network)
            .await
            .map_err(|e| {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to send storage top-up transaction: {}", e),
                )
            })?
            .into_result()
            .map_err(|e| {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to send storage top-up transaction: {}", e),
                )
            })?;
    }

    // Step 6: Submit the wrapped delegate action transaction.
    let execution_result = Transaction::construct(state.signer_id.clone(), receiver_id)
        .add_action(Action::Delegate(Box::new(signed_delegate_action)))
        .with_signer(state.signer.clone())
        .send_to(&state.network)
        .await;

    match execution_result {
        Ok(result) => {
            // Capture the debug representation before consuming the result
            let result_debug = format!("{:?}", result);
            match result.into_result() {
                Ok(_) => {
                    // Step 7: Decrement gas-covered credits and accumulate paid_near in one query
                    let near_spent = if should_balance_storage {
                        storage_cost.saturating_add(deposits)
                    } else {
                        deposits
                    };
                    let near_spent_yocto: BigDecimal = near_spent.as_yoctonear().into();
                    let db_result = sqlx::query_as::<_, (i32,)>(
                        r#"
                    UPDATE monitored_accounts
                    SET gas_covered_transactions = GREATEST(gas_covered_transactions - 1, 0),
                        paid_near = paid_near + $2,
                        updated_at = NOW()
                    WHERE account_id = $1
                    RETURNING gas_covered_transactions
                    "#,
                    )
                    .bind(request.treasury_id.as_str())
                    .bind(near_spent_yocto)
                    .fetch_optional(&state.db_pool)
                    .await;

                    match db_result {
                        Ok(Some((new_credits,))) => {
                            log::info!(
                                "Decremented gas credits for treasury {}. New balance: {}",
                                request.treasury_id.as_str(),
                                new_credits
                            );
                        }
                        Ok(None) => {
                            log::warn!(
                                "Treasury {} not found for credit decrement",
                                request.treasury_id.as_str()
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "Failed to decrement gas credits for {}: {}",
                                request.treasury_id.as_str(),
                                e
                            );
                            // Don't fail - the relay already succeeded
                        }
                    }

                    // Record usage metrics in one round-trip.
                    // gas_covered_transactions fires for every relayed action.
                    // The proposal metric only fires when proposalType is explicitly provided.
                    let proposal_metric = match request.proposal_type.as_deref() {
                        Some("swap") => {
                            Some(crate::services::platform_metrics::PlatformMetric::SwapProposals)
                        }
                        Some("payment") => {
                            Some(crate::services::platform_metrics::PlatformMetric::PaymentProposals)
                        }
                        Some("vote") => {
                            Some(crate::services::platform_metrics::PlatformMetric::VotesCasted)
                        }
                        Some(_) => Some(
                            crate::services::platform_metrics::PlatformMetric::OtherProposalsSubmitted,
                        ),
                        None => None,
                    };
                    let mut metrics = vec![
                        crate::services::platform_metrics::PlatformMetric::GasCoveredTransactions,
                    ];
                    if let Some(proposal_metric) = proposal_metric {
                        metrics.push(proposal_metric);
                    }
                    if request.address_book_payment
                        && request.proposal_type.as_deref() == Some("payment")
                    {
                        metrics.push(
                            crate::services::platform_metrics::PlatformMetric::AddressBookPaymentProposals,
                        );
                    }
                    crate::services::platform_metrics::record_events(
                        &state.db_pool,
                        request.treasury_id.as_str(),
                        &metrics,
                    )
                    .await;

                    // If this is a vote on a confidential_transfer proposal (v1.signer),
                    // try to extract the MPC signature and auto-submit the signed intent.
                    if request.proposal_type.as_deref() == Some("vote")
                        && let Some(payload_hash) = confidential_payload_hash.clone()
                    {
                        tokio::spawn({
                            let state = state.clone();
                            let treasury_id = request.treasury_id.to_string();
                            let result_debug = result_debug.clone();
                            async move {
                                crate::handlers::relay::confidential::try_auto_submit_intent(
                                    &state,
                                    &treasury_id,
                                    &payload_hash,
                                    &result_debug,
                                )
                                .await;
                            }
                        });
                    }

                    Ok(Json(RelayResponse {
                        success: true,
                        error: None,
                    }))
                }
                Err(e) => {
                    log::error!("Delegate action execution failed: {:?}", e);
                    Err(error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Execution failed: {}", e),
                    ))
                }
            }
        }
        Err(e) => {
            log::error!("Failed to relay delegate action: {:?}", e);
            Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to relay: {}", e),
            ))
        }
    }
}

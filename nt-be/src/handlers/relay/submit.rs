//! The relay endpoint: orchestrates the sponsor pipeline for one delegate action.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use borsh::BorshDeserialize;
use near_api::{AccountId, NearToken, types::transaction::delegate_action::SignedDelegateAction};

use crate::{
    AppState,
    auth::AuthUser,
    handlers::relay::{
        access, accounting, confidential,
        dto::{RelayError, RelayRequest, RelayResponse, error_response, success_response},
        proposal::{self, ParsedRelay},
        sponsor::{ExecutionDebug, Sponsor},
        sponsorship::{self, SpentNear},
        storage_deposit, wallet,
    },
};

/// Relay a sponsored delegate action to the NEAR network.
///
/// Two shapes are accepted and share this pipeline:
///
/// * **NEP-366 meta-transaction** — the user signs a delegate action against their
///   DAO; it is wrapped and sent to its `sender_id`, signed with the relayer key.
/// * **`w_execute_signed`** — the user's signature lives inside the wallet contract
///   call; the inner DAO proposal calls are replayed by the sponsor.
///
/// Critical steps (parse, authorize, limits, storage, registrations, submit) gate
/// the response; on success the gas credit, metrics, and confidential auto-submit
/// are offloaded to the background.
pub async fn relay_delegate_action(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(relay_request): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, RelayError> {
    // 1. Decode the signed delegate action and recognize its wire shape.
    let signed_delegate_action = SignedDelegateAction::try_from_slice(
        &relay_request.signed_delegate_action.0,
    )
    .map_err(|e| error_response(StatusCode::BAD_REQUEST, format!("Invalid delegate action: {}", e)))?;
    let is_wallet_contract_action = wallet::is_wallet_contract_action(&signed_delegate_action);
    // The delegate action's receiver: the user's wallet contract for
    // `w_execute_signed`, or the DAO treasury for a meta-transaction.
    let action_receiver_id = signed_delegate_action.delegate_action.receiver_id.clone();

    // 2. Flatten both shapes into the proposal operations we will sponsor; reject
    //    anything that is not an add_proposal/act_proposal targeting the treasury.
    let ParsedRelay {
        proposals,
        attached_deposit,
    } = proposal::parse_sponsored_proposals(
        &relay_request.treasury_id,
        is_wallet_contract_action,
        &action_receiver_id,
        &signed_delegate_action.delegate_action.actions,
    )
    .map_err(|msg| error_response(StatusCode::BAD_REQUEST, msg))?;

    // 3. Load the treasury record (tracked ⇒ whitelisted Sputnik DAO) and authorize.
    let treasury_record = access::fetch_treasury_record(&state, &relay_request.treasury_id).await?;
    let tier = access::authorize(
        &state,
        &auth_user,
        &relay_request,
        &signed_delegate_action,
        is_wallet_contract_action,
        &action_receiver_id,
        treasury_record.as_ref(),
        &proposals,
    )
    .await?;

    // 4. Bound the attached deposit, then compensate the DAO contract for the
    //    storage a NEW proposal occupies. Only `add_proposal` grows DAO storage, so
    //    `act_proposal`-only relays (votes) get no top-up.
    let compensate_proposal_storage = sponsorship::is_sputnik_treasury(
        &relay_request.treasury_id,
        treasury_record.is_some(),
    ) && proposal::contains_add_proposal(&proposals);
    let proposal_storage_cost = if compensate_proposal_storage {
        sponsorship::proposal_storage_cost(relay_request.storage_bytes.0)
    } else {
        NearToken::from_near(0)
    };
    sponsorship::enforce_deposit_limit(
        &state,
        &relay_request.treasury_id,
        tier,
        attached_deposit,
        proposal_storage_cost,
    )
    .await?;
    if compensate_proposal_storage {
        sponsorship::top_up_proposal_storage(
            &state,
            &relay_request.treasury_id,
            relay_request.storage_bytes.0,
            proposal_storage_cost,
        )
        .await?;
    }
    // The proposal-storage top-up leaves the sponsor's account the moment it lands,
    // so it is charged to `paid_near` even if a later step fails. (Already zero when
    // we don't compensate.)
    let proposal_storage_spend = proposal_storage_cost;
    let fronted_spend = |registrations_spend| SpentNear {
        proposal_storage: proposal_storage_spend,
        deposits: NearToken::from_near(0),
        registrations: registrations_spend,
    };

    // 5. Sponsor-paid NEP-141 registrations for any approving votes. Their spend is
    //    recorded even when a required registration fails and aborts the relay.
    let registrations =
        storage_deposit::register_vote_approvals(&state, &relay_request.treasury_id, &proposals)
            .await;
    if let Some(registration_error) = registrations.error {
        accounting::spawn_record_spend(
            &state,
            &relay_request.treasury_id,
            fronted_spend(registrations.spent),
        );
        return Err(registration_error);
    }
    let registrations_spend = registrations.spent;

    // 6. Submit (retried on transient send errors via on-chain nonce protection).
    //    On failure the NEAR already fronted is still recorded; no credit is spent.
    let execution_debug = match execute_relay(
        &state,
        is_wallet_contract_action,
        signed_delegate_action,
        &action_receiver_id,
    )
    .await
    {
        Ok(execution_debug) => execution_debug,
        Err(submit_error) => {
            accounting::spawn_record_spend(
                &state,
                &relay_request.treasury_id,
                fronted_spend(registrations_spend),
            );
            return Err(submit_error);
        }
    };

    // 7. Success: charge a gas credit plus the full spend (incl. attached deposits),
    //    then run the remaining non-critical work in the background.
    accounting::spawn_charge(
        &state,
        &relay_request.treasury_id,
        SpentNear {
            proposal_storage: proposal_storage_spend,
            deposits: attached_deposit,
            registrations: registrations_spend,
        },
    );
    accounting::record_metrics(&state, &relay_request);
    if relay_request.proposal_type.as_deref() == Some("vote") {
        confidential::spawn_auto_submit_intents(
            &state,
            relay_request.treasury_id.as_str(),
            proposal::confidential_payload_hashes(&proposals),
            &execution_debug,
        );
    }

    Ok(success_response())
}

/// Submit the relay transaction and return the execution result's debug string,
/// which `confidential` later mines for MPC signatures.
async fn execute_relay(
    state: &Arc<AppState>,
    is_wallet_contract_action: bool,
    signed_delegate_action: SignedDelegateAction,
    action_receiver_id: &AccountId,
) -> Result<ExecutionDebug, RelayError> {
    let sponsor = Sponsor::from_state(state);
    let execution = if is_wallet_contract_action {
        sponsor
            .replay_actions(
                action_receiver_id,
                &signed_delegate_action.delegate_action.actions,
            )
            .await
    } else {
        sponsor.relay_meta_tx(signed_delegate_action).await
    };

    execution.map_err(|error_message| {
        log::error!("Relay execution failed: {}", error_message);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, error_message)
    })
}

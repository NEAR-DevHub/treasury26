//! The relay endpoint: orchestrates the sponsor pipeline for one delegate action.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use borsh::BorshDeserialize;
use near_api::{AccountId, NearToken, types::transaction::delegate_action::SignedDelegateAction};

use crate::{
    AppState,
    auth::AuthUser,
    handlers::relay::{
        access, confidential,
        dto::{RelayError, RelayRequest, RelayResponse, error_response, success_response},
        effects::{accounting, registrations},
        parse::{self, ParsedRelay, RelayShape},
        sponsor::{
            ExecutionDebug, Sponsor,
            policy::{self, SpentNear},
        },
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
    .map_err(|e| {
        error_response(
            StatusCode::BAD_REQUEST,
            format!("Invalid delegate action: {}", e),
        )
    })?;
    // The delegate action's receiver: the user's wallet contract for
    // `w_execute_signed`, or the DAO treasury for a meta-transaction.
    let action_receiver_id = signed_delegate_action.delegate_action.receiver_id.clone();

    // 2. Flatten both shapes into the proposal operations we will sponsor; reject
    //    anything that is not an add_proposal/act_proposal targeting the treasury.
    //    The parser also reports which wire shape the relay arrived in.
    let ParsedRelay {
        shape,
        operation,
        attached_deposit,
    } = parse::parse_sponsored_proposals(
        &relay_request.treasury_id,
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
        shape,
        &action_receiver_id,
        treasury_record.as_ref(),
        &operation,
    )
    .await?;

    // 4. Bound the attached deposit, then compensate the DAO contract for the
    //    storage a NEW proposal occupies. Only `add_proposal` grows DAO storage, so
    //    `act_proposal`-only relays (votes) get no top-up.
    let compensate_proposal_storage =
        policy::is_sputnik_treasury(&relay_request.treasury_id, treasury_record.is_some())
            && operation.is_add_proposals();
    let proposal_storage_cost = if compensate_proposal_storage {
        policy::proposal_storage_cost(relay_request.storage_bytes.0)
    } else {
        NearToken::from_near(0)
    };
    policy::enforce_deposit_limit(
        &state,
        &relay_request.treasury_id,
        tier,
        attached_deposit,
        proposal_storage_cost,
    )
    .await?;
    if compensate_proposal_storage {
        policy::top_up_proposal_storage(
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
    let approve_proposal_ids = operation.vote_approve_ids();
    let registrations = registrations::register_vote_approvals(
        &state,
        &relay_request.treasury_id,
        &approve_proposal_ids,
    )
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
    let execution_debug =
        match execute_relay(&state, shape, signed_delegate_action, &action_receiver_id).await {
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
    // Empty for add-proposal relays, so this is a no-op outside confidential votes.
    confidential::spawn_auto_submit_intents(
        &state,
        relay_request.treasury_id.as_str(),
        operation.confidential_payload_hashes(),
        &execution_debug,
    );

    Ok(success_response())
}

/// Submit the relay transaction and return the execution result's debug string,
/// which `confidential` later mines for MPC signatures.
async fn execute_relay(
    state: &Arc<AppState>,
    shape: RelayShape,
    signed_delegate_action: SignedDelegateAction,
    action_receiver_id: &AccountId,
) -> Result<ExecutionDebug, RelayError> {
    let sponsor = Sponsor::from_state(state);
    let execution = match shape {
        RelayShape::WalletContract => {
            // Rebuild the outer w_execute_signed actions with their deposit set to the
            // sponsored inner bond, so the sponsor attaches exactly the bounded amount.
            let replay_actions =
                parse::build_sponsored_actions(&signed_delegate_action.delegate_action.actions)
                    .map_err(|message| {
                        error_response(StatusCode::INTERNAL_SERVER_ERROR, message)
                    })?;
            sponsor
                .replay_actions(action_receiver_id, replay_actions)
                .await
        }
        RelayShape::MetaTransaction => sponsor.relay_meta_tx(signed_delegate_action).await,
    };

    execution.map_err(|error_message| {
        log::error!("Relay execution failed: {}", error_message);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, error_message)
    })
}

//! The relay endpoint: orchestrates the sponsor pipeline for one delegate action.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use borsh::BorshDeserialize;
use near_api::{
    AccountId, NearToken,
    types::transaction::{
        delegate_action::SignedDelegateAction,
        result::{ExecutionFinalResult, ValueOrReceiptId},
    },
};

use crate::{
    AppState,
    auth::AuthUser,
    handlers::relay::{
        access::{self, AuthorizedRelay},
        confidential,
        effects::{accounting, registrations},
        parse::{
            self, RelayError, RelayRequest, RelayResponse, RelaySubmission, error_response,
            success_response,
        },
        sponsor::{
            OutcomeDebug, Sponsor,
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
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(step = "relay_delegate_action", treasury_id = tracing::field::Empty)
)]
pub async fn relay_delegate_action(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(relay_request): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, RelayError> {
    // Decouple the request into owned parts so the raw signed action and the
    // treasury id are independent from here on.
    let RelayRequest {
        treasury_id,
        // Ignored: the sponsored storage is derived server-side from the parsed
        // proposal, never from this client-supplied number.
        storage_bytes: _,
        signed_delegate_action: raw_signed_delegate_action,
        proposal_type,
        address_book_payment,
    } = relay_request;
    tracing::Span::current().record("treasury_id", tracing::field::display(&treasury_id));

    // 1. Decode the borsh bytes once; the raw form is dropped here.
    let signed_delegate_action =
        SignedDelegateAction::try_from_slice(&raw_signed_delegate_action.0).map_err(|e| {
            error_response(
                StatusCode::BAD_REQUEST,
                format!("Invalid delegate action: {}", e),
            )
        })?;

    // 2. Consume the signed action into the operation to sponsor and how to submit
    //    it; reject anything that is not an add_proposal/act_proposal on the treasury.
    let parsed = parse::parse_sponsored_proposals(treasury_id, signed_delegate_action)
        .map_err(|msg| error_response(StatusCode::BAD_REQUEST, msg))?;

    // 3. Load the treasury record and authorize, consuming the parsed relay. The
    //    returned AuthorizedRelay proves the treasury is a tracked Sputnik DAO.
    let treasury_record = access::fetch_treasury_record(&state, &parsed.treasury_id).await?;
    let AuthorizedRelay {
        treasury_id,
        submission,
        operation,
        attached_deposit,
        tier,
        plan_type,
        proposal_storage_bytes,
    } = access::authorize(&state, &auth_user, parsed, treasury_record).await?;

    // 4. Bound the attached deposit and size the DAO-storage compensation. Only
    //    `add_proposal` grows DAO storage, so `act_proposal`-only relays (votes) get no
    //    top-up. The storage figure is derived server-side from the parsed proposal and
    //    clamped to the cap by `proposal_storage_cost` — the client's `storageBytes` is
    //    never trusted. Both `enforce_deposit_limit` and the reservation below are pure
    //    validation/bookkeeping that complete BEFORE any sponsor NEAR moves.
    let compensate_proposal_storage = operation.is_add_proposals();
    let proposal_storage_cost = if compensate_proposal_storage {
        policy::proposal_storage_cost(proposal_storage_bytes)
    } else {
        NearToken::from_near(0)
    };
    policy::enforce_deposit_limit(
        &state,
        &treasury_id,
        tier,
        attached_deposit,
        proposal_storage_cost,
    )
    .await?;

    // 5. Atomically reserve the gas credit BEFORE any sponsor spend, so concurrent
    //    relays cannot double-spend one credit. Nothing has moved yet, so any failure
    //    here (402 "no credits" or 500 "row missing") needs no refund — the credit
    //    table is already in its final state from the conditional UPDATE itself.
    //    On any later failure that abandons the relay we refund it (preserving today's
    //    "a failed relay consumes no credit" behavior).
    let credit_reservation =
        accounting::reserve_gas_credit(&state.db_pool, &treasury_id, plan_type).await?;

    // 6. Compensate the DAO contract for the new proposal's storage. This is the first
    //    step that moves sponsor NEAR; a failure refunds the reserved credit.
    if compensate_proposal_storage
        && let Err(top_up_error) =
            policy::top_up_proposal_storage(&state, &treasury_id, proposal_storage_cost).await
    {
        accounting::spawn_refund_gas_credit(&state, &treasury_id, credit_reservation);
        return Err(top_up_error);
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

    // 7. Sponsor-paid NEP-141 registrations for any approving votes. Their spend is
    //    recorded even when a required registration fails and aborts the relay.
    let approve_proposal_ids = operation.vote_approve_ids();
    let registrations =
        registrations::register_vote_approvals(&state, &treasury_id, &approve_proposal_ids).await;
    if let Some(registration_error) = registrations.error {
        accounting::spawn_record_spend(&state, &treasury_id, fronted_spend(registrations.spent));
        accounting::spawn_refund_gas_credit(&state, &treasury_id, credit_reservation);
        return Err(registration_error);
    }
    let registrations_spend = registrations.spent;

    // 8. Submit (retried on transient send errors via on-chain nonce protection).
    //    On failure the NEAR already fronted is still recorded and the reserved credit
    //    is refunded.
    let outcome = match submit_relay(&state, submission).await {
        Ok(outcome) => outcome,
        Err(submit_error) => {
            accounting::spawn_record_spend(
                &state,
                &treasury_id,
                fronted_spend(registrations_spend),
            );
            accounting::spawn_refund_gas_credit(&state, &treasury_id, credit_reservation);
            return Err(submit_error);
        }
    };

    // 9. Success: the gas credit was already reserved in step 5, so here we only record
    //    the full sponsored spend (incl. attached deposits), then run the remaining
    //    non-critical work in the background.
    accounting::spawn_record_spend(
        &state,
        &treasury_id,
        SpentNear {
            proposal_storage: proposal_storage_spend,
            deposits: attached_deposit,
            registrations: registrations_spend,
        },
    );
    accounting::record_metrics(
        &state,
        &treasury_id,
        proposal_type.as_deref(),
        address_book_payment,
    );
    let outcome_debug: OutcomeDebug = format!("{:?}", outcome);
    // Empty for add-proposal relays, so this is a no-op outside confidential votes.
    confidential::spawn_auto_submit_intents(
        &state,
        treasury_id.as_str(),
        operation.confidential_payloads_with_ids(),
        &outcome_debug,
    );

    let proposal_ids = operation
        .is_add_proposals()
        .then(|| created_proposal_ids(&outcome, &treasury_id));
    Ok(success_response(proposal_ids))
}

/// Ids of the proposals this relay created, read from the execution outcome:
/// `add_proposal` returns the new proposal's id, so every receipt executed on
/// the treasury whose success value is a bare integer contributes one.
fn created_proposal_ids(outcome: &ExecutionFinalResult, treasury_id: &AccountId) -> Vec<u64> {
    outcome
        .receipt_outcomes()
        .iter()
        .filter(|receipt| &receipt.executor_id == treasury_id)
        .filter_map(|receipt| match receipt.clone().into_result() {
            Ok(ValueOrReceiptId::Value(value)) => value.json::<u64>().ok(),
            _ => None,
        })
        .collect()
}

/// Submit the relay transaction and return its execution outcome; `confidential`
/// later mines its debug form for MPC signatures.
#[tracing::instrument(level = "info", skip_all, fields(step = "submit_relay"))]
async fn submit_relay(
    state: &Arc<AppState>,
    submission: RelaySubmission,
) -> Result<ExecutionFinalResult, RelayError> {
    let sponsor = Sponsor::from_state(state);
    let result = match submission {
        RelaySubmission::WalletContract(replay) => {
            sponsor
                .replay_actions(&replay.wallet_account, replay.actions)
                .await
        }
        RelaySubmission::MetaTransaction(signed_delegate_action) => {
            sponsor.relay_meta_tx(signed_delegate_action).await
        }
    };

    // `error_response` logs the failure at ERROR (→ Sentry); no extra log
    // here or the same failure would produce two events.
    result.map_err(|error_message| error_response(StatusCode::INTERNAL_SERVER_ERROR, error_message))
}

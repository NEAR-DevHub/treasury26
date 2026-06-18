//! Authorization for a relay request: who may have it sponsored, and on what terms.

use std::{collections::HashSet, sync::Arc};

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use near_api::{AccountId, NearToken};

use crate::{
    AppState,
    auth::AuthUser,
    config::plans::{PlanType, has_gas_covered_credits},
    handlers::relay::{
        parse::{ParsedRelay, RelayError, RelayOperation, RelaySubmission, error_response},
        sponsor::policy::SponsorshipTier,
    },
};

/// The treasury's `monitored_accounts` row, as far as the relay cares.
pub struct TreasuryRecord {
    pub gas_covered_transactions: i32,
    pub plan_type: PlanType,
    pub created_at: DateTime<Utc>,
}

/// A relay that passed [`authorize`]: the same payload as [`ParsedRelay`] plus the
/// resolved sponsorship tier. Holding one is proof the treasury is tracked (a
/// sanctioned Sputnik DAO), so downstream code needs no further "is this a Sputnik
/// DAO?" check.
pub struct AuthorizedRelay {
    pub treasury_id: AccountId,
    pub submission: RelaySubmission,
    pub operation: RelayOperation,
    pub attached_deposit: NearToken,
    pub tier: SponsorshipTier,
}

/// Fetch the treasury's `monitored_accounts` row, if it is tracked. Presence here is
/// also the "sanctioned Sputnik DAO" signal, enforced by [`authorize`].
#[tracing::instrument(level = "debug", skip_all, fields(treasury_id = %treasury_id))]
pub async fn fetch_treasury_record(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
) -> Result<Option<TreasuryRecord>, RelayError> {
    sqlx::query_as::<_, (i32, PlanType, DateTime<Utc>)>(
        r#"
        SELECT gas_covered_transactions, plan_type, created_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(treasury_id.as_str())
    .fetch_optional(&state.db_pool)
    .await
    .map(|row| {
        row.map(
            |(gas_covered_transactions, plan_type, created_at)| TreasuryRecord {
                gas_covered_transactions,
                plan_type,
                created_at,
            },
        )
    })
    .map_err(|e| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Database error: {}", e),
        )
    })
}

/// Authorize the parsed relay, consuming it and returning the [`AuthorizedRelay`].
///
/// Three checks, in order:
///
/// 1. **Identity** binds to the authenticated user differently per wire shape:
///    `w_execute_signed` carries the user's own on-chain-verified signature, so we
///    check the receiver is the user's wallet account; a meta-transaction is bound
///    to its `sender_id`.
/// 2. **DAO proposal/vote permissions** are checked from the parsed operation, so
///    the rule is identical for both shapes (the proposal calls are the same; only
///    their envelope differs).
/// 3. **Billing** applies to every sponsored request regardless of wire shape: the
///    treasury must be tracked in `monitored_accounts` and have gas-covered credits.
///
/// The tier follows the treasury (its onboarding date), NOT the wire shape: an old
/// DAO accessed via a `w_execute_signed` wallet still gets bond-based sponsorship.
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(step = "relay_access", treasury_id = tracing::field::Empty)
)]
pub async fn authorize(
    state: &Arc<AppState>,
    auth_user: &AuthUser,
    parsed: ParsedRelay,
    treasury_record: Option<TreasuryRecord>,
) -> Result<AuthorizedRelay, RelayError> {
    let ParsedRelay {
        treasury_id,
        submission,
        operation,
        attached_deposit,
    } = parsed;
    tracing::Span::current().record("treasury_id", tracing::field::display(&treasury_id));

    // 1. Identity binding (shape-specific).
    match &submission {
        RelaySubmission::WalletContract(replay) => {
            if replay.wallet_account != auth_user.account_id {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    format!(
                        "w_execute_signed receiver '{}' does not match authenticated user '{}'",
                        replay.wallet_account, auth_user.account_id
                    ),
                ));
            }
        }
        RelaySubmission::MetaTransaction(signed_delegate_action) => {
            let sender_id = &signed_delegate_action.delegate_action.sender_id;
            if sender_id != &auth_user.account_id {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    format!(
                        "Delegate action sender '{}' does not match authenticated user '{}'",
                        sender_id, auth_user.account_id
                    ),
                ));
            }
        }
    }

    // 2. DAO proposal/vote permissions — equal for both shapes.
    verify_proposal_access(state, auth_user, &treasury_id, &operation).await?;

    // 3. Billing — equal for every sponsored request: the treasury must be tracked
    //    and have gas-covered credits.
    let treasury_record = treasury_record.ok_or_else(|| {
        error_response(
            StatusCode::NOT_FOUND,
            format!(
                "Treasury '{}' not found in monitored accounts",
                treasury_id.as_str()
            ),
        )
    })?;
    if !has_gas_covered_credits(
        treasury_record.plan_type,
        treasury_record.gas_covered_transactions,
    ) {
        return Err(error_response(
            StatusCode::PAYMENT_REQUIRED,
            "No gas-covered transaction credits remaining. Please upgrade your plan.",
        ));
    }

    Ok(AuthorizedRelay {
        tier: SponsorshipTier::for_treasury(treasury_record.created_at),
        treasury_id,
        submission,
        operation,
        attached_deposit,
    })
}

/// Verify the authenticated user may perform the relay's operation on the treasury,
/// following on-chain DAO permissions: `add_proposal` needs add permission; each
/// distinct vote needs the matching vote permission (including Everyone roles).
/// Derived from the parsed operation so it is identical for both wire shapes.
#[tracing::instrument(level = "debug", skip_all, fields(treasury_id = %treasury_id))]
async fn verify_proposal_access(
    state: &Arc<AppState>,
    auth_user: &AuthUser,
    treasury_id: &AccountId,
    operation: &RelayOperation,
) -> Result<(), RelayError> {
    match operation {
        RelayOperation::AddProposals(_) => auth_user
            .verify_can_add_proposal(state, treasury_id)
            .await
            .map_err(|(status, msg)| error_response(status, msg)),
        RelayOperation::Votes(votes) => {
            let mut vote_actions = HashSet::new();
            for vote in votes {
                match vote.action.as_str() {
                    "VoteApprove" | "VoteReject" | "VoteRemove" => {
                        vote_actions.insert(vote.action.clone());
                    }
                    other => {
                        return Err(error_response(
                            StatusCode::BAD_REQUEST,
                            format!("Unsupported vote action '{}'", other),
                        ));
                    }
                }
            }

            let policy = auth_user
                .fetch_dao_policy(state, treasury_id)
                .await
                .map_err(|(status, msg)| error_response(status, msg))?;
            for vote_action in vote_actions {
                auth_user
                    .verify_can_perform_action_with_policy(&policy, treasury_id, &vote_action)
                    .map_err(|(status, msg)| error_response(status, msg))?;
            }
            Ok(())
        }
    }
}

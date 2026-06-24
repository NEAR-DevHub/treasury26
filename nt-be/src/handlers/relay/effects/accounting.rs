//! Usage accounting for a successful relay: spend a gas credit, track `paid_near`,
//! and record platform metrics. All of it is non-critical and runs in the
//! background — a failure here never affects the relay response.

use std::sync::Arc;

use bigdecimal::BigDecimal;
use near_api::AccountId;

use super::background;
use crate::{
    AppState,
    handlers::relay::sponsor::policy::SpentNear,
    services::platform_metrics::{self, PlatformMetric},
};

/// Spend one gas-covered credit and add the sponsored NEAR to `paid_near`, in the
/// background. Called after the relay's on-chain transactions succeed.
pub fn spawn_charge(state: &Arc<AppState>, treasury_id: &AccountId, sponsored_spend: SpentNear) {
    apply_spend(state, treasury_id, sponsored_spend, true);
}

/// Record NEAR already fronted by the sponsor (storage top-up + registrations)
/// without consuming a gas credit. Used when the relay fails after that spend —
/// the NEAR is gone whether or not the delegate action executed.
pub fn spawn_record_spend(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    sponsored_spend: SpentNear,
) {
    apply_spend(state, treasury_id, sponsored_spend, false);
}

fn apply_spend(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    sponsored_spend: SpentNear,
    consume_credit: bool,
) {
    let state = state.clone();
    let treasury_id = treasury_id.clone();
    let label = if consume_credit {
        "charge relay"
    } else {
        "record relay spend"
    };
    background::spawn(label, async move {
        let total_spend = sponsored_spend.total();
        tracing::debug!(
            "relay spend for {} (consume_credit={}): proposal_storage={} deposits={} registrations={} total={}",
            treasury_id,
            consume_credit,
            sponsored_spend.proposal_storage,
            sponsored_spend.deposits,
            sponsored_spend.registrations,
            total_spend
        );

        let near_spent_yocto: BigDecimal = total_spend.as_yoctonear().into();
        let result = sqlx::query_as::<_, (i32,)>(
            r#"
            UPDATE monitored_accounts
            SET gas_covered_transactions =
                    GREATEST(gas_covered_transactions - CASE WHEN $3 THEN 1 ELSE 0 END, 0),
                paid_near = paid_near + $2,
                updated_at = NOW()
            WHERE account_id = $1
            RETURNING gas_covered_transactions
            "#,
        )
        .bind(treasury_id.as_str())
        .bind(near_spent_yocto)
        .bind(consume_credit)
        .fetch_optional(&state.db_pool)
        .await;

        match result {
            Ok(Some((new_credits,))) => tracing::info!(
                "Recorded relay spend for treasury {} (consume_credit={}). Credits: {}",
                treasury_id,
                consume_credit,
                new_credits
            ),
            Ok(None) => tracing::warn!("Treasury {} not found for relay spend", treasury_id),
            Err(e) => tracing::error!("Failed to record relay spend for {}: {}", treasury_id, e),
        }
    });
}

/// Record usage metrics for a successful relay in the background.
///
/// `gas_covered_transactions` fires for every relay; the proposal-type metric only
/// fires when `proposalType` was provided.
pub fn record_metrics(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    proposal_type: Option<&str>,
    address_book_payment: bool,
) {
    let mut metrics = vec![PlatformMetric::GasCoveredTransactions];
    match proposal_type {
        Some("swap") => metrics.push(PlatformMetric::SwapProposals),
        Some("payment") => metrics.push(PlatformMetric::PaymentProposals),
        Some("vote") => metrics.push(PlatformMetric::VotesCasted),
        Some(_) => metrics.push(PlatformMetric::OtherProposalsSubmitted),
        None => {}
    }
    if address_book_payment && proposal_type == Some("payment") {
        metrics.push(PlatformMetric::AddressBookPaymentProposals);
    }

    let state = state.clone();
    let treasury_id = treasury_id.to_string();
    background::spawn("record metrics", async move {
        platform_metrics::record_events(&state.db_pool, &treasury_id, &metrics).await;
    });
}

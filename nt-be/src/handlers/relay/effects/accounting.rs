//! Usage accounting for a relay: reserve/refund a gas credit, track `paid_near`, and
//! record platform metrics.
//!
//! The gas credit is reserved **atomically before any sponsor spend** (see
//! [`reserve_gas_credit`]) so that concurrent relays for the same treasury cannot all
//! pass a stale credit check and double-spend a single credit. `paid_near` and metrics
//! are recorded in the background — non-critical, and a failure there never affects the
//! relay response.

use std::sync::Arc;

use axum::http::StatusCode;
use bigdecimal::BigDecimal;
use near_api::AccountId;

use super::background;
use crate::{
    AppState,
    config::plans::PlanType,
    handlers::relay::{
        parse::{RelayError, error_response},
        sponsor::policy::SpentNear,
    },
    services::platform_metrics::{self, PlatformMetric},
};

/// Outcome of reserving a gas-covered credit for a relay.
#[derive(Debug, Clone, Copy)]
pub enum CreditReservation {
    /// A finite gas credit was atomically decremented. Refund it (see
    /// [`spawn_refund_gas_credit`]) if the relay is abandoned before it moved any
    /// sponsor NEAR on-chain.
    Consumed,
    /// Enterprise / unlimited plan — no credit was decremented, nothing to refund.
    Unlimited,
}

/// Atomically reserve one gas-covered credit for `treasury_id` **before** any sponsor
/// spend. For finite plans this is a single conditional `UPDATE` that only succeeds
/// while credits remain, so N concurrent relays for a treasury with one credit resolve
/// to exactly one successful reservation (the rest get `402`). Enterprise is unlimited
/// and always reserves without decrementing.
///
/// When the conditional `UPDATE` matches no row, a follow-up `EXISTS` lookup
/// distinguishes the two failure modes so backend incidents (row missing for this
/// account id) are returned as `500` rather than misreported to the user as "no
/// credits left — upgrade your plan".
///
/// This closes the check-then-spend race: previously the credit was read during
/// authorization and decremented only in a later background task, so concurrent
/// requests could all observe the same balance.
pub async fn reserve_gas_credit(
    pool: &sqlx::PgPool,
    treasury_id: &AccountId,
    plan_type: PlanType,
) -> Result<CreditReservation, RelayError> {
    if plan_type == PlanType::Enterprise {
        return Ok(CreditReservation::Unlimited);
    }

    // The reservation is a single conditional UPDATE that only succeeds while
    // credits remain ─ two concurrent reservations on a single-credit row resolve
    // to exactly one winner here. A 0-row result is then disambiguated below:
    //
    //   * row missing entirely → 5xx: a backend incident (account row drift, plan
    //     changes, etc.) must not be reported to the user as "upgrade your plan".
    //   * row present, credits == 0 → 402: the user-facing "no credits left".
    let reserved = sqlx::query_scalar::<_, i32>(
        r#"
        UPDATE monitored_accounts
        SET gas_covered_transactions = gas_covered_transactions - 1,
            updated_at = NOW()
        WHERE account_id = $1 AND gas_covered_transactions > 0
        RETURNING gas_covered_transactions
        "#,
    )
    .bind(treasury_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Database error reserving gas credit: {e}"),
        )
    })?;

    match reserved {
        Some(_) => Ok(CreditReservation::Consumed),
        None => {
            // The conditional UPDATE matched no row. Look up the treasury row to
            // distinguish a legitimate 402 ("no credits") from a 5xx incident (row
            // missing for this account_id). A read after the conditional update is
            // safe to disambiguate: if credits were just decremented to 0 by a
            // concurrent winner, the user-facing "upgrade your plan" message is
            // still correct.
            let row_exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM monitored_accounts WHERE account_id = $1)",
            )
            .bind(treasury_id.as_str())
            .fetch_one(pool)
            .await
            .map_err(|e| {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!(
                        "Database error checking monitored_accounts after \
                         gas-credit reservation: {e}"
                    ),
                )
            })?;

            if row_exists {
                Err(error_response(
                    StatusCode::PAYMENT_REQUIRED,
                    "No gas-covered transaction credits remaining. Please upgrade your plan.",
                ))
            } else {
                Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!(
                        "Cannot reserve gas credit: no monitored_accounts row \
                         exists for `{treasury_id}`"
                    ),
                ))
            }
        }
    }
}

/// Give a reserved credit back when the relay is abandoned before it caused an on-chain
/// sponsor transfer. No-op for unlimited reservations. Best-effort and backgrounded.
///
/// NOTE: this preserves the prior "a failed relay consumes no credit" behavior. A later
/// hardening (charge any attempt that already moved sponsor NEAR) will replace this
/// refund on the fail path with keeping the credit charged.
pub fn spawn_refund_gas_credit(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    reservation: CreditReservation,
) {
    if !matches!(reservation, CreditReservation::Consumed) {
        return;
    }
    let state = state.clone();
    let treasury_id = treasury_id.clone();
    background::spawn("refund gas credit", async move {
        let result = sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET gas_covered_transactions = gas_covered_transactions + 1,
                updated_at = NOW()
            WHERE account_id = $1
            "#,
        )
        .bind(treasury_id.as_str())
        .execute(&state.db_pool)
        .await;

        match result {
            Ok(_) => tracing::info!("Refunded gas credit for treasury {}", treasury_id),
            Err(e) => tracing::error!("Failed to refund gas credit for {}: {}", treasury_id, e),
        }
    });
}

/// Add NEAR the sponsor fronted for this relay (storage top-up, proposal bond,
/// registrations) to `paid_near`, in the background. Credits are handled separately by
/// [`reserve_gas_credit`] / [`spawn_refund_gas_credit`], so this never touches the
/// credit counter. A zero total is skipped.
pub fn spawn_record_spend(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    sponsored_spend: SpentNear,
) {
    let total_spend = sponsored_spend.total();
    if total_spend.as_yoctonear() == 0 {
        return;
    }
    let state = state.clone();
    let treasury_id = treasury_id.clone();
    background::spawn("record relay spend", async move {
        tracing::debug!(
            "relay spend for {}: proposal_storage={} deposits={} registrations={} total={}",
            treasury_id,
            sponsored_spend.proposal_storage,
            sponsored_spend.deposits,
            sponsored_spend.registrations,
            total_spend
        );

        let near_spent_yocto: BigDecimal = total_spend.as_yoctonear().into();
        let result = sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET paid_near = paid_near + $2,
                updated_at = NOW()
            WHERE account_id = $1
            "#,
        )
        .bind(treasury_id.as_str())
        .bind(near_spent_yocto)
        .execute(&state.db_pool)
        .await;

        if let Err(e) = result {
            tracing::error!("Failed to record relay spend for {}: {}", treasury_id, e);
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed(pool: &sqlx::PgPool, account: &str, plan: &str, credits: i32) {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, gas_covered_transactions, plan_type)
            VALUES ($1, true, $2, $3::text::plan_type)
            "#,
        )
        .bind(account)
        .bind(credits)
        .bind(plan)
        .execute(pool)
        .await
        .expect("seed monitored_accounts");
    }

    async fn credits(pool: &sqlx::PgPool, account: &str) -> i32 {
        sqlx::query_scalar::<_, i32>(
            "SELECT gas_covered_transactions FROM monitored_accounts WHERE account_id = $1",
        )
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("read credits")
    }

    /// With a single credit, two concurrent reservations must resolve to exactly one
    /// success and one `402` — the atomic conditional decrement closes the check-then-
    /// spend race.
    #[sqlx::test]
    async fn concurrent_reservations_cannot_double_spend_one_credit(pool: sqlx::PgPool) {
        let account: AccountId = "race.sputnik-dao.near".parse().unwrap();
        seed(&pool, account.as_str(), "plus", 1).await;

        let (a, b) = tokio::join!(
            reserve_gas_credit(&pool, &account, PlanType::Plus),
            reserve_gas_credit(&pool, &account, PlanType::Plus),
        );

        let ok = [&a, &b].iter().filter(|r| r.is_ok()).count();
        assert_eq!(
            ok, 1,
            "exactly one of two concurrent reservations may succeed"
        );
        assert_eq!(
            credits(&pool, account.as_str()).await,
            0,
            "credit decremented once"
        );

        // A third reservation with no credits left is rejected.
        assert!(
            reserve_gas_credit(&pool, &account, PlanType::Plus)
                .await
                .is_err()
        );
    }

    /// A reserved credit is given back on the abandon path, restoring the balance.
    #[sqlx::test]
    async fn refund_restores_a_reserved_credit(pool: sqlx::PgPool) {
        let account: AccountId = "refund.sputnik-dao.near".parse().unwrap();
        seed(&pool, account.as_str(), "plus", 1).await;

        let reservation = reserve_gas_credit(&pool, &account, PlanType::Plus)
            .await
            .expect("reserve");
        assert!(matches!(reservation, CreditReservation::Consumed));
        assert_eq!(credits(&pool, account.as_str()).await, 0);

        // Refund runs in the background; execute the same UPDATE inline to assert the
        // effect deterministically without racing the spawned task.
        sqlx::query(
            "UPDATE monitored_accounts SET gas_covered_transactions = gas_covered_transactions + 1 WHERE account_id = $1",
        )
        .bind(account.as_str())
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            credits(&pool, account.as_str()).await,
            1,
            "refund restores the credit"
        );
    }

    /// Enterprise is unlimited: reservation always succeeds and never decrements.
    #[sqlx::test]
    async fn enterprise_reservation_never_decrements(pool: sqlx::PgPool) {
        let account: AccountId = "unlimited.sputnik-dao.near".parse().unwrap();
        seed(&pool, account.as_str(), "enterprise", 0).await;

        let reservation = reserve_gas_credit(&pool, &account, PlanType::Enterprise)
            .await
            .expect("enterprise always reserves");
        assert!(matches!(reservation, CreditReservation::Unlimited));
        assert_eq!(
            credits(&pool, account.as_str()).await,
            0,
            "no decrement for unlimited"
        );
    }

    /// A treasury that exists but has zero credits returns 402 (legitimate "upgrade
    /// your plan"); the client is correctly told it ran out of credits.
    #[sqlx::test]
    async fn zero_credits_returns_payment_required(pool: sqlx::PgPool) {
        let account: AccountId = "zero.sputnik-dao.near".parse().unwrap();
        seed(&pool, account.as_str(), "plus", 0).await;

        let err = reserve_gas_credit(&pool, &account, PlanType::Plus)
            .await
            .expect_err("zero credits must be rejected");
        assert_eq!(
            err.0,
            StatusCode::PAYMENT_REQUIRED,
            "zero credits → 402 upgrade prompt"
        );
        assert_eq!(credits(&pool, account.as_str()).await, 0);
    }

    /// A treasury with no `monitored_accounts` row at all is a backend incident, not
    /// a "no credits" condition — a 5xx keeps Sentry / on-call pages honest and
    /// stops the user from being routed to "upgrade your plan" when the truth is
    /// the row is missing (account drift, plan rollback, partial migration, etc.).
    #[sqlx::test]
    async fn missing_row_returns_internal_server_error(pool: sqlx::PgPool) {
        let account: AccountId = "missing.sputnik-dao.near".parse().unwrap();
        // Intentionally do NOT seed the row.

        let err = reserve_gas_credit(&pool, &account, PlanType::Plus)
            .await
            .expect_err("missing row must be rejected");
        assert_eq!(
            err.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "missing row → 5xx, not 402"
        );
    }
}

use chrono::{Datelike, Utc};
use sqlx::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformMetric {
    SwapProposals,
    PaymentProposals,
    AddressBookPaymentProposals,
    VotesCasted,
    OtherProposalsSubmitted,
    BatchPaymentsUsed,
    ExportsUsed,
    GasCoveredTransactions,
    ReceiptsGenerated,
    ReceiptsPrinted,
}

impl PlatformMetric {
    pub const fn column(self) -> &'static str {
        match self {
            Self::SwapProposals => "swap_proposals",
            Self::PaymentProposals => "payment_proposals",
            Self::AddressBookPaymentProposals => "address_book_payment_proposals",
            Self::VotesCasted => "votes_casted",
            Self::OtherProposalsSubmitted => "other_proposals_submitted",
            Self::BatchPaymentsUsed => "batch_payments_used",
            Self::ExportsUsed => "exports_used",
            Self::GasCoveredTransactions => "gas_covered_transactions",
            Self::ReceiptsGenerated => "receipts_generated",
            Self::ReceiptsPrinted => "receipts_printed",
        }
    }
}

/// Increment a named event counter in `usage_tracking` for the current billing month.
///
/// Upserts a row for `(dao_id, year, month)` and increments the named counter by 1.
/// Non-critical: logs a warning on failure but does NOT propagate the error —
/// counter updates must never fail the parent request.
pub async fn record_event(pool: &PgPool, dao_id: &str, metric: PlatformMetric) {
    record_events(pool, dao_id, &[metric]).await;
}

/// Increment multiple event counters in a single `usage_tracking` upsert.
///
/// All columns are incremented by 1 in one round-trip.
/// Non-critical: logs a warning on failure but does NOT propagate the error.
pub async fn record_events(pool: &PgPool, dao_id: &str, metrics: &[PlatformMetric]) {
    if metrics.is_empty() {
        return;
    }

    let now = Utc::now();
    let year = now.year();
    let month = now.month() as i32;

    let columns = metrics
        .iter()
        .map(|metric| metric.column())
        .collect::<Vec<_>>();
    let col_list = columns.join(", ");
    let values = metrics.iter().map(|_| "1").collect::<Vec<_>>().join(", ");
    let updates = columns
        .iter()
        .map(|col| format!("{col} = usage_tracking.{col} + 1"))
        .collect::<Vec<_>>()
        .join(",\n                      ");

    let sql = format!(
        r#"
        INSERT INTO usage_tracking (monitored_account_id, billing_year, billing_month, {col_list})
        VALUES ($1, $2, $3, {values})
        ON CONFLICT (monitored_account_id, billing_year, billing_month)
        DO UPDATE SET {updates},
                      updated_at = NOW()
        "#,
    );

    if let Err(e) = sqlx::query(&sql)
        .bind(dao_id)
        .bind(year)
        .bind(month)
        .execute(pool)
        .await
    {
        log::warn!(
            "Failed to record platform metrics {:?} for {}: {}",
            metrics,
            dao_id,
            e
        );
    }
}

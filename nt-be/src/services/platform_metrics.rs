use chrono::{Datelike, Utc};
use sqlx::PgPool;

// Whitelist prevents SQL injection via the format! calls below.
const ALLOWED: &[&str] = &[
    "swap_proposals",
    "payment_proposals",
    "address_book_payment_proposals",
    "votes_casted",
    "other_proposals_submitted",
    "batch_payments_used",
    "exports_used",
    "gas_covered_transactions",
];

/// Increment a named event counter in `usage_tracking` for the current billing month.
///
/// Upserts a row for `(dao_id, year, month)` and increments the named counter by 1.
/// Non-critical: logs a warning on failure but does NOT propagate the error —
/// counter updates must never fail the parent request.
pub async fn record_event(pool: &PgPool, dao_id: &str, column: &str) {
    record_events(pool, dao_id, &[column]).await;
}

/// Increment multiple event counters in a single `usage_tracking` upsert.
///
/// All columns are incremented by 1 in one round-trip.
/// Non-critical: logs a warning on failure but does NOT propagate the error.
pub async fn record_events(pool: &PgPool, dao_id: &str, columns: &[&str]) {
    if columns.is_empty() {
        return;
    }

    let now = Utc::now();
    let year = now.year();
    let month = now.month() as i32;

    for &col in columns {
        if !ALLOWED.contains(&col) {
            log::error!(
                "platform_metrics::record_events: unknown metric '{}' — ignoring all",
                col
            );
            return;
        }
    }

    let col_list = columns.join(", ");
    let values = columns.iter().map(|_| "1").collect::<Vec<_>>().join(", ");
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
            columns,
            dao_id,
            e
        );
    }
}

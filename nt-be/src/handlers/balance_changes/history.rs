//! Balance History APIs
//!
//! Provides endpoints for querying historical balance data:
//! - Chart API: Returns balance snapshots at specified intervals
//! - CSV Export: Returns raw balance changes as downloadable CSV

use axum::{
    Json,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::{DateTime, Months, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::AppState;

/// Deserializer for comma-separated values
/// Accepts either a comma-separated string or None
fn comma_separated<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let s: Option<String> = Option::deserialize(deserializer)?;
    Ok(s.map(|s| {
        s.split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interval {
    Hourly,
    Daily,
    Weekly,
    Monthly,
}

impl Interval {
    /// Increments the given DateTime by one interval period
    ///
    /// For monthly intervals, this properly handles month boundaries by advancing
    /// to the same day of the next month (e.g., Feb 1 -> Mar 1, not Feb 1 -> Mar 3).
    /// If the day is invalid for the target month (e.g., Jan 31 -> Feb), it clamps
    /// to the last valid day of the target month (e.g., Feb 28 or Feb 29).
    pub fn increment(&self, datetime: DateTime<Utc>) -> DateTime<Utc> {
        match self {
            Interval::Hourly => datetime + chrono::Duration::hours(1),
            Interval::Daily => datetime + chrono::Duration::days(1),
            Interval::Weekly => datetime + chrono::Duration::weeks(1),
            Interval::Monthly => datetime.checked_add_months(Months::new(1)).unwrap(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartRequest {
    pub account_id: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub interval: Interval,
    #[serde(default, deserialize_with = "comma_separated")]
    pub token_ids: Option<Vec<String>>, // Comma-separated list, e.g., "near,wrap.near"
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSnapshot {
    pub timestamp: String,   // ISO 8601 format
    pub balance: BigDecimal, // Decimal-adjusted balance
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_usd: Option<f64>, // USD price at timestamp (null if unavailable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<f64>, // balance * price_usd (null if unavailable)
}

/// Chart API - returns balance snapshots at intervals
///
/// Response format: { "token_id": [{"timestamp": "...", "balance": "...", "price_usd": ..., "value_usd": ...}] }
pub async fn get_balance_chart(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ChartRequest>,
) -> Result<Json<HashMap<String, Vec<BalanceSnapshot>>>, (StatusCode, String)> {
    // Load prior balances (most recent balance_after for each token before start_time)
    let prior_balances = load_prior_balances(
        &state.db_pool,
        &params.account_id,
        params.start_time,
        params.token_ids.as_ref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Load all balance changes for the account in the timeframe
    let changes = load_balance_changes(
        &state.db_pool,
        &params.account_id,
        params.start_time,
        params.end_time,
        params.token_ids.as_ref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Calculate snapshots at each interval
    let mut snapshots = calculate_snapshots(
        changes,
        prior_balances,
        params.start_time,
        params.end_time,
        &params.interval,
    );

    // Enrich snapshots with price data
    enrich_snapshots_with_prices(&mut snapshots, &state.price_service).await;

    Ok(Json(snapshots))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvRequest {
    pub account_id: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    #[serde(default, deserialize_with = "comma_separated")]
    pub token_ids: Option<Vec<String>>, // Comma-separated list
}

/// CSV Export API - returns balance changes as CSV
///
/// Excludes SNAPSHOT and NOT_REGISTERED records
pub async fn export_balance_csv(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CsvRequest>,
) -> Result<Response, (StatusCode, String)> {
    // Query balance changes
    let csv_data = generate_csv(
        &state.db_pool,
        &state.price_service,
        &params.account_id,
        params.start_time,
        params.end_time,
        params.token_ids.as_ref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Return as downloadable CSV
    let filename = format!(
        "balance_changes_{}_{}_to_{}.csv",
        params.account_id, params.start_time, params.end_time
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                &format!("attachment; filename=\"{}\"", filename),
            ),
        ],
        csv_data,
    )
        .into_response())
}

// Helper functions

#[derive(Debug)]
struct BalanceChange {
    block_height: i64,
    block_time: DateTime<Utc>,
    token_id: String,
    token_symbol: Option<String>,
    counterparty: String,
    amount: BigDecimal,
    balance_before: BigDecimal,
    balance_after: BigDecimal,
    transaction_hashes: Vec<String>,
    receipt_id: Vec<String>,
}

/// Load the most recent balance for each token before start_time
///
/// Note: This function contains intentionally duplicated SQL queries for compile-time safety.
/// We use sqlx::query! macro which requires compile-time verification against the database schema.
/// The alternative (runtime sqlx::query()) would lose type safety. If you edit one query, ensure
/// you update the other. The compiler will catch mismatches in return types.
async fn load_prior_balances(
    pool: &PgPool,
    account_id: &str,
    start_time: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<HashMap<String, BigDecimal>, Box<dyn std::error::Error>> {
    let result: HashMap<_, _> = if let Some(tokens) = token_ids {
        sqlx::query!(
            r#"
            SELECT DISTINCT ON (token_id)
                token_id as "token_id!",
                balance_after as "balance!"
            FROM balance_changes
            WHERE account_id = $1
              AND block_time < $2
              AND token_id = ANY($3)
            ORDER BY token_id, block_height DESC
            "#,
            account_id,
            start_time,
            tokens
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| (row.token_id, row.balance))
        .collect()
    } else {
        sqlx::query!(
            r#"
            SELECT DISTINCT ON (token_id)
                token_id as "token_id!",
                balance_after as "balance!"
            FROM balance_changes
            WHERE account_id = $1
              AND block_time < $2
            ORDER BY token_id, block_height DESC
            "#,
            account_id,
            start_time
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| (row.token_id, row.balance))
        .collect()
    };

    Ok(result)
}

/// Load balance changes from database
///
/// Note: This function contains intentionally duplicated SQL queries for compile-time safety.
/// We use sqlx::query! macro which requires compile-time verification against the database schema.
/// The alternative (runtime sqlx::query()) would lose type safety. If you edit one query, ensure
/// you update the other. The compiler will catch mismatches in return types.
async fn load_balance_changes(
    pool: &PgPool,
    account_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<Vec<BalanceChange>, Box<dyn std::error::Error + Send + Sync>> {
    let rows = if let Some(tokens) = token_ids {
        sqlx::query!(
            r#"
            SELECT
                bc.block_height,
                bc.block_time,
                bc.token_id as "token_id!",
                c.token_symbol,
                bc.counterparty as "counterparty!",
                bc.amount as "amount!",
                bc.balance_before as "balance_before!",
                bc.balance_after as "balance_after!",
                bc.transaction_hashes as "transaction_hashes!",
                bc.receipt_id as "receipt_id!"
            FROM balance_changes bc
            LEFT JOIN counterparties c ON bc.token_id = c.account_id
            WHERE bc.account_id = $1
              AND bc.block_time >= $2
              AND bc.block_time < $3
              AND bc.token_id = ANY($4)
            ORDER BY bc.token_id, bc.block_height ASC
            "#,
            account_id,
            start_time,
            end_time,
            tokens
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| BalanceChange {
            block_height: row.block_height,
            block_time: row.block_time,
            token_id: row.token_id,
            token_symbol: row.token_symbol,
            counterparty: row.counterparty,
            amount: row.amount,
            balance_before: row.balance_before,
            balance_after: row.balance_after,
            transaction_hashes: row.transaction_hashes,
            receipt_id: row.receipt_id,
        })
        .collect()
    } else {
        sqlx::query!(
            r#"
            SELECT
                bc.block_height,
                bc.block_time,
                bc.token_id as "token_id!",
                c.token_symbol,
                bc.counterparty as "counterparty!",
                bc.amount as "amount!",
                bc.balance_before as "balance_before!",
                bc.balance_after as "balance_after!",
                bc.transaction_hashes as "transaction_hashes!",
                bc.receipt_id as "receipt_id!"
            FROM balance_changes bc
            LEFT JOIN counterparties c ON bc.token_id = c.account_id
            WHERE bc.account_id = $1
              AND bc.block_time >= $2
              AND bc.block_time < $3
            ORDER BY bc.token_id, bc.block_height ASC
            "#,
            account_id,
            start_time,
            end_time
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| BalanceChange {
            block_height: row.block_height,
            block_time: row.block_time,
            token_id: row.token_id,
            token_symbol: row.token_symbol,
            counterparty: row.counterparty,
            amount: row.amount,
            balance_before: row.balance_before,
            balance_after: row.balance_after,
            transaction_hashes: row.transaction_hashes,
            receipt_id: row.receipt_id,
        })
        .collect()
    };

    Ok(rows)
}

/// Calculate balance snapshots at regular intervals
fn calculate_snapshots(
    changes: Vec<BalanceChange>,
    prior_balances: HashMap<String, BigDecimal>,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    interval: &Interval,
) -> HashMap<String, Vec<BalanceSnapshot>> {
    // Group changes by token
    let mut by_token: HashMap<String, Vec<&BalanceChange>> = HashMap::new();
    for change in &changes {
        by_token
            .entry(change.token_id.clone())
            .or_default()
            .push(change);
    }

    // Add tokens that have prior balances but no changes in this timeframe
    for token_id in prior_balances.keys() {
        by_token.entry(token_id.clone()).or_default();
    }

    let mut result: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();

    for (token_id, token_changes) in by_token {
        let mut snapshots = Vec::new();
        let mut current_time = start_time;

        // Get the starting balance for this token
        let starting_balance = prior_balances
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| BigDecimal::from(0));

        while current_time < end_time {
            // Find the most recent balance_after before or at current_time
            let balance = token_changes
                .iter()
                .rfind(|c| c.block_time <= current_time)
                .map(|c| c.balance_after.clone())
                .unwrap_or_else(|| starting_balance.clone()); // Use starting balance if no changes yet

            snapshots.push(BalanceSnapshot {
                timestamp: current_time.to_rfc3339(),
                balance,
                price_usd: None,
                value_usd: None,
            });

            current_time = interval.increment(current_time);
        }

        result.insert(token_id, snapshots);
    }

    result
}

/// Enrich snapshots with USD price data
async fn enrich_snapshots_with_prices<P: crate::services::PriceProvider>(
    snapshots: &mut HashMap<String, Vec<BalanceSnapshot>>,
    price_service: &crate::services::PriceLookupService<P>,
) {
    for (token_id, token_snapshots) in snapshots.iter_mut() {
        // Parse timestamps once and collect unique dates
        let parsed_dates: Vec<Option<NaiveDate>> = token_snapshots
            .iter()
            .map(|s| {
                DateTime::parse_from_rfc3339(&s.timestamp)
                    .ok()
                    .map(|dt| dt.date_naive())
            })
            .collect();

        let unique_dates: Vec<NaiveDate> = parsed_dates
            .iter()
            .filter_map(|d| *d)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        if unique_dates.is_empty() {
            continue;
        }

        // Batch fetch prices for all dates
        let prices = match price_service
            .get_prices_batch(token_id, &unique_dates)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to fetch prices for {}: {}", token_id, e);
                continue;
            }
        };

        // Enrich each snapshot with price data (reusing parsed dates)
        for (snapshot, parsed_date) in token_snapshots.iter_mut().zip(parsed_dates.iter()) {
            if let Some(date) = parsed_date
                && let Some(&price) = prices.get(date)
            {
                snapshot.price_usd = Some(price);
                // Calculate value_usd = balance * price
                if let Some(balance_f64) = snapshot.balance.to_f64() {
                    snapshot.value_usd = Some(balance_f64 * price);
                }
            }
        }
    }
}

/// Generate CSV from balance changes
async fn generate_csv<P: crate::services::PriceProvider>(
    pool: &PgPool,
    price_service: &crate::services::PriceLookupService<P>,
    account_id: &str,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let changes = load_balance_changes(pool, account_id, start_date, end_date, token_ids).await?;

    // Pre-fetch prices for all token/date combinations to avoid per-row API calls
    let mut prices_cache: HashMap<(String, NaiveDate), f64> = HashMap::new();

    // Collect all unique (token_id, date) pairs
    let mut token_dates: HashMap<String, HashSet<NaiveDate>> = HashMap::new();
    for change in &changes {
        if change.counterparty == "SNAPSHOT"
            || change.counterparty == "NOT_REGISTERED"
            || change.counterparty == "STAKING_SNAPSHOT"
        {
            continue;
        }
        token_dates
            .entry(change.token_id.clone())
            .or_default()
            .insert(change.block_time.date_naive());
    }

    // Batch fetch prices for each token
    for (token_id, dates) in token_dates {
        let dates_vec: Vec<_> = dates.into_iter().collect();
        match price_service.get_prices_batch(&token_id, &dates_vec).await {
            Ok(token_prices) => {
                for (date, price) in token_prices {
                    prices_cache.insert((token_id.clone(), date), price);
                }
            }
            Err(e) => {
                log::debug!("Failed to batch fetch prices for {}: {}", token_id, e);
            }
        }
    }

    let mut csv = String::new();

    // Header (with price columns)
    csv.push_str("block_height,block_time,token_id,token_symbol,counterparty,amount,balance_before,balance_after,price_usd,value_usd,transaction_hashes,receipt_id\n");

    // Rows (exclude SNAPSHOT, NOT_REGISTERED, and STAKING_SNAPSHOT)
    for change in changes {
        if change.counterparty == "SNAPSHOT"
            || change.counterparty == "NOT_REGISTERED"
            || change.counterparty == "STAKING_SNAPSHOT"
        {
            continue;
        }

        let tx_hashes = change.transaction_hashes.join(",");
        let receipt_id = change.receipt_id.first().map(|s| s.as_str()).unwrap_or("");
        let token_symbol = change.token_symbol.as_deref().unwrap_or("");

        // Look up price from pre-fetched cache
        let date = change.block_time.date_naive();
        let (price_usd, value_usd) = prices_cache
            .get(&(change.token_id.clone(), date))
            .map(|&price| {
                let value = change.balance_after.to_f64().map(|b| b * price);
                (Some(price), value)
            })
            .unwrap_or((None, None));

        let price_str = price_usd.map(|p| format!("{}", p)).unwrap_or_default();
        let value_str = value_usd.map(|v| format!("{}", v)).unwrap_or_default();

        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{}\n",
            change.block_height,
            change.block_time.to_rfc3339(),
            change.token_id,
            token_symbol,
            change.counterparty,
            change.amount,
            change.balance_before,
            change.balance_after,
            price_str,
            value_str,
            tx_hashes,
            receipt_id
        ));
    }

    Ok(csv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_interval_increment_hourly() {
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        let result = Interval::Hourly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 1, 15, 11, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_daily() {
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        let result = Interval::Daily.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 1, 16, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_weekly() {
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        let result = Interval::Weekly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 1, 22, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_normal() {
        // Normal case: Jan 15 -> Feb 15
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 2, 15, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_year_boundary() {
        // Dec -> Jan (year boundary)
        let dt = Utc.with_ymd_and_hms(2024, 12, 15, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_jan_31_to_feb() {
        // Jan 31 -> Feb 29 (leap year - clamp to last valid day)
        let dt = Utc.with_ymd_and_hms(2024, 1, 31, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 2, 29, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_mar_31_to_apr() {
        // Mar 31 -> Apr 30 (clamp to last valid day)
        let dt = Utc.with_ymd_and_hms(2024, 3, 31, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 4, 30, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_may_31_to_jun() {
        // May 31 -> Jun 30 (clamp to last valid day)
        let dt = Utc.with_ymd_and_hms(2024, 5, 31, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 6, 30, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_jan_30_to_feb_non_leap() {
        // Jan 30 -> Feb 28 in non-leap year (clamp to last valid day)
        let dt = Utc.with_ymd_and_hms(2023, 1, 30, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2023, 2, 28, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_jan_29_to_feb_non_leap() {
        // Jan 29 -> Feb 28 in non-leap year (clamp to last valid day)
        let dt = Utc.with_ymd_and_hms(2023, 1, 29, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2023, 2, 28, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_jan_30_to_feb_leap_year() {
        // Jan 30 -> Feb 29 in leap year (clamp to last valid day)
        let dt = Utc.with_ymd_and_hms(2024, 1, 30, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 2, 29, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_jan_29_to_feb_leap_year() {
        // Jan 29 -> Feb 29 in leap year (should work)
        let dt = Utc.with_ymd_and_hms(2024, 1, 29, 10, 30, 0).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 2, 29, 10, 30, 0).unwrap()
        );
    }

    #[test]
    fn test_interval_increment_monthly_preserves_time() {
        // Verify time and timezone are preserved
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 23, 59, 59).unwrap();
        let result = Interval::Monthly.increment(dt);
        assert_eq!(
            result,
            Utc.with_ymd_and_hms(2024, 2, 15, 23, 59, 59).unwrap()
        );
    }
}

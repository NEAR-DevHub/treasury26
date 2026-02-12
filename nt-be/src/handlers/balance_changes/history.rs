//! Balance History APIs
//!
//! Provides endpoints for querying historical balance data:
//! - Chart API: Returns balance snapshots at specified intervals
//! - CSV Export: Returns raw balance changes as downloadable CSV
//! - Export History: Track and manage export credits

use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::{DateTime, Duration, Months, NaiveDate, Utc};
use rust_xlsxwriter::{Color, Format, Workbook};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use std::sync::Arc;

use crate::AppState;
use crate::config::get_plan_config;
use crate::constants::intents_tokens::find_token_by_symbol;
use crate::handlers::balance_changes::query_builder::{BalanceChangeFilters, build_count_query};
use crate::handlers::subscription::plans::get_account_plan_info;
use crate::handlers::token::TokenMetadata;
use crate::routes::{BalanceChangesQuery, get_balance_changes_internal};
use crate::utils::serde::comma_separated;

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BalanceChangeRow {
    pub id: i64,
    pub account_id: String,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub token_id: String,
    pub receipt_id: Vec<String>,
    pub transaction_hashes: Vec<String>,
    pub counterparty: Option<String>,
    pub signer_id: Option<String>,
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    pub balance_before: BigDecimal,
    pub balance_after: BigDecimal,
    pub created_at: DateTime<Utc>,
}

// ============================================================================
// Shared Helper Functions
// ============================================================================

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

    let query = BalanceChangesQuery {
        account_id: params.account_id.clone(),
        limit: None,
        offset: None,
        start_time: Some(params.start_time.to_rfc3339()),
        end_time: Some(params.end_time.to_rfc3339()),
        token_ids: params.token_ids.clone(),
        exclude_token_ids: None,
        transaction_types: None, // Include all transaction types for balance chart
        min_amount: None,
        max_amount: None,
        include_metadata: Some(false),
    };

    let enriched_changes = get_balance_changes_internal(&state, &query)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Convert EnrichedBalanceChange back to BalanceChange for calculate_snapshots
    let changes: Vec<BalanceChange> = enriched_changes
        .into_iter()
        .map(|change| BalanceChange {
            block_height: change.block_height,
            block_time: change.block_time,
            token_id: change.token_id,
            token_symbol: None, // Not needed for chart calculations
            counterparty: change.counterparty.unwrap_or_default(),
            amount: change.amount,
            balance_before: change.balance_before,
            balance_after: change.balance_after,
            transaction_hashes: change.transaction_hashes,
            receipt_id: change.receipt_id, // Already Vec<String>
        })
        .collect();

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
pub struct ExportRequest {
    pub account_id: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    #[serde(default, deserialize_with = "comma_separated")]
    pub token_ids: Option<Vec<String>>, // Comma-separated list
    #[serde(default, deserialize_with = "comma_separated")]
    pub transaction_types: Option<Vec<String>>, // Comma-separated: "sent", "received", "staking_rewards", "all"
    pub generated_by: Option<String>, // User who requested the export
    pub email: Option<String>,        // Email for notifications
    pub format: String,               // csv, json, or xlsx
}

/// Unified export endpoint - handles CSV, JSON, and XLSX exports
///
/// Accepts a `format` query parameter to determine the export type
/// Excludes SNAPSHOT and NOT_REGISTERED records
/// Validates date range based on user's plan limits
/// Creates export history record and decrements credits
pub async fn export_balance(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ExportRequest>,
) -> Result<Response, (StatusCode, String)> {
    // Validate format
    if !["csv", "json", "xlsx"].contains(&params.format.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Invalid format: {}. Must be csv, json, or xlsx",
                params.format
            ),
        ));
    }

    let (filename, data, content_type) = handle_export(&state, &params, &params.format).await?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CONTENT_DISPOSITION,
                &format!("attachment; filename=\"{}\"", filename),
            ),
        ],
        Body::from(data),
    )
        .into_response())
}
/// Build file URL for export with all filter parameters
fn build_export_file_url(params: &ExportRequest, format: &str) -> String {
    let mut url = format!(
        "/api/balance-history/export?format={}&account_id={}&start_time={}&end_time={}",
        format,
        params.account_id,
        params.start_time.to_rfc3339(),
        params.end_time.to_rfc3339()
    );

    if let Some(ref token_ids) = params.token_ids {
        url.push_str(&format!("&token_ids={}", token_ids.join(",")));
    }

    if let Some(ref transaction_types) = params.transaction_types {
        if !transaction_types.is_empty() && !transaction_types.contains(&"all".to_string()) {
            url.push_str(&format!(
                "&transaction_types={}",
                transaction_types.join(",")
            ));
        }
    }

    url
}

/// Internal helper that processes all export formats
async fn handle_export(
    state: &Arc<AppState>,
    params: &ExportRequest,
    format: &str,
) -> Result<(String, Vec<u8>, &'static str), (StatusCode, String)> {
    // Validate date range based on plan
    validate_export_date_range(&state.db_pool, &params.account_id, params.start_time).await?;

    // Generate export data
    let (data, content_type) = match format {
        "csv" => {
            let csv_data = generate_csv(
                state,
                &params.account_id,
                params.start_time,
                params.end_time,
                params.token_ids.as_ref(),
                params.transaction_types.as_ref(),
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            (csv_data.into_bytes(), "text/csv; charset=utf-8")
        }
        "json" => {
            let json_data = generate_json(
                state,
                &params.account_id,
                params.start_time,
                params.end_time,
                params.token_ids.as_ref(),
                params.transaction_types.as_ref(),
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            (json_data.into_bytes(), "application/json; charset=utf-8")
        }
        "xlsx" => {
            let xlsx_data = generate_xlsx(
                state,
                &params.account_id,
                params.start_time,
                params.end_time,
                params.token_ids.as_ref(),
                params.transaction_types.as_ref(),
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            (
                xlsx_data,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Unsupported format: {}", format),
            ));
        }
    };

    // Build file URL with all parameters
    let file_url = build_export_file_url(params, format);

    // Only after successful generation, create export record and decrement credits
    let _export_id = create_export_record(
        &state.db_pool,
        CreateExportRequest {
            account_id: params.account_id.clone(),
            generated_by: params
                .generated_by
                .clone()
                .unwrap_or_else(|| params.account_id.clone()),
            email: params.email.clone(),
            file_url,
        },
    )
    .await
    .map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;

    let filename = format!(
        "balance_changes_{}_{}_to_{}.{}",
        params.account_id, params.start_time, params.end_time, format
    );

    Ok((filename, data, content_type))
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

/// Helper function to build BalanceChangesQuery for export
fn build_export_query(
    account_id: &str,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
    transaction_types: Option<&Vec<String>>,
) -> BalanceChangesQuery {
    BalanceChangesQuery {
        account_id: account_id.to_string(),
        limit: None, // Export all
        offset: None,
        start_time: Some(start_date.to_rfc3339()),
        end_time: Some(end_date.to_rfc3339()),
        token_ids: token_ids.cloned(),
        exclude_token_ids: None,
        transaction_types: transaction_types.cloned(),
        min_amount: None,
        max_amount: None,
        include_metadata: Some(true), // ✅ Need metadata for symbol + prices
    }
}

/// Generate CSV from enriched balance changes
async fn generate_csv(
    state: &Arc<AppState>,
    account_id: &str,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
    transaction_types: Option<&Vec<String>>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let query = build_export_query(
        account_id,
        start_date,
        end_date,
        token_ids,
        transaction_types,
    );
    let enriched = get_balance_changes_internal(state, &query).await?;

    let mut csv = String::new();

    // Header (with price columns)
    csv.push_str("block_height,block_time,token_id,token_symbol,counterparty,amount,balance_before,balance_after,price_usd,value_usd,transaction_hashes,receipt_id\n");

    // Rows
    for change in enriched {
        let metadata = change
            .token_metadata
            .as_ref()
            .expect("Metadata should always be present");
        let price = metadata.price.unwrap_or(0.0);
        let value_usd = change.amount.abs().to_f64().map(|a| a * price);

        let tx_hashes = change.transaction_hashes.join(",");
        let receipt_ids = change.receipt_id.join(",");
        let price_str = if metadata.price.is_some() {
            format!("{}", price)
        } else {
            String::new()
        };
        let value_str = value_usd.map(|v| format!("{}", v)).unwrap_or_default();

        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{}\n",
            change.block_height,
            change.block_time.to_rfc3339(),
            change.token_id,
            metadata.symbol,
            change.counterparty.unwrap_or_default(),
            change.amount,
            change.balance_before,
            change.balance_after,
            price_str,
            value_str,
            tx_hashes,
            receipt_ids
        ));
    }

    Ok(csv)
}

/// Generate JSON from enriched balance changes
async fn generate_json(
    state: &Arc<AppState>,
    account_id: &str,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
    transaction_types: Option<&Vec<String>>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let query = build_export_query(
        account_id,
        start_date,
        end_date,
        token_ids,
        transaction_types,
    );
    let enriched = get_balance_changes_internal(state, &query).await?;

    // Convert to JSON-friendly format with string representations for decimals
    let json_records: Vec<serde_json::Value> = enriched
        .into_iter()
        .map(|change| {
            // Metadata should always be present since include_metadata=true
            let metadata = change
                .token_metadata
                .as_ref()
                .expect("Metadata should always be present");
            let price = metadata.price;
            let value_usd = change
                .amount
                .abs()
                .to_f64()
                .and_then(|a| price.map(|p| a * p));
            let receipt_ids = change.receipt_id.join(",");

            serde_json::json!({
                "block_height": change.block_height,
                "block_time": change.block_time.to_rfc3339(),
                "token_id": change.token_id,
                "token_symbol": metadata.symbol,
                "counterparty": change.counterparty.unwrap_or_default(),
                "amount": change.amount.to_string(),
                "balance_before": change.balance_before.to_string(),
                "balance_after": change.balance_after.to_string(),
                "price_usd": price,
                "value_usd": value_usd,
                "transaction_hashes": change.transaction_hashes,
                "receipt_id": receipt_ids,
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&json_records)?)
}

/// Generate XLSX from enriched balance changes
async fn generate_xlsx(
    state: &Arc<AppState>,
    account_id: &str,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
    transaction_types: Option<&Vec<String>>,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let query = build_export_query(
        account_id,
        start_date,
        end_date,
        token_ids,
        transaction_types,
    );
    let enriched = get_balance_changes_internal(state, &query).await?;

    // Create workbook
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();

    // Create header format
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    // Write headers
    let headers = vec![
        "Block Height",
        "Block Time",
        "Token ID",
        "Token Symbol",
        "Counterparty",
        "Amount",
        "Balance Before",
        "Balance After",
        "Price USD",
        "Value USD",
        "Transaction Hashes",
        "Receipt ID",
    ];

    for (col, header) in headers.iter().enumerate() {
        worksheet.write_with_format(0, col as u16, *header, &header_format)?;
    }

    // Write data rows
    let mut row = 1u32;
    for change in enriched {
        // Metadata should always be present since include_metadata=true
        let metadata = change
            .token_metadata
            .as_ref()
            .expect("Metadata should always be present");
        let price = metadata.price;
        let value_usd = change
            .amount
            .abs()
            .to_f64()
            .and_then(|a| price.map(|p| a * p));
        let receipt_ids = change.receipt_id.join(",");

        worksheet.write(row, 0, change.block_height)?;
        worksheet.write(row, 1, change.block_time.to_rfc3339())?;
        worksheet.write(row, 2, &change.token_id)?;
        worksheet.write(row, 3, &metadata.symbol)?;
        worksheet.write(row, 4, &change.counterparty.unwrap_or_default())?;
        worksheet.write(row, 5, change.amount.to_string())?;
        worksheet.write(row, 6, change.balance_before.to_string())?;
        worksheet.write(row, 7, change.balance_after.to_string())?;

        if let Some(p) = price {
            worksheet.write(row, 8, p)?;
        } else {
            worksheet.write(row, 8, "")?;
        }

        if let Some(value) = value_usd {
            worksheet.write(row, 9, value)?;
        } else {
            worksheet.write(row, 9, "")?;
        }

        worksheet.write(row, 10, change.transaction_hashes.join(","))?;
        worksheet.write(row, 11, &receipt_ids)?;

        row += 1;
    }

    // Auto-fit columns
    worksheet.autofit();

    let buffer = workbook.save_to_buffer()?;

    Ok(buffer)
}

/// Validate that the export date range is within the user's plan limits
///
/// Returns an error if the start_time is before the earliest allowed date
/// based on the user's plan history_lookup_months limit
async fn validate_export_date_range(
    pool: &sqlx::PgPool,
    account_id: &str,
    start_time: DateTime<Utc>,
) -> Result<(), (StatusCode, String)> {
    // Get account plan info
    let account_plan = get_account_plan_info(pool, account_id).await.map_err(|e| {
        log::error!("Failed to fetch account plan info: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to check subscription status: {}", e),
        )
    })?;

    // If account not found, default to Free plan
    let plan_config = if let Some(plan) = account_plan {
        get_plan_config(plan.plan_type)
    } else {
        // Default to Free plan if account not monitored
        get_plan_config(crate::config::PlanType::Free)
    };

    // Calculate the earliest allowed date based on plan
    let history_months = plan_config.limits.history_lookup_months;
    let earliest_allowed = Utc::now() - Duration::days(history_months as i64 * 30);

    // Check if start_time is before the earliest allowed date
    if start_time < earliest_allowed {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Export start date is outside your plan's history limit. Your plan allows access to the last {} months of data. Earliest allowed date: {}",
                history_months,
                earliest_allowed.format("%Y-%m-%d")
            ),
        ));
    }

    Ok(())
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

// ============================================================================
// Export History & Credits Management
// ============================================================================

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExportHistoryItem {
    pub id: i64,
    pub account_id: String,
    pub generated_by: String,
    pub email: Option<String>,
    pub status: String,
    pub file_url: String,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHistoryQuery {
    pub account_id: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHistoryResponse {
    pub data: Vec<ExportHistoryItem>,
    pub total: i64,
}

/// Get export history for an account
pub async fn get_export_history(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ExportHistoryQuery>,
) -> Result<Json<ExportHistoryResponse>, (StatusCode, String)> {
    let limit = params.limit.unwrap_or(10).min(100);
    let offset = params.offset.unwrap_or(0);

    // Get total count
    let total = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM export_history
        WHERE account_id = $1
        "#,
    )
    .bind(&params.account_id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Get export history records
    let data = sqlx::query_as::<_, ExportHistoryItem>(
        r#"
        SELECT 
            id,
            account_id,
            generated_by,
            email,
            status,
            file_url,
            error_message,
            created_at
        FROM export_history
        WHERE account_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(&params.account_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ExportHistoryResponse { data, total }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateExportRequest {
    pub account_id: String,
    pub generated_by: String,
    pub email: Option<String>,
    pub file_url: String,
}

/// Create a new export history record and decrement credits
async fn create_export_record(
    pool: &PgPool,
    request: CreateExportRequest,
) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
    // Start a transaction
    let mut tx = pool.begin().await?;

    // Check if account has enough credits
    let credits: Option<i32> = sqlx::query_scalar(
        r#"
        SELECT export_credits
        FROM monitored_accounts
        WHERE account_id = $1
        FOR UPDATE
        "#,
    )
    .bind(&request.account_id)
    .fetch_optional(&mut *tx)
    .await?;

    let current_credits = credits.unwrap_or(0);
    if current_credits <= 0 {
        return Err("Insufficient export credits".into());
    }

    // Decrement credits
    sqlx::query(
        r#"
        UPDATE monitored_accounts
        SET export_credits = export_credits - 1
        WHERE account_id = $1
        "#,
    )
    .bind(&request.account_id)
    .execute(&mut *tx)
    .await?;

    // Insert export history record
    let export_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO export_history (
            account_id,
            generated_by,
            email,
            file_url,
            status
        ) VALUES ($1, $2, $3, $4, 'completed')
        RETURNING id
        "#,
    )
    .bind(&request.account_id)
    .bind(&request.generated_by)
    .bind(&request.email)
    .bind(&request.file_url)
    .fetch_one(&mut *tx)
    .await?;

    // Commit transaction
    tx.commit().await?;

    Ok(export_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCreditsQuery {
    pub account_id: String,
}

// ============================================================================
// Recent Activity Endpoint
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityQuery {
    pub account_id: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub min_usd_value: Option<f64>,
    pub transaction_type: Option<String>, // "outgoing" | "incoming" | "staking_rewards" (single selection for tabs)
    pub token_symbol: Option<String>, // Single token symbol like "NEAR", "USDC" - will be converted to token IDs (for "Is" operation)
    pub token_symbol_not: Option<String>, // Single token symbol to exclude (for "Is Not" operation)
    pub amount_min: Option<String>,   // Minimum amount filter
    pub amount_max: Option<String>,   // Maximum amount filter
    pub start_date: Option<String>,   // ISO 8601 format
    pub end_date: Option<String>,     // ISO 8601 format
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityResponse {
    pub data: Vec<RecentActivity>,
    pub total: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivity {
    pub id: i64,
    pub block_time: DateTime<Utc>,
    pub token_id: String,
    pub token_metadata: TokenMetadata,
    pub counterparty: Option<String>,
    pub signer_id: Option<String>,
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    pub transaction_hashes: Vec<String>,
    pub receipt_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<f64>,
}

pub async fn get_recent_activity(
    State(state): State<Arc<AppState>>,
    Query(params): Query<RecentActivityQuery>,
) -> Result<Json<RecentActivityResponse>, (StatusCode, Json<serde_json::Value>)> {
    let limit = params.limit.unwrap_or(10).min(100);
    let offset = params.offset.unwrap_or(0);

    // Convert token symbol to token IDs if provided
    let mut token_ids = None;
    let mut exclude_token_ids = None;

    if let Some(symbol) = &params.token_symbol {
        if let Some(token) = find_token_by_symbol(&symbol.to_lowercase()) {
            let mut converted_ids = Vec::new();
            for grouped_token in token.grouped_tokens {
                // Extract address after "nep141:" prefix
                if let Some(address) = grouped_token.defuse_asset_id.split(':').nth(1) {
                    converted_ids.push(address.to_string());
                } else {
                    converted_ids.push(grouped_token.defuse_asset_id);
                }
            }
            if !converted_ids.is_empty() {
                token_ids = Some(converted_ids);
            }
        }
    }

    if let Some(symbol_not) = &params.token_symbol_not {
        if let Some(token) = find_token_by_symbol(&symbol_not.to_lowercase()) {
            let mut converted_ids = Vec::new();
            for grouped_token in token.grouped_tokens {
                // Extract address after "nep141:" prefix
                if let Some(address) = grouped_token.defuse_asset_id.split(':').nth(1) {
                    converted_ids.push(address.to_string());
                } else {
                    converted_ids.push(grouped_token.defuse_asset_id);
                }
            }
            if !converted_ids.is_empty() {
                exclude_token_ids = Some(converted_ids);
            }
        }
    }

    // Get account plan info and calculate date cutoff
    let account_plan = get_account_plan_info(&state.db_pool, &params.account_id)
        .await
        .map_err(|e| {
            log::error!("Failed to fetch account plan info: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to check subscription status: {}", e) })),
            )
        })?;

    // If account not found, default to Free plan
    let plan_config = if let Some(plan) = account_plan {
        get_plan_config(plan.plan_type)
    } else {
        // Default to Free plan if account not monitored
        get_plan_config(crate::config::PlanType::Free)
    };

    let history_months = plan_config.limits.history_lookup_months;
    let date_cutoff = Some(Utc::now() - Duration::days(history_months as i64 * 30));

    // Parse user-provided date range filters
    let start_date = params.start_date.as_ref().map(|s| s.as_str());

    let end_date = params.end_date.as_ref().map(|s| s.as_str());

    // Build query filters for total count (need to count before USD filtering)
    let count_date_cutoff_str: Option<String> = date_cutoff.map(|dt| dt.to_rfc3339());

    let filters = BalanceChangeFilters {
        account_id: params.account_id.clone(),
        date_cutoff,
        start_date: start_date
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc)),
        end_date: end_date
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc)),
        token_ids: token_ids.clone(),
        exclude_token_ids: exclude_token_ids.clone(),
        transaction_types: params.transaction_type.as_ref().map(|t| vec![t.clone()]),
        min_amount: params.amount_min.as_ref().and_then(|s| s.parse().ok()),
        max_amount: params.amount_max.as_ref().and_then(|s| s.parse().ok()),
    };

    // Count query
    let count_query_str = build_count_query(&filters);
    let mut count_query =
        sqlx::query_scalar::<sqlx::Postgres, i64>(&count_query_str).bind(&params.account_id);

    // Bind date parameters in order
    if let Some(ref cutoff) = filters.date_cutoff {
        count_query = count_query.bind(cutoff);
    }
    if let Some(ref start) = filters.start_date {
        count_query = count_query.bind(start);
    }
    if let Some(ref end) = filters.end_date {
        count_query = count_query.bind(end);
    }
    if let Some(ref tokens) = filters.token_ids {
        count_query = count_query.bind(tokens);
    }

    let total: i64 = count_query.fetch_one(&state.db_pool).await.unwrap_or(0);

    // If min_usd_value filter is specified, we need to fetch more records and filter them
    // because we can't filter by USD value in the database (prices come from API)
    let fetch_limit = if params.min_usd_value.is_some() {
        // Fetch more records to account for filtering
        // This is a heuristic - fetch 5x the requested limit
        limit.saturating_mul(5).min(500)
    } else {
        limit
    };

    // Now use the internal function to get enriched data
    let start_time_str: Option<String> =
        count_date_cutoff_str.or_else(|| start_date.map(|s| s.to_string()));
    let balance_query = BalanceChangesQuery {
        account_id: params.account_id.clone(),
        limit: Some(fetch_limit),
        offset: Some(offset),
        start_time: start_time_str,
        end_time: end_date.map(|s| s.to_string()),
        token_ids: token_ids.clone(),
        exclude_token_ids: exclude_token_ids.clone(),
        transaction_types: params.transaction_type.as_ref().map(|t| vec![t.clone()]),
        min_amount: params.amount_min.as_ref().and_then(|s| s.parse().ok()),
        max_amount: params.amount_max.as_ref().and_then(|s| s.parse().ok()),
        include_metadata: Some(true), // ✅ Fetch metadata (includes prices)
    };

    let enriched_changes = get_balance_changes_internal(&state, &balance_query)
        .await
        .map_err(|e| {
            log::error!("Failed to fetch recent activity: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch recent activity",
                    "details": e.to_string()
                })),
            )
        })?;

    // Convert enriched changes to RecentActivity format
    let activities: Vec<RecentActivity> = enriched_changes
        .into_iter()
        .filter_map(|change| {
            // Metadata should always be present since include_metadata=true
            let token_metadata = change
                .token_metadata
                .as_ref()
                .expect("Metadata should always be present");

            // Calculate USD value if price is available
            let value_usd = token_metadata.price.and_then(|price| {
                change
                    .amount
                    .abs()
                    .to_f64()
                    .map(|amount_f64| amount_f64 * price)
            });

            // Filter by minimum USD value if specified
            if let Some(min_usd) = params.min_usd_value {
                if let Some(usd_value) = value_usd {
                    if usd_value < min_usd {
                        return None;
                    }
                } else {
                    return None;
                }
            }

            Some(RecentActivity {
                id: change.id,
                block_time: change.block_time,
                token_id: change.token_id,
                token_metadata: token_metadata.clone(),
                counterparty: change.counterparty,
                signer_id: change.signer_id,
                receiver_id: change.receiver_id,
                amount: change.amount,
                transaction_hashes: change.transaction_hashes,
                receipt_ids: change.receipt_id,
                value_usd,
            })
        })
        .take(limit as usize) // Only return the requested number of results
        .collect();

    Ok(Json(RecentActivityResponse {
        data: activities,
        total,
    }))
}

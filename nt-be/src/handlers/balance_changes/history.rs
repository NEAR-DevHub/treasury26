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
use chrono::{DateTime, Months, NaiveDate, Utc};
use near_account_id::AccountIdRef;
use near_api::AccountId;
use rust_xlsxwriter::{Color, Format, Workbook};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use std::sync::Arc;
use urlencoding::encode;

use crate::config::get_plan_config;
use crate::handlers::balance_changes::query_builder::{
    BalanceChangeFilters, FROM_ACCOUNT_EXPR, RELAYER_ACCOUNT, TO_ACCOUNT_EXPR, build_count_query,
    build_where_conditions,
};
use crate::handlers::balance_changes::{confidential_list, public_list};
use crate::handlers::subscription::plans::get_account_plan_info;
use crate::handlers::token::{TokenMetadata, fetch_tokens_with_fallback};
use crate::routes::{BalanceChangesQuery, EnrichedBalanceChange, get_balance_changes_internal};
use crate::utils::serde::comma_separated;
use crate::{AppState, auth::OptionalAuthUser};

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
    pub account_id: AccountId,
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

/// Chart response with metadata
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartResponse {
    #[serde(flatten)]
    pub data: HashMap<String, Vec<BalanceSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<DateTime<Utc>>,
}

/// Chart API - returns balance snapshots at intervals
///
/// Response format: { "token_id": [...], "lastSyncedAt": "..." }
pub async fn get_balance_chart(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<ChartRequest>,
) -> Result<Json<ChartResponse>, (StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await?;
    let is_confidential =
        confidential_list::is_confidential_dao(&state.db_pool, params.account_id.as_str())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let last_synced_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT last_synced_at FROM monitored_accounts WHERE account_id = $1",
    )
    .bind(params.account_id.as_str())
    .fetch_optional(&state.db_pool)
    .await
    .ok()
    .flatten() // unwrap Option<Option<DateTime>> from fetch_optional
    .flatten(); // unwrap Option<DateTime> from nullable column

    // Load prior balances (most recent balance_after for each token before start_time).
    // Public chart reads are temporarily kept on legacy `balance_changes`; activity/export
    // still route through the public gold adapter.
    let prior_balances = load_prior_balances(
        &state.db_pool,
        params.account_id.as_str(),
        params.start_time,
        params.token_ids.as_ref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Compute interval timestamps up front so we can pass them to SQL for the
    // sponsor totals query — one cumulative sum per chart point, no per-snapshot scanning.
    let interval_timestamps: Vec<DateTime<Utc>> = {
        let mut ts = params.start_time;
        let mut out = Vec::new();
        while ts < params.end_time {
            out.push(ts);
            ts = params.interval.increment(ts);
        }
        out
    };

    // For each interval timestamp, fetch the cumulative sponsored NEAR amount up to
    // that point. We hide sponsor.trezu.near deposits and CreateAccount amounts from
    // users, so the chart subtracts them to show the balance without our top-ups.
    let sponsor_totals = load_sponsor_totals_per_interval(
        &state.db_pool,
        params.account_id.as_str(),
        &interval_timestamps,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let changes: Vec<BalanceChange> = if is_confidential {
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
            tx_hash: None,
            from_accounts: None,
            from_accounts_not: None,
            to_accounts: None,
            to_accounts_not: None,
            include_metadata: Some(false), // Chart doesn't need metadata
            include_prices: Some(true),    // Chart needs prices for USD values
            include_chain_metadata: Some(false), // Chart doesn't need chain metadata
            exclude_near_dust: false,
            exclude_swaps_from_direction: false, // Balance chart: include swaps
        };

        let enriched_changes = get_balance_changes_internal(&state, &query)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        // Convert EnrichedBalanceChange back to BalanceChange for calculate_snapshots.
        // IMPORTANT: restore the original staking token_id (staking:<pool>) instead of
        // the display-transformed "near". The staking remapping in get_balance_changes_internal
        // is for UI display only; mixing staking rows under "near" corrupts the snapshot
        // logic because staking balance_after values (~0.001) are picked up instead of the
        // real NEAR balance when staking block_heights are higher than real NEAR changes.
        enriched_changes
            .into_iter()
            .map(|change| {
                let token_id = if change.action_kind.as_deref() == Some("StakingReward") {
                    // counterparty was set to the pool address by the remapping; reconstruct
                    // the original staking:<pool> token_id so calculate_snapshots keeps these
                    // in a separate series from real NEAR.
                    if let Some(ref pool) = change.counterparty {
                        format!("staking:{}", pool)
                    } else {
                        change.token_id
                    }
                } else {
                    change.token_id
                };
                BalanceChange {
                    block_height: change.block_height,
                    block_time: change.block_time,
                    token_id,
                    token_symbol: None, // Not needed for chart calculations
                    counterparty: change.counterparty.unwrap_or_default(),
                    amount: change.amount,
                    balance_before: change.balance_before,
                    balance_after: change.balance_after,
                    transaction_hashes: change.transaction_hashes,
                    receipt_id: change.receipt_id,
                }
            })
            .collect()
    } else {
        load_legacy_chart_balance_changes(
            &state.db_pool,
            &params.account_id,
            params.start_time,
            params.end_time,
            params.token_ids.as_ref(),
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };

    // Calculate snapshots at each interval
    let mut snapshots = calculate_snapshots(
        changes,
        prior_balances,
        sponsor_totals,
        interval_timestamps,
        params.end_time,
    );

    // Enrich snapshots with price data
    enrich_snapshots_with_prices(&mut snapshots, &state.price_service).await;

    Ok(Json(ChartResponse {
        data: snapshots,
        last_synced_at,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub account_id: AccountId,
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
    user: OptionalAuthUser,
    Query(params): Query<ExportRequest>,
) -> Result<Response, (StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await?;

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
        "/api/balance-history/export?format={}&accountId={}&startTime={}&endTime={}",
        format,
        encode(params.account_id.as_str()),
        encode(&params.start_time.to_rfc3339()),
        encode(&params.end_time.to_rfc3339())
    );

    if let Some(ref token_ids) = params.token_ids {
        url.push_str(&format!("&tokenIds={}", encode(&token_ids.join(","))));
    }

    if let Some(ref transaction_types) = params.transaction_types
        && !transaction_types.is_empty()
        && !transaction_types.contains(&"all".to_string())
    {
        url.push_str(&format!(
            "&transactionTypes={}",
            encode(&transaction_types.join(","))
        ));
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
    validate_export_date_range(
        &state.db_pool,
        params.account_id.as_str(),
        params.start_time,
    )
    .await?;

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
            account_id: params.account_id.to_string(),
            generated_by: params
                .generated_by
                .clone()
                .unwrap_or_else(|| params.account_id.to_string()),
            email: params.email.clone(),
            file_url,
        },
    )
    .await
    .map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;

    crate::services::platform_metrics::record_event(
        &state.db_pool,
        params.account_id.as_str(),
        crate::services::platform_metrics::PlatformMetric::ExportsUsed,
    )
    .await;

    // Format dates as YYYY-MM-DD for cleaner filename
    let start_date = params.start_time.format("%Y-%m-%d").to_string();
    let end_date = params.end_time.format("%Y-%m-%d").to_string();

    let filename = format!(
        "{}_activity_{}_{}.{}",
        params.account_id, start_date, end_date, format
    );

    Ok((filename, data, content_type))
}

// Helper functions

#[derive(Debug)]
#[allow(dead_code)]
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

/// For each interval timestamp, return the cumulative sponsored NEAR amount up to that point.
///
/// We hide two categories from users:
/// 1. `counterparty = 'sponsor.trezu.near'` — storage deposit top-ups
/// 2. `action_kind = 'CreateAccount'` — account creation deposits
///
/// The timestamps are the chart interval points computed in the caller. One SQL query
/// returns one row per timestamp with the cumulative SUM up to and including that moment.
async fn load_sponsor_totals_per_interval(
    pool: &PgPool,
    account_id: &str,
    interval_timestamps: &[DateTime<Utc>],
) -> Result<HashMap<DateTime<Utc>, BigDecimal>, Box<dyn std::error::Error>> {
    if interval_timestamps.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query!(
        r#"
        SELECT
            t.ts as "ts!",
            COALESCE(SUM(bc.amount), 0) as "cumulative_amount!"
        FROM unnest($3::timestamptz[]) AS t(ts)
        LEFT JOIN balance_changes bc
            ON  bc.account_id = $2
            AND bc.token_id = 'near'
            AND bc.block_time <= t.ts
            AND (bc.counterparty = $1 OR bc.action_kind = 'CreateAccount')
        GROUP BY t.ts
        "#,
        RELAYER_ACCOUNT,
        account_id,
        interval_timestamps as &[DateTime<Utc>],
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| (r.ts, r.cumulative_amount))
        .collect())
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

#[derive(Debug, FromRow)]
struct LegacyChartBalanceChangeRow {
    block_height: i64,
    block_time: DateTime<Utc>,
    token_id: String,
    counterparty: String,
    amount: BigDecimal,
    balance_before: BigDecimal,
    balance_after: BigDecimal,
    transaction_hashes: Vec<String>,
    receipt_id: Vec<String>,
}

async fn load_legacy_chart_balance_changes(
    pool: &PgPool,
    account_id: &AccountId,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<Vec<BalanceChange>, sqlx::Error> {
    let filters = BalanceChangeFilters {
        account_id: account_id.clone(),
        date_cutoff: None,
        start_date: Some(start_time),
        end_date: Some(end_time),
        token_ids: token_ids.cloned(),
        exclude_token_ids: None,
        transaction_types: None,
        min_amount: None,
        max_amount: None,
        transaction_hash_query: None,
        from_accounts: None,
        from_accounts_not: None,
        to_accounts: None,
        to_accounts_not: None,
        exclude_near_dust: false,
        exclude_swaps_from_direction: false,
    };
    let (conditions, _) = build_where_conditions(&filters);
    let query = format!(
        r#"
        SELECT
            block_height,
            block_time,
            token_id,
            COALESCE(counterparty, '') AS counterparty,
            amount,
            balance_before,
            balance_after,
            transaction_hashes,
            receipt_id
        FROM balance_changes
        WHERE {}
        ORDER BY block_height DESC
        "#,
        conditions.join(" AND ")
    );

    let mut query = sqlx::query_as::<_, LegacyChartBalanceChangeRow>(&query)
        .bind(account_id.as_str())
        .bind(start_time)
        .bind(end_time);
    if let Some(tokens) = token_ids {
        query = query.bind(tokens);
    }

    let rows = query.fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| BalanceChange {
            block_height: row.block_height,
            block_time: row.block_time,
            token_id: row.token_id,
            token_symbol: None,
            counterparty: row.counterparty,
            amount: row.amount,
            balance_before: row.balance_before,
            balance_after: row.balance_after,
            transaction_hashes: row.transaction_hashes,
            receipt_id: row.receipt_id,
        })
        .collect())
}

/// Load balance changes from database
///
/// Note: This function contains intentionally duplicated SQL queries for compile-time safety.
/// We use sqlx::query! macro which requires compile-time verification against the database schema.
/// The alternative (runtime sqlx::query()) would lose type safety. If you edit one query, ensure
/// Calculate balance snapshots at regular intervals.
///
/// For NEAR, each snapshot subtracts the precomputed cumulative sponsored amount
/// for that interval point so the chart reflects the balance without our top-ups.
fn calculate_snapshots(
    changes: Vec<BalanceChange>,
    prior_balances: HashMap<String, BigDecimal>,
    sponsor_totals: HashMap<DateTime<Utc>, BigDecimal>,
    interval_timestamps: Vec<DateTime<Utc>>,
    end_time: DateTime<Utc>,
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

    let zero = BigDecimal::from(0);
    let mut result: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();

    for (token_id, token_changes) in by_token {
        let mut snapshots = Vec::new();

        // Get the starting balance for this token
        let starting_balance = prior_balances
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| zero.clone());

        for &current_time in &interval_timestamps {
            if current_time >= end_time {
                break;
            }

            // Most recent balance_after at or before this interval point.
            // Changes are sorted newest-first (block_height DESC), so `find` returns
            // the most recent change at or before current_time.
            let balance = token_changes
                .iter()
                .find(|c| c.block_time <= current_time)
                .map(|c| c.balance_after.clone())
                .unwrap_or_else(|| starting_balance.clone());

            // For NEAR, subtract the precomputed cumulative sponsored amount so the
            // chart shows the balance the user would have without our top-ups.
            let balance = if token_id == "near" {
                let sponsored = sponsor_totals.get(&current_time).unwrap_or(&zero).clone();
                let adjusted = balance - sponsored;
                adjusted.max(zero.clone())
            } else {
                balance
            };

            snapshots.push(BalanceSnapshot {
                timestamp: current_time.to_rfc3339(),
                balance,
                price_usd: None,
                value_usd: None,
            });
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
                tracing::warn!("Failed to fetch prices for {}: {}", token_id, e);
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
    account_id: &AccountIdRef,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
    transaction_types: Option<&Vec<String>>,
) -> BalanceChangesQuery {
    BalanceChangesQuery {
        account_id: account_id.to_owned(),
        limit: None, // Export all
        offset: None,
        start_time: Some(start_date.to_rfc3339()),
        end_time: Some(end_date.to_rfc3339()),
        token_ids: token_ids.cloned(),
        exclude_token_ids: None,
        transaction_types: transaction_types.cloned(),
        min_amount: None,
        max_amount: None,
        tx_hash: None,
        from_accounts: None,
        from_accounts_not: None,
        to_accounts: None,
        to_accounts_not: None,
        include_metadata: Some(true), // Export needs metadata (symbol, contract)
        include_prices: Some(true),   // Export needs prices (USD values)
        include_chain_metadata: Some(false), // Export doesn't need chain metadata
        exclude_near_dust: false,
        exclude_swaps_from_direction: false, // Export: include swaps in incoming/outgoing
    }
}

/// Accounting-friendly export record structure
#[derive(Debug, Clone)]
struct ExportRecord {
    date: String,
    time: String,
    direction: String,
    from_address: String,
    to_address: String,
    asset_symbol: String,
    asset_contract_address: String,
    amount: f64,
    balance_after: String,
    price_usd: Option<f64>,
    value_usd: Option<f64>,
    transaction_hash: String,
    receipt_id: String,
}

/// USD value of a balance change, preferring the value computed at quote time.
///
/// Confidential rows persist `amount_usd` (the exact quote-time USD) in
/// `usd_value`, so we use it directly — it's accurate and needs no price-table
/// lookup. Public rows have no stored value, so fall back to a spot
/// `price × amount` estimate.
fn resolve_value_usd(change: &EnrichedBalanceChange, price: Option<f64>) -> Option<f64> {
    if let Some(stored) = change.usd_value.as_ref().and_then(|v| v.to_f64()) {
        return Some(stored.abs());
    }
    change
        .amount
        .abs()
        .to_f64()
        .zip(price)
        .map(|(amount, price)| amount * price)
}

/// Convert enriched balance changes to accounting-friendly export records
fn transform_to_export_records(
    enriched_changes: Vec<EnrichedBalanceChange>,
    account_id: &str,
) -> Vec<ExportRecord> {
    enriched_changes
        .into_iter()
        .map(|change| {
            let metadata = change
                .token_metadata
                .as_ref()
                .expect("Metadata should always be present");

            let price = metadata.price;
            let amount_val = change.amount.abs().to_f64().unwrap_or(0.0);
            let value_usd = resolve_value_usd(&change, price);

            // Determine direction and addresses
            let is_incoming = change.amount.to_f64().map(|a| a > 0.0).unwrap_or(false);
            let direction = if is_incoming { "in" } else { "out" };
            let from_address = if is_incoming {
                change.counterparty.as_deref().unwrap_or("")
            } else {
                account_id
            };
            let to_address = if is_incoming {
                account_id
            } else {
                change.counterparty.as_deref().unwrap_or("")
            };

            // Split date and time
            let datetime = change.block_time;
            let date = datetime.format("%Y-%m-%d").to_string();
            let time = datetime.format("%H:%M:%S UTC").to_string();

            // Use first transaction hash and receipt ID
            let transaction_hash = change
                .transaction_hashes
                .first()
                .map(|h| h.to_string())
                .unwrap_or_default();

            let receipt_id = change
                .receipt_id
                .first()
                .map(|r| r.to_string())
                .unwrap_or_default();

            // Remove "intents.near:" prefix from token_id for cleaner export
            let asset_contract_address = change
                .token_id
                .strip_prefix("intents.near:")
                .unwrap_or(&change.token_id)
                .to_string();

            ExportRecord {
                date,
                time,
                direction: direction.to_string(),
                from_address: from_address.to_string(),
                to_address: to_address.to_string(),
                asset_symbol: metadata.symbol.clone(),
                asset_contract_address,
                amount: amount_val,
                balance_after: change.balance_after.to_string(),
                price_usd: price,
                value_usd,
                transaction_hash,
                receipt_id,
            }
        })
        .collect()
}

/// Generate CSV from enriched balance changes
async fn generate_csv(
    state: &Arc<AppState>,
    account_id: &AccountIdRef,
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
    let records = transform_to_export_records(enriched, account_id.as_str());

    let mut csv = String::new();

    // Header (accounting-friendly format)
    csv.push_str("date,time,direction,from_address,to_address,asset_symbol,asset_contract_address,amount,balance_after,price_usd,value_usd,transaction_hash,receipt_id\n");

    // Rows
    for record in records {
        let price_str = record.price_usd.map(|p| p.to_string()).unwrap_or_default();
        let value_str = record.value_usd.map(|v| v.to_string()).unwrap_or_default();

        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            record.date,
            record.time,
            record.direction,
            record.from_address,
            record.to_address,
            record.asset_symbol,
            record.asset_contract_address,
            record.amount,
            record.balance_after,
            price_str,
            value_str,
            record.transaction_hash,
            record.receipt_id
        ));
    }

    Ok(csv)
}

/// Generate JSON from enriched balance changes
async fn generate_json(
    state: &Arc<AppState>,
    account_id: &AccountIdRef,
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
    let records = transform_to_export_records(enriched, account_id.as_str());

    // Convert to JSON-friendly format
    let json_records: Vec<serde_json::Value> = records
        .into_iter()
        .map(|record| {
            serde_json::json!({
                "date": record.date,
                "time": record.time,
                "direction": record.direction,
                "from_address": record.from_address,
                "to_address": record.to_address,
                "asset_symbol": record.asset_symbol,
                "asset_contract_address": record.asset_contract_address,
                "amount": record.amount,
                "balance_after": record.balance_after,
                "price_usd": record.price_usd,
                "value_usd": record.value_usd,
                "transaction_hash": record.transaction_hash,
                "receipt_id": record.receipt_id,
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&json_records)?)
}

/// Generate XLSX from enriched balance changes
async fn generate_xlsx(
    state: &Arc<AppState>,
    account_id: &AccountIdRef,
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
    let records = transform_to_export_records(enriched, account_id.as_str());

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
        "Date",
        "Time",
        "Direction",
        "From Address",
        "To Address",
        "Asset Symbol",
        "Asset Contract Address",
        "Amount",
        "Balance After",
        "Price USD",
        "Value USD",
        "Transaction Hash",
        "Receipt ID",
    ];

    for (col, header) in headers.iter().enumerate() {
        worksheet.write_with_format(0, col as u16, *header, &header_format)?;
    }

    // Write data rows
    for (row, record) in (1u32..).zip(records) {
        worksheet.write(row, 0, record.date)?;
        worksheet.write(row, 1, record.time)?;
        worksheet.write(row, 2, record.direction)?;
        worksheet.write(row, 3, record.from_address)?;
        worksheet.write(row, 4, record.to_address)?;
        worksheet.write(row, 5, record.asset_symbol)?;
        worksheet.write(row, 6, record.asset_contract_address)?;
        worksheet.write(row, 7, record.amount)?;
        worksheet.write(row, 8, record.balance_after)?;

        if let Some(p) = record.price_usd {
            worksheet.write(row, 9, p)?;
        } else {
            worksheet.write(row, 9, "")?;
        }

        if let Some(value) = record.value_usd {
            worksheet.write(row, 10, value)?;
        } else {
            worksheet.write(row, 10, "")?;
        }

        worksheet.write(row, 11, record.transaction_hash)?;
        worksheet.write(row, 12, record.receipt_id)?;
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
        tracing::error!("Failed to fetch account plan info: {}", e);
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
    // Subtract 1 day to include the boundary (more lenient)
    let history_months = plan_config.limits.history_lookup_months;
    let earliest_allowed = Utc::now()
        .checked_sub_months(Months::new(history_months as u32))
        .unwrap_or(Utc::now())
        - chrono::Duration::days(1);

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
    pub account_id: AccountId,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub from_date: Option<String>, // ISO 8601 date string
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
    user: OptionalAuthUser,
    Query(params): Query<ExportHistoryQuery>,
) -> Result<Json<ExportHistoryResponse>, (StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await?;

    let limit = params.limit.unwrap_or(10).min(100);
    let offset = params.offset.unwrap_or(0);

    // Build WHERE clause - show exports from current month OR still active (within 48 hours)
    // This filters to:
    // 1. Exports created on or after 1st of current month, OR
    // 2. Exports created within last 48 hours (even if from previous month)
    let where_clause = r#"
        WHERE account_id = $1
        AND (
            created_at >= DATE_TRUNC('month', NOW())
            OR created_at >= NOW() - INTERVAL '48 hours'
        )
    "#;

    // Get total count
    let total_query = format!("SELECT COUNT(*) FROM export_history {}", where_clause);
    let total = sqlx::query_scalar::<_, i64>(&total_query)
        .bind(params.account_id.as_str())
        .fetch_one(&state.db_pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Get export history records
    let data_query = format!(
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
        {}
        ORDER BY created_at DESC
        LIMIT $2
        OFFSET $3
        "#,
        where_clause
    );

    let data = sqlx::query_as::<_, ExportHistoryItem>(&data_query)
        .bind(params.account_id.as_str())
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

    // Check if an identical export already exists FIRST (before checking credits)
    let existing_export: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM export_history
        WHERE account_id = $1 AND file_url = $2
        LIMIT 1
        "#,
    )
    .bind(&request.account_id)
    .bind(&request.file_url)
    .fetch_optional(&mut *tx)
    .await?;

    let export_id = if let Some(existing_id) = existing_export {
        // Export already exists - don't check or charge credits, just return existing ID
        existing_id
    } else {
        // New export - check if account has enough credits
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
        let new_id: i64 = sqlx::query_scalar(
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

        new_id
    };

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
    pub account_id: AccountId,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub min_usd_value: Option<f64>,
    pub transaction_type: Option<String>, // "outgoing" | "incoming" | "staking_rewards" | "exchange" (single selection for tabs)
    pub token_symbol: Option<String>,
    pub token_symbol_not: Option<String>,
    pub tx_hash: Option<String>,
    #[serde(rename = "from", default, deserialize_with = "comma_separated")]
    pub from_account: Option<Vec<String>>,
    #[serde(rename = "fromNot", default, deserialize_with = "comma_separated")]
    pub from_account_not: Option<Vec<String>>,
    #[serde(rename = "to", default, deserialize_with = "comma_separated")]
    pub to_account: Option<Vec<String>>,
    #[serde(rename = "toNot", default, deserialize_with = "comma_separated")]
    pub to_account_not: Option<Vec<String>>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityResponse {
    pub data: Vec<RecentActivity>,
    pub total: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivitySendersQuery {
    pub account_id: AccountId,
    pub transaction_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivitySendersResponse {
    pub options: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityRecipientsQuery {
    pub account_id: AccountId,
    pub transaction_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityRecipientsResponse {
    pub options: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub sent_token_id: Option<String>,
    pub sent_amount: Option<BigDecimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_token_metadata: Option<TokenMetadata>,
    pub received_token_id: String,
    pub received_amount: Option<BigDecimal>,
    pub received_token_metadata: TokenMetadata,
    pub solver_transaction_hash: String,
    /// "deposit" for the outgoing leg, "fulfillment" for the incoming leg
    pub swap_role: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<SwapInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_name: Option<String>,
}

pub async fn get_recent_activity(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<RecentActivityQuery>,
) -> Result<Json<RecentActivityResponse>, (StatusCode, Json<serde_json::Value>)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "error": message }))))?;

    let limit = params.limit.unwrap_or(10).min(100);
    let offset = params.offset.unwrap_or(0);
    let is_confidential =
        confidential_list::is_confidential_dao(&state.db_pool, params.account_id.as_str())
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": e.to_string() })),
                )
            })?;

    // Get account plan info and calculate date cutoff
    let account_plan = get_account_plan_info(&state.db_pool, params.account_id.as_str())
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch account plan info: {}", e);
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

    // Calculate date cutoff for plan limits
    // Subtract 1 day to include the boundary (more lenient)
    let history_months = plan_config.limits.history_lookup_months;
    let date_cutoff = Some(
        Utc::now()
            .checked_sub_months(Months::new(history_months as u32))
            .unwrap_or(Utc::now())
            - chrono::Duration::days(1),
    );

    // Parse user-provided date range filters
    let start_date = params.start_date.as_deref();

    let end_date = params.end_date.as_deref();

    // Convert token symbol to token IDs using NearBlocks search
    let token_ids: Option<Vec<String>> = if let Some(ref symbol) = params.token_symbol {
        match crate::handlers::token::search_token_by_symbol(&state, symbol).await {
            Ok(addresses) => {
                if addresses.is_empty() {
                    None
                } else {
                    Some(addresses)
                }
            }
            Err(e) => {
                tracing::error!("Failed to search token by symbol '{}': {:?}", symbol, e);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        serde_json::json!({ "error": format!("Failed to search token: {:?}", e) }),
                    ),
                ));
            }
        }
    } else {
        None
    };

    let exclude_token_ids: Option<Vec<String>> = if let Some(ref symbol) = params.token_symbol_not {
        match crate::handlers::token::search_token_by_symbol(&state, symbol).await {
            Ok(addresses) => {
                if addresses.is_empty() {
                    None
                } else {
                    Some(addresses)
                }
            }
            Err(e) => {
                tracing::error!("Failed to search token by symbol '{}': {:?}", symbol, e);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        serde_json::json!({ "error": format!("Failed to search token: {:?}", e) }),
                    ),
                ));
            }
        }
    } else {
        None
    };

    // Build query filters for total count (need to count before USD filtering)
    let count_date_cutoff_str: Option<String> = date_cutoff.map(|dt| dt.to_rfc3339());

    // For recent activity, "incoming" should exclude staking rewards (shown in separate tab)
    let transaction_types_for_query = params
        .transaction_type
        .as_deref()
        .map(|t| vec![t.to_string()]);

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
        transaction_types: transaction_types_for_query.clone(),
        min_amount: None,
        max_amount: None,
        transaction_hash_query: params.tx_hash.clone(),
        from_accounts: params.from_account.clone(),
        from_accounts_not: params.from_account_not.clone(),
        to_accounts: params.to_account.clone(),
        to_accounts_not: params.to_account_not.clone(),
        exclude_near_dust: true,
        exclude_swaps_from_direction: true, // Recent activity: exclude swaps from incoming/outgoing (separate tab)
    };

    // Count query
    let count_query_str = build_count_query(&filters);
    let mut count_query = sqlx::query_scalar::<sqlx::Postgres, i64>(&count_query_str)
        .bind(params.account_id.as_str());

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
    } else if let Some(ref exclude_tokens) = filters.exclude_token_ids {
        count_query = count_query.bind(exclude_tokens);
    }
    if let Some(ref tx_hash_query) = filters.transaction_hash_query {
        count_query = count_query.bind(format!("%{}%", tx_hash_query));
    }
    if let Some(ref from_accounts) = filters.from_accounts {
        count_query = count_query.bind(from_accounts);
    }
    if let Some(ref from_accounts_not) = filters.from_accounts_not {
        count_query = count_query.bind(from_accounts_not);
    }
    if let Some(ref to_accounts) = filters.to_accounts {
        count_query = count_query.bind(to_accounts);
    }
    if let Some(ref to_accounts_not) = filters.to_accounts_not {
        count_query = count_query.bind(to_accounts_not);
    }

    let total: i64 = if is_confidential {
        count_query.fetch_one(&state.db_pool).await.unwrap_or(0)
    } else {
        let count_query = BalanceChangesQuery {
            account_id: params.account_id.clone(),
            limit: None,
            offset: None,
            start_time: count_date_cutoff_str
                .clone()
                .or_else(|| start_date.map(|s| s.to_string())),
            end_time: end_date.map(|s| s.to_string()),
            token_ids: token_ids.clone(),
            exclude_token_ids: exclude_token_ids.clone(),
            transaction_types: transaction_types_for_query.clone(),
            min_amount: None,
            max_amount: None,
            tx_hash: params.tx_hash.clone(),
            from_accounts: params.from_account.clone(),
            from_accounts_not: params.from_account_not.clone(),
            to_accounts: params.to_account.clone(),
            to_accounts_not: params.to_account_not.clone(),
            include_metadata: Some(false),
            include_prices: Some(false),
            include_chain_metadata: Some(false),
            exclude_near_dust: true,
            exclude_swaps_from_direction: true,
        };
        public_list::count_balance_change_legs(&state.db_pool, &count_query)
            .await
            .unwrap_or(0)
    };

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
        transaction_types: transaction_types_for_query,
        min_amount: None,
        max_amount: None,
        tx_hash: params.tx_hash.clone(),
        from_accounts: params.from_account.clone(),
        from_accounts_not: params.from_account_not.clone(),
        to_accounts: params.to_account.clone(),
        to_accounts_not: params.to_account_not.clone(),
        include_metadata: Some(true),
        include_prices: Some(true),
        include_chain_metadata: Some(false), // Recent activity doesn't need chain metadata here (will be added for swaps later)
        exclude_near_dust: true,
        exclude_swaps_from_direction: true, // Recent activity: exclude swaps from incoming/outgoing (separate Exchange tab)
    };

    let mut enriched_changes = get_balance_changes_internal(&state, &balance_query)
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch recent activity: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch recent activity",
                    "details": e.to_string()
                })),
            )
        })?;

    // Enrich all recent-activity rows with chain metadata
    let activity_token_ids: Vec<String> = enriched_changes
        .iter()
        .map(|c| c.token_id.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    if !activity_token_ids.is_empty() {
        let chain_metadata_map =
            fetch_tokens_with_fallback(&state, &activity_token_ids, true, false).await;
        for change in &mut enriched_changes {
            if let Some(ref mut metadata) = change.token_metadata
                && let Some(chain_meta) = chain_metadata_map.get(&change.token_id)
            {
                if chain_meta.network.is_some() {
                    metadata.network = chain_meta.network.clone();
                }
                if chain_meta.chain_name.is_some() {
                    metadata.chain_name = chain_meta.chain_name.clone();
                }
                if chain_meta.chain_icons.is_some() {
                    metadata.chain_icons = chain_meta.chain_icons.clone();
                }
            }
        }
    }

    // Look up detected swaps for both fulfillment and deposit IDs on this page
    let change_ids: Vec<i64> = enriched_changes.iter().map(|c| c.id).collect();

    #[derive(Debug)]
    struct SwapRecord {
        fulfillment_balance_change_id: Option<i64>,
        deposit_balance_change_id: Option<i64>,
        sent_token_id: Option<String>,
        sent_amount: Option<BigDecimal>,
        received_token_id: String,
        received_amount: Option<BigDecimal>,
        solver_transaction_hash: String,
    }

    let swap_records = if !change_ids.is_empty() {
        sqlx::query_as!(
            SwapRecord,
            r#"
            SELECT
                fulfillment_balance_change_id,
                deposit_balance_change_id,
                sent_token_id,
                sent_amount,
                received_token_id,
                received_amount,
                solver_transaction_hash
            FROM detected_swaps
            WHERE account_id = $1
              AND (fulfillment_balance_change_id = ANY($2)
                   OR deposit_balance_change_id = ANY($2))
            "#,
            params.account_id.as_str(),
            &change_ids,
        )
        .fetch_all(&state.db_pool)
        .await
        .unwrap_or_default()
    } else {
        vec![]
    };

    // Build swap lookup map: balance_change_id -> (role, index into swap_records)
    let mut swap_map: std::collections::HashMap<i64, (&str, usize)> =
        std::collections::HashMap::new();
    for (i, record) in swap_records.iter().enumerate() {
        if let Some(fid) = record.fulfillment_balance_change_id {
            swap_map.insert(fid, ("fulfillment", i));
        }
        if let Some(deposit_id) = record.deposit_balance_change_id {
            swap_map.insert(deposit_id, ("deposit", i));
        }
    }

    // Helper function to resolve metadata for a token_id
    fn resolve_swap_metadata(
        token_id: &str,
        metadata_map: &std::collections::HashMap<String, TokenMetadata>,
    ) -> TokenMetadata {
        // Check if metadata exists in the map
        if let Some(meta) = metadata_map.get(token_id) {
            return meta.clone();
        }

        // Fallback: create a basic metadata object
        let symbol = token_id
            .split('.')
            .next()
            .unwrap_or("UNKNOWN")
            .to_uppercase();
        TokenMetadata {
            token_id: token_id.to_string(),
            name: symbol.clone(),
            symbol,
            decimals: 18,
            icon: None,
            price: None,
            price_updated_at: None,
            network: None,
            chain_name: None,
            chain_icons: None,
        }
    }

    // Collect unique swap token IDs that are not already in enriched_changes
    let mut swap_token_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for record in &swap_records {
        if let Some(ref sent_token_id) = record.sent_token_id {
            swap_token_ids.insert(sent_token_id.clone());
        }
        swap_token_ids.insert(record.received_token_id.clone());
    }

    // Build metadata map from enriched changes (which already have metadata)
    let mut metadata_map: std::collections::HashMap<String, TokenMetadata> =
        std::collections::HashMap::new();
    for change in &enriched_changes {
        if let Some(ref meta) = change.token_metadata {
            metadata_map.insert(change.token_id.clone(), meta.clone());
        }
    }

    // Fetch chain metadata only for swap tokens that are missing it.
    let swap_token_ids_vec: Vec<String> = swap_token_ids
        .into_iter()
        .filter(|token_id| {
            metadata_map.get(token_id).is_none_or(|meta| {
                meta.chain_icons.is_none() || meta.network.is_none() || meta.chain_name.is_none()
            })
        })
        .collect();

    if !swap_token_ids_vec.is_empty() {
        let swap_metadata_with_chain =
            fetch_tokens_with_fallback(&state, &swap_token_ids_vec, true, false).await;
        // Override the metadata_map with chain-enriched versions
        metadata_map.extend(swap_metadata_with_chain);
    }

    // Convert enriched changes to RecentActivity format with swap info
    let activities: Vec<RecentActivity> = enriched_changes
        .into_iter()
        .filter_map(|change| {
            // Metadata should always be present since include_metadata=true
            let token_metadata = change
                .token_metadata
                .as_ref()
                .expect("Metadata should always be present");

            // Prefer the stored quote-time USD (confidential rows); fall back to a
            // spot price estimate for public rows that have none.
            let value_usd = resolve_value_usd(&change, token_metadata.price);

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

            // Check if this change has swap info (as fulfillment or deposit leg).
            // Public rows go through the detected_swaps join (`swap_map`).
            // Confidential rows arrive with `change.swap` already populated by
            // confidential_list (route-mod `SwapInfo`, no `swap_role`) — those
            // are always the fulfillment side per the confidential exchange
            // contract.
            let swap = swap_map
                .get(&change.id)
                .map(|(role, idx)| {
                    let s = &swap_records[*idx];
                    let sent_token_metadata = s
                        .sent_token_id
                        .as_ref()
                        .map(|id| resolve_swap_metadata(id, &metadata_map));
                    let received_token_metadata =
                        resolve_swap_metadata(&s.received_token_id, &metadata_map);

                    SwapInfo {
                        sent_token_id: s.sent_token_id.clone(),
                        sent_amount: s.sent_amount.clone(),
                        sent_token_metadata,
                        received_token_id: s.received_token_id.clone(),
                        received_amount: s.received_amount.clone(),
                        received_token_metadata,
                        solver_transaction_hash: s.solver_transaction_hash.clone(),
                        swap_role: role.to_string(),
                    }
                })
                .or_else(|| {
                    change.swap.as_ref().map(|s| SwapInfo {
                        sent_token_id: s.sent_token_id.clone(),
                        sent_amount: s.sent_amount.clone(),
                        sent_token_metadata: s.sent_token_metadata.clone(),
                        received_token_id: s.received_token_id.clone(),
                        received_amount: s.received_amount.clone(),
                        received_token_metadata: s.received_token_metadata.clone(),
                        solver_transaction_hash: s.solver_transaction_hash.clone(),
                        swap_role: "fulfillment".to_string(),
                    })
                });

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
                proposal_id: change.proposal_id,
                swap,
                action_kind: change.action_kind,
                method_name: change.method_name,
            })
        })
        .collect::<Vec<_>>();

    // If we're filtering by USD, we need to return the actual filtered total
    // since we can't count USD-filtered items in SQL
    let actual_total = if params.min_usd_value.is_some() {
        activities.len() as i64
    } else {
        total
    };

    // Only return the requested number of results (pagination)
    let paginated_activities: Vec<RecentActivity> =
        activities.into_iter().take(limit as usize).collect();

    Ok(Json(RecentActivityResponse {
        data: paginated_activities,
        total: actual_total,
    }))
}

pub async fn get_recent_activity_senders(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<RecentActivitySendersQuery>,
) -> Result<Json<RecentActivitySendersResponse>, (StatusCode, Json<serde_json::Value>)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "error": message }))))?;

    // Keep options endpoint unfiltered by date/token/hash/from, but honor transactionType tab.
    let transaction_types_for_query = params
        .transaction_type
        .as_deref()
        .map(|t| vec![t.to_string()]);

    let filters = BalanceChangeFilters {
        account_id: params.account_id.clone(),
        date_cutoff: None,
        start_date: None,
        end_date: None,
        token_ids: None,
        exclude_token_ids: None,
        transaction_types: transaction_types_for_query,
        min_amount: None,
        max_amount: None,
        transaction_hash_query: None,
        from_accounts: None,
        from_accounts_not: None,
        to_accounts: None,
        to_accounts_not: None,
        exclude_near_dust: true,
        exclude_swaps_from_direction: true,
    };

    let (conditions, _) =
        crate::handlers::balance_changes::query_builder::build_where_conditions(&filters);
    let mut where_clause = conditions.join(" AND ");
    where_clause.push_str(&format!(" AND ({}) IS NOT NULL", FROM_ACCOUNT_EXPR));
    where_clause.push_str(&format!(" AND ({}) != 'STAKING_REWARD'", FROM_ACCOUNT_EXPR));

    let query = format!(
        "SELECT DISTINCT \
            ({}) AS from_account \
         FROM balance_changes \
         WHERE {} \
         ORDER BY from_account ASC",
        FROM_ACCOUNT_EXPR, where_clause
    );

    let options_query =
        sqlx::query_scalar::<sqlx::Postgres, String>(&query).bind(params.account_id.as_str());

    let options = options_query.fetch_all(&state.db_pool).await.map_err(|e| {
        tracing::error!("Failed to fetch recent activity senders: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Failed to fetch recent activity senders",
                "details": e.to_string()
            })),
        )
    })?;

    Ok(Json(RecentActivitySendersResponse { options }))
}

pub async fn get_recent_activity_recipients(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<RecentActivityRecipientsQuery>,
) -> Result<Json<RecentActivityRecipientsResponse>, (StatusCode, Json<serde_json::Value>)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "error": message }))))?;

    // Keep options endpoint unfiltered by date/token/hash/to, but honor transactionType tab.
    let transaction_types_for_query = params
        .transaction_type
        .as_deref()
        .map(|t| vec![t.to_string()]);

    let filters = BalanceChangeFilters {
        account_id: params.account_id.clone(),
        date_cutoff: None,
        start_date: None,
        end_date: None,
        token_ids: None,
        exclude_token_ids: None,
        transaction_types: transaction_types_for_query,
        min_amount: None,
        max_amount: None,
        transaction_hash_query: None,
        from_accounts: None,
        from_accounts_not: None,
        to_accounts: None,
        to_accounts_not: None,
        exclude_near_dust: true,
        exclude_swaps_from_direction: true,
    };

    let (conditions, _) =
        crate::handlers::balance_changes::query_builder::build_where_conditions(&filters);
    let mut where_clause = conditions.join(" AND ");
    where_clause.push_str(&format!(" AND ({}) IS NOT NULL", TO_ACCOUNT_EXPR));
    where_clause.push_str(&format!(" AND ({}) != 'STAKING_REWARD'", TO_ACCOUNT_EXPR));

    let query = format!(
        "SELECT DISTINCT \
            ({}) AS to_account \
         FROM balance_changes \
         WHERE {} \
         ORDER BY to_account ASC",
        TO_ACCOUNT_EXPR, where_clause
    );

    let options_query =
        sqlx::query_scalar::<sqlx::Postgres, String>(&query).bind(params.account_id.as_str());

    let options = options_query.fetch_all(&state.db_pool).await.map_err(|e| {
        tracing::error!("Failed to fetch recent activity recipients: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Failed to fetch recent activity recipients",
                "details": e.to_string()
            })),
        )
    })?;

    Ok(Json(RecentActivityRecipientsResponse { options }))
}

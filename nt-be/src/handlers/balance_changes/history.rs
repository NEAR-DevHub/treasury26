//! Balance History APIs
//!
//! Provides endpoints for querying historical balance data:
//! - Chart API: Returns balance snapshots at specified intervals
//! - CSV Export: Returns raw balance changes as downloadable CSV

use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ChartRequest {
    pub account_id: String,
    pub start_time: String, // YYYY-MM-DDTHH:mm:ss
    pub end_time: String,   // YYYY-MM-DDTHH:mm:ss
    pub interval: String,   // "hourly", "daily", "weekly", "monthly"
    #[serde(default)]
    pub token_ids: Option<Vec<String>>, // If omitted, returns all tokens
}

#[derive(Debug, Serialize)]
pub struct BalanceSnapshot {
    pub timestamp: String, // ISO 8601 format
    pub balance: String,   // Decimal-adjusted balance
}

/// Chart API - returns balance snapshots at intervals
///
/// Response format: { "token_id": [{"timestamp": "...", "balance": "..."}] }
pub async fn get_balance_chart(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ChartRequest>,
) -> Result<Json<HashMap<String, Vec<BalanceSnapshot>>>, (StatusCode, String)> {
    // Parse timestamps
    let start_time = parse_datetime(&params.start_time)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid start_time: {}", e)))?;
    let end_time = parse_datetime(&params.end_time)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid end_time: {}", e)))?;

    // Validate interval
    let interval_duration = parse_interval(&params.interval)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // Load prior balances (most recent balance_after for each token before start_time)
    let prior_balances = load_prior_balances(
        &state.db_pool,
        &params.account_id,
        start_time,
        params.token_ids.as_ref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Load all balance changes for the account in the timeframe
    let changes = load_balance_changes(
        &state.db_pool,
        &params.account_id,
        start_time,
        end_time,
        params.token_ids.as_ref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Calculate snapshots at each interval
    let snapshots = calculate_snapshots(changes, prior_balances, start_time, end_time, interval_duration);

    Ok(Json(snapshots))
}

#[derive(Debug, Deserialize)]
pub struct CsvRequest {
    pub account_id: String,
    pub start_time: String, // YYYY-MM-DD (inclusive)
    pub end_time: String,   // YYYY-MM-DD (exclusive)
    #[serde(default)]
    pub token_ids: Option<Vec<String>>,
}

/// CSV Export API - returns balance changes as CSV
///
/// Excludes SNAPSHOT and NOT_REGISTERED records
pub async fn export_balance_csv(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CsvRequest>,
) -> Result<Response, (StatusCode, String)> {
    // Parse dates (YYYY-MM-DD)
    let start_date = parse_date(&params.start_time)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid start_time: {}", e)))?;
    let end_date = parse_date(&params.end_time)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid end_time: {}", e)))?;

    // Query balance changes
    let csv_data = generate_csv(
        &state.db_pool,
        &params.account_id,
        start_date,
        end_date,
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
    amount: String,
    balance_before: String,
    balance_after: String,
    transaction_hashes: Vec<String>,
    receipt_id: Vec<String>,
}

/// Load the most recent balance for each token before start_time
async fn load_prior_balances(
    pool: &PgPool,
    account_id: &str,
    start_time: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
    let mut result = HashMap::new();

    if let Some(tokens) = token_ids {
        let rows = sqlx::query!(
            r#"
            SELECT DISTINCT ON (token_id)
                token_id as "token_id!",
                balance_after::TEXT as "balance!"
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
        .await?;

        for row in rows {
            result.insert(row.token_id, row.balance);
        }
    } else {
        let rows = sqlx::query!(
            r#"
            SELECT DISTINCT ON (token_id)
                token_id as "token_id!",
                balance_after::TEXT as "balance!"
            FROM balance_changes
            WHERE account_id = $1
              AND block_time < $2
            ORDER BY token_id, block_height DESC
            "#,
            account_id,
            start_time
        )
        .fetch_all(pool)
        .await?;

        for row in rows {
            result.insert(row.token_id, row.balance);
        }
    }

    Ok(result)
}

/// Load balance changes from database
async fn load_balance_changes(
    pool: &PgPool,
    account_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<Vec<BalanceChange>, Box<dyn std::error::Error>> {
    let rows = if let Some(tokens) = token_ids {
        sqlx::query!(
            r#"
            SELECT 
                bc.block_height,
                bc.block_time,
                bc.token_id as "token_id!",
                c.token_symbol,
                bc.counterparty as "counterparty!",
                bc.amount::TEXT as "amount!",
                bc.balance_before::TEXT as "balance_before!",
                bc.balance_after::TEXT as "balance_after!",
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
                bc.amount::TEXT as "amount!",
                bc.balance_before::TEXT as "balance_before!",
                bc.balance_after::TEXT as "balance_after!",
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
    prior_balances: HashMap<String, String>,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    interval: chrono::Duration,
) -> HashMap<String, Vec<BalanceSnapshot>> {
    // Group changes by token
    let mut by_token: HashMap<String, Vec<&BalanceChange>> = HashMap::new();
    for change in &changes {
        by_token
            .entry(change.token_id.clone())
            .or_insert_with(Vec::new)
            .push(change);
    }

    // Add tokens that have prior balances but no changes in this timeframe
    for token_id in prior_balances.keys() {
        by_token.entry(token_id.clone()).or_insert_with(Vec::new);
    }

    let mut result: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();

    for (token_id, token_changes) in by_token {
        let mut snapshots = Vec::new();
        let mut current_time = start_time;

        // Get the starting balance for this token
        let starting_balance = prior_balances
            .get(&token_id)
            .map(|s| s.clone())
            .unwrap_or_else(|| "0".to_string());

        while current_time < end_time {
            // Find the most recent balance_after before or at current_time
            let balance = token_changes
                .iter()
                .filter(|c| c.block_time <= current_time)
                .last()
                .map(|c| c.balance_after.clone())
                .unwrap_or_else(|| starting_balance.clone()); // Use starting balance if no changes yet

            snapshots.push(BalanceSnapshot {
                timestamp: current_time.to_rfc3339(),
                balance,
            });

            current_time = current_time + interval;
        }

        result.insert(token_id, snapshots);
    }

    result
}

/// Generate CSV from balance changes
async fn generate_csv(
    pool: &PgPool,
    account_id: &str,
    start_date: DateTime<Utc>,
    end_date: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<String, Box<dyn std::error::Error>> {
    let changes = load_balance_changes(pool, account_id, start_date, end_date, token_ids).await?;

    let mut csv = String::new();

    // Header
    csv.push_str("block_height,block_time,token_id,token_symbol,counterparty,amount,balance_before,balance_after,transaction_hashes,receipt_id\n");

    // Rows (exclude SNAPSHOT and NOT_REGISTERED)
    for change in changes {
        if change.counterparty == "SNAPSHOT" || change.counterparty == "NOT_REGISTERED" {
            continue;
        }

        let tx_hashes = change.transaction_hashes.join(",");
        let receipt_id = change.receipt_id.first().map(|s| s.as_str()).unwrap_or("");
        let token_symbol = change.token_symbol.as_deref().unwrap_or("");

        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            change.block_height,
            change.block_time.to_rfc3339(),
            change.token_id,
            token_symbol,
            change.counterparty,
            change.amount,
            change.balance_before,
            change.balance_after,
            tx_hashes,
            receipt_id
        ));
    }

    Ok(csv)
}

/// Parse YYYY-MM-DDTHH:mm:ss to DateTime
fn parse_datetime(s: &str) -> Result<DateTime<Utc>, String> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .map(|dt| DateTime::from_naive_utc_and_offset(dt, Utc))
        .map_err(|e| format!("Expected format YYYY-MM-DDTHH:mm:ss: {}", e))
}

/// Parse YYYY-MM-DD to DateTime (start of day)
fn parse_date(s: &str) -> Result<DateTime<Utc>, String> {
    NaiveDateTime::parse_from_str(&format!("{} 00:00:00", s), "%Y-%m-%d %H:%M:%S")
        .map(|dt| DateTime::from_naive_utc_and_offset(dt, Utc))
        .map_err(|e| format!("Expected format YYYY-MM-DD: {}", e))
}

/// Parse interval string to Duration
fn parse_interval(interval: &str) -> Result<chrono::Duration, String> {
    match interval {
        "hourly" => Ok(chrono::Duration::hours(1)),
        "daily" => Ok(chrono::Duration::days(1)),
        "weekly" => Ok(chrono::Duration::weeks(1)),
        "monthly" => Ok(chrono::Duration::days(30)), // Approximate
        _ => Err(format!(
            "Invalid interval '{}'. Must be: hourly, daily, weekly, or monthly",
            interval
        )),
    }
}

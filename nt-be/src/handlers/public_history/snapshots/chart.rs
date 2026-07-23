use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::http::StatusCode;
use bigdecimal::{BigDecimal, ToPrimitive, Zero, num_traits::Signed};
use chrono::{DateTime, NaiveDate, Utc};

use super::grid::{
    DAILY_BUCKET_LIMIT, SnapshotGridInterval, WEEKLY_BUCKET_LIMIT, bucket_count, requested_grid,
};
use super::models::SnapshotChartRow;
use super::repository::{
    earliest_snapshot_block_time, latest_snapshot_block_time, load_chart_rows, load_snapshot_cursor,
};
use crate::AppState;
use crate::services::public_balance_reader::{
    BalanceSnapshot, ChartMeta, ChartResponse, ChartStatus, Interval,
};

const INTENTS_PREFIX: &str = "intents.near:";
const NEP245_PREFIX: &str = "nep245:";

/// Keep the existing frontend token-id contract while snapshot storage uses
/// canonical NEP-245 IDs internally.
fn chart_asset_id(asset: &str) -> String {
    if asset.starts_with(NEP245_PREFIX) {
        format!("{INTENTS_PREFIX}{asset}")
    } else {
        asset.to_string()
    }
}

fn stored_asset_id(requested: &str) -> &str {
    requested
        .strip_prefix(INTENTS_PREFIX)
        .filter(|asset| asset.starts_with(NEP245_PREFIX))
        .unwrap_or(requested)
}

fn chart_interval(interval: &Interval) -> Result<SnapshotGridInterval, (StatusCode, String)> {
    match interval {
        Interval::Daily => Ok(SnapshotGridInterval::Daily),
        Interval::Weekly => Ok(SnapshotGridInterval::Weekly),
        Interval::Hourly | Interval::Monthly => Err((
            StatusCode::BAD_REQUEST,
            "public snapshot charts support daily and weekly intervals only".to_string(),
        )),
    }
}

fn bucket_count_is_valid(bucket_count: usize, interval: SnapshotGridInterval) -> bool {
    let maximum = match interval {
        SnapshotGridInterval::Daily => DAILY_BUCKET_LIMIT,
        SnapshotGridInterval::Weekly => WEEKLY_BUCKET_LIMIT,
    };
    bucket_count <= maximum
}

fn unavailable_response(
    applied_at: Option<DateTime<Utc>>,
    last_snapshot_at: Option<DateTime<Utc>>,
    coverage_start: Option<DateTime<Utc>>,
) -> ChartResponse {
    ChartResponse {
        data: HashMap::new(),
        last_synced_at: applied_at,
        chart_meta: Some(ChartMeta {
            status: ChartStatus::Unavailable,
            last_snapshot_at,
            coverage_start,
        }),
    }
}

/// Bucket-time USD prices for every (stored asset, bucket) pair: the stored
/// 5-minute series first (same-day constrained), the daily EOD cache as the
/// historical fallback. Native and staking assets resolve through the same
/// canonical mapping to the NEAR price.
struct BucketPrices {
    minute_grid: HashMap<(String, DateTime<Utc>), BigDecimal>,
    eod_by_asset: HashMap<String, HashMap<NaiveDate, f64>>,
}

impl BucketPrices {
    async fn load(state: &AppState, assets: &[String], buckets: &[DateTime<Utc>]) -> Self {
        let minute_grid = match state
            .token_price_service
            .prices_at_same_day_grid(assets, buckets)
            .await
        {
            Ok(grid) => grid,
            Err(error) => {
                tracing::warn!(error = %error, "chart minute-price lookup failed");
                HashMap::new()
            }
        };

        let dates = buckets
            .iter()
            .map(|bucket| bucket.date_naive())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut eod_by_asset = HashMap::new();
        for asset in assets {
            match state.price_service.get_prices_batch(asset, &dates).await {
                Ok(prices) => {
                    eod_by_asset.insert(asset.clone(), prices);
                }
                Err(error) => {
                    tracing::warn!(asset, error = %error, "chart EOD-price lookup failed");
                }
            }
        }

        Self {
            minute_grid,
            eod_by_asset,
        }
    }

    fn price(&self, asset: &str, bucket: DateTime<Utc>) -> Option<f64> {
        self.minute_grid
            .get(&(asset.to_string(), bucket))
            .filter(|price| !price.is_negative())
            .and_then(ToPrimitive::to_f64)
            .or_else(|| {
                self.eod_by_asset
                    .get(asset)
                    .and_then(|prices| prices.get(&bucket.date_naive()))
                    .filter(|price| price.is_finite() && **price >= 0.0)
                    .copied()
            })
    }
}

/// Snapshot-only public chart builder. Callers choose this entry point only
/// after the rollout flag is enabled; it deliberately has no fallback path.
/// Every bucket carries the latest snapshot at or before it forward; buckets
/// before an asset's first trusted row emit nothing, never zero.
pub async fn build_public_chart_response(
    state: &Arc<AppState>,
    account_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    interval: &Interval,
    token_ids: Option<&Vec<String>>,
) -> Result<ChartResponse, (StatusCode, String)> {
    let interval = chart_interval(interval)?;
    if end_time < start_time {
        return Err((
            StatusCode::BAD_REQUEST,
            "requested public snapshot chart range is invalid or too large".to_string(),
        ));
    }

    // Reject oversized ranges via the O(1) count before materializing the
    // grid. Ordering matters: this is a public endpoint, so building the grid
    // first would turn one huge attacker-chosen date range into millions of
    // loop iterations and a large allocation per request before the bucket
    // limit was ever checked.
    if !bucket_count_is_valid(bucket_count(start_time, end_time, interval), interval) {
        return Err((
            StatusCode::BAD_REQUEST,
            "requested public snapshot chart range is invalid or too large".to_string(),
        ));
    }
    let buckets = requested_grid(start_time, end_time, interval);
    debug_assert!(bucket_count_is_valid(buckets.len(), interval));
    let cursor = load_snapshot_cursor(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let last_snapshot_at = latest_snapshot_block_time(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let coverage_start = earliest_snapshot_block_time(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let Some(cursor) = cursor else {
        return Ok(unavailable_response(None, last_snapshot_at, coverage_start));
    };
    let Some(applied_at) = cursor.snapshot_applied_at else {
        return Ok(unavailable_response(None, last_snapshot_at, coverage_start));
    };
    if cursor.snapshot_applied_generation == 0 || cursor.snapshot_seeded_at.is_none() {
        return Ok(unavailable_response(None, last_snapshot_at, coverage_start));
    }

    let mut rows = load_chart_rows(&state.db_pool, account_id, &buckets)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if rows.is_empty() {
        return Ok(unavailable_response(
            Some(applied_at),
            last_snapshot_at,
            coverage_start,
        ));
    }

    if let Some(wanted) = token_ids.filter(|ids| !ids.is_empty()) {
        let wanted = wanted
            .iter()
            .map(|asset| stored_asset_id(asset))
            .collect::<HashSet<_>>();
        rows.retain(|row| wanted.contains(row.asset.as_str()));
    }

    let assets = rows
        .iter()
        .map(|row| row.asset.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let prices = BucketPrices::load(state.as_ref(), &assets, &buckets).await;

    let mut data: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();
    for SnapshotChartRow {
        asset,
        bucket,
        balance,
    } in rows
    {
        let price_usd = prices.price(&asset, bucket);
        let value_usd = if balance.is_zero() {
            Some(0.0)
        } else {
            price_usd.and_then(|price| balance.to_f64().map(|balance| balance * price))
        };
        data.entry(chart_asset_id(&asset))
            .or_default()
            .push(BalanceSnapshot {
                timestamp: bucket.to_rfc3339(),
                balance,
                price_usd,
                value_usd,
            });
    }

    let status = if cursor.snapshot_dirty_generation > cursor.snapshot_applied_generation {
        ChartStatus::Stale
    } else {
        ChartStatus::Ok
    };
    Ok(ChartResponse {
        data,
        last_synced_at: Some(applied_at),
        chart_meta: Some(ChartMeta {
            status,
            last_snapshot_at,
            coverage_start,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_intervals_and_oversized_ranges() {
        assert!(chart_interval(&Interval::Hourly).is_err());
        assert!(chart_interval(&Interval::Monthly).is_err());
        assert!(!bucket_count_is_valid(91, SnapshotGridInterval::Daily));
        assert!(bucket_count_is_valid(90, SnapshotGridInterval::Daily));
        assert!(!bucket_count_is_valid(54, SnapshotGridInterval::Weekly));
    }

    #[test]
    fn preserves_the_existing_frontend_multi_token_id_contract() {
        let canonical = "nep245:v2_1.omni.hot.tg:43114_token";
        let frontend = "intents.near:nep245:v2_1.omni.hot.tg:43114_token";
        assert_eq!(chart_asset_id(canonical), frontend);
        assert_eq!(stored_asset_id(frontend), canonical);
        assert_eq!(
            chart_asset_id("intents.near:nep141:wrap.near"),
            "intents.near:nep141:wrap.near"
        );
    }

    #[test]
    fn status_is_unavailable_without_an_applied_generation() {
        let response = unavailable_response(None, None, None);
        assert_eq!(
            response.chart_meta.expect("metadata").status,
            ChartStatus::Unavailable
        );
    }
}

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::http::StatusCode;
use bigdecimal::{BigDecimal, ToPrimitive, Zero, num_traits::Signed};
use chrono::{DateTime, NaiveDate, Utc};

use super::grid::{
    DAILY_BUCKET_LIMIT, SnapshotGridInterval, WEEKLY_BUCKET_LIMIT, bucket_count, requested_grid,
};
use super::models::{ChartReadiness, GoldBalancePoint};
use super::repository::{load_chart_readiness, load_gold_balance_points};
use crate::AppState;
use crate::services::public_balance_reader::{
    BalanceSnapshot, ChartMeta, ChartResponse, ChartStatus, Interval,
};

const INTENTS_PREFIX: &str = "intents.near:";
const NEP245_PREFIX: &str = "nep245:";

/// Keep the existing frontend token-id contract while gold stores canonical
/// NEP-245 IDs internally.
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
            "public charts support daily and weekly intervals only".to_string(),
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

fn unavailable_response(readiness: &ChartReadiness) -> ChartResponse {
    ChartResponse {
        data: HashMap::new(),
        last_synced_at: readiness.projection_ready_at,
        chart_meta: Some(ChartMeta {
            status: ChartStatus::Unavailable,
            last_snapshot_at: readiness.ledger_head_time,
            coverage_start: readiness.ledger_coverage_start,
        }),
    }
}

/// Bucket-time USD prices for every (stored asset, bucket) pair: the stored
/// 5-minute series first (same-day constrained), the daily EOD cache as the
/// historical fallback.
struct BucketPrices {
    minute_grid: HashMap<(String, DateTime<Utc>), BigDecimal>,
    eod_by_asset: HashMap<String, HashMap<NaiveDate, f64>>,
}

/// Staking series are denominated in NEAR; price them from the native feed.
fn price_asset(asset: &str) -> &str {
    if asset.starts_with("staking:") {
        "near"
    } else {
        asset
    }
}

impl BucketPrices {
    async fn load(state: &AppState, assets: &[String], buckets: &[DateTime<Utc>]) -> Self {
        let assets: Vec<String> = assets
            .iter()
            .map(|asset| price_asset(asset).to_string())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let assets = assets.as_slice();
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
        let asset = price_asset(asset);
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

/// Per-asset carry-forward over the requested grid: each bucket takes the
/// latest balance-bearing gold leg at or before it. Buckets before an
/// asset's first point emit nothing — missing history is never zero. Points
/// arrive in chain chronology, so one forward pass per asset covers all
/// buckets.
fn carry_forward_balances(
    points: Vec<GoldBalancePoint>,
    buckets: &[DateTime<Utc>],
) -> Vec<(String, DateTime<Utc>, BigDecimal)> {
    let mut points_per_asset: HashMap<String, Vec<GoldBalancePoint>> = HashMap::new();
    for point in points {
        points_per_asset
            .entry(point.asset.clone())
            .or_default()
            .push(point);
    }

    let mut rows = Vec::new();
    for (asset, asset_points) in points_per_asset {
        let mut next_point = 0usize;
        let mut current: Option<&BigDecimal> = None;
        for bucket in buckets {
            while next_point < asset_points.len() && asset_points[next_point].at_time <= *bucket {
                current = Some(&asset_points[next_point].balance);
                next_point += 1;
            }
            if let Some(balance) = current {
                rows.push((asset.clone(), *bucket, balance.clone()));
            }
        }
    }
    rows
}

/// Gold-only public chart builder. Callers choose this entry point only
/// after the rollout flag is enabled; it deliberately has no fallback path.
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
            "requested public chart range is invalid or too large".to_string(),
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
            "requested public chart range is invalid or too large".to_string(),
        ));
    }
    let buckets = requested_grid(start_time, end_time, interval);
    debug_assert!(bucket_count_is_valid(buckets.len(), interval));

    let readiness = load_chart_readiness(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    // Unavailable is reserved for ledgers that have never been fully built:
    // not yet chain-verified (verification passes only after a complete
    // backfill + projection, and never revokes), or a validated staking pool
    // still backfilling. A verified ledger keeps serving through recompute
    // windows — the response degrades to Stale, never to empty.
    if !readiness.verification_passed || !readiness.staking_ready {
        return Ok(unavailable_response(&readiness));
    }

    if !readiness.has_gold_balance_points {
        return Ok(unavailable_response(&readiness));
    }

    let requested_assets = token_ids
        .filter(|ids| !ids.is_empty())
        .map(|ids| {
            ids.iter()
                .map(|asset| stored_asset_id(asset).to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let points = load_gold_balance_points(
        &state.db_pool,
        account_id,
        start_time,
        end_time,
        &requested_assets,
    )
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let assets = points
        .iter()
        .map(|point| point.asset.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let prices = BucketPrices::load(state.as_ref(), &assets, &buckets).await;

    let mut data: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();
    for (asset, bucket, balance) in carry_forward_balances(points, &buckets) {
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
    for snapshots in data.values_mut() {
        snapshots.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    }

    let status =
        if !readiness.projection_ready || readiness.gold_dirty || readiness.head_check_failed {
            ChartStatus::Stale
        } else {
            ChartStatus::Ok
        };
    Ok(ChartResponse {
        data,
        last_synced_at: readiness.projection_ready_at,
        chart_meta: Some(ChartMeta {
            status,
            last_snapshot_at: readiness.ledger_head_time,
            coverage_start: readiness.ledger_coverage_start,
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

    fn point(asset: &str, at_epoch: i64, balance: i64) -> GoldBalancePoint {
        GoldBalancePoint {
            asset: asset.to_string(),
            balance: BigDecimal::from(balance),
            at_time: DateTime::<Utc>::from_timestamp(at_epoch, 0).unwrap(),
            at_height: at_epoch,
            gold_id: at_epoch,
            leg_order: 0,
        }
    }

    #[test]
    fn carry_forward_holds_latest_balance_and_skips_pre_history_buckets() {
        let buckets = vec![
            DateTime::<Utc>::from_timestamp(100, 0).unwrap(),
            DateTime::<Utc>::from_timestamp(200, 0).unwrap(),
            DateTime::<Utc>::from_timestamp(300, 0).unwrap(),
        ];
        let points = vec![point("near", 150, 7), point("near", 250, 3)];

        let rows = carry_forward_balances(points, &buckets);

        assert_eq!(rows.len(), 2, "bucket before first point emits nothing");
        assert_eq!(rows[0].2, BigDecimal::from(7));
        assert_eq!(rows[1].2, BigDecimal::from(3));
    }

    #[test]
    fn carry_forward_takes_latest_point_within_a_bucket() {
        let buckets = vec![DateTime::<Utc>::from_timestamp(300, 0).unwrap()];
        let points = vec![
            point("near", 100, 1),
            point("near", 200, 2),
            point("near", 300, 9),
        ];

        let rows = carry_forward_balances(points, &buckets);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].2, BigDecimal::from(9));
    }
}

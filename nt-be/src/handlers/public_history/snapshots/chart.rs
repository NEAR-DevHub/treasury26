use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::http::StatusCode;
use bigdecimal::ToPrimitive;
use chrono::{DateTime, Duration, Utc};

use super::grid::{SnapshotGridInterval, fixed_coverage, requested_grid};
use super::repository::{
    latest_snapshot_block_time, load_chart_rows, load_snapshot_assets, load_snapshot_cursor,
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

fn stored_price_usd(
    balance: &bigdecimal::BigDecimal,
    usd_value: &bigdecimal::BigDecimal,
) -> Option<f64> {
    if balance == &bigdecimal::BigDecimal::from(0) {
        return None;
    }
    (usd_value / balance).to_f64()
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
        SnapshotGridInterval::Daily => 90,
        SnapshotGridInterval::Weekly => 53,
    };
    bucket_count <= maximum
}

fn grid_coordinates_are_complete(
    asset_count: usize,
    buckets: &[DateTime<Utc>],
    rows: &[super::models::SnapshotChartRow],
) -> bool {
    let expected_rows = asset_count.saturating_mul(buckets.len());
    let actual_coordinates = rows
        .iter()
        .map(|row| (row.asset.as_str(), row.bucket))
        .collect::<HashSet<_>>();
    let mut block_coordinates = HashMap::<DateTime<Utc>, HashSet<i64>>::new();
    for row in rows {
        block_coordinates
            .entry(row.bucket)
            .or_default()
            .insert(row.block_height);
    }

    rows.len() == expected_rows
        && actual_coordinates.len() == expected_rows
        && buckets.iter().all(|bucket| {
            block_coordinates
                .get(bucket)
                .is_some_and(|heights| heights.len() == 1)
        })
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

/// Snapshot-only public chart builder. Callers choose this entry point only
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
            "requested public snapshot chart range is invalid or too large".to_string(),
        ));
    }

    let buckets = requested_grid(start_time, end_time, interval);
    if !bucket_count_is_valid(buckets.len(), interval) {
        return Err((
            StatusCode::BAD_REQUEST,
            "requested public snapshot chart range is invalid or too large".to_string(),
        ));
    }
    let cursor = load_snapshot_cursor(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let last_snapshot_at = latest_snapshot_block_time(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let Some(cursor) = cursor else {
        return Ok(unavailable_response(None, last_snapshot_at, None));
    };
    let Some(applied_at) = cursor.snapshot_applied_at else {
        return Ok(unavailable_response(None, last_snapshot_at, None));
    };
    if cursor.snapshot_applied_generation == 0 {
        return Ok(unavailable_response(None, last_snapshot_at, None));
    }

    let (coverage_start, coverage_end) = fixed_coverage(applied_at, interval);
    if buckets.first().is_some_and(|first| *first < coverage_start)
        || buckets.last().is_some_and(|last| *last > coverage_end)
    {
        return Ok(unavailable_response(
            Some(applied_at),
            last_snapshot_at,
            Some(coverage_start),
        ));
    }

    let assets = load_snapshot_assets(&state.db_pool, account_id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if assets.is_empty() {
        return Ok(unavailable_response(
            Some(applied_at),
            last_snapshot_at,
            Some(coverage_start),
        ));
    }
    let wanted = token_ids.filter(|ids| !ids.is_empty()).map(|ids| {
        ids.iter()
            .map(|asset| stored_asset_id(asset))
            .collect::<HashSet<_>>()
    });

    let lookback = match interval {
        SnapshotGridInterval::Daily => Duration::days(1),
        SnapshotGridInterval::Weekly => Duration::weeks(1),
    };
    let lower_bounds = buckets
        .iter()
        .map(|bucket| *bucket - lookback)
        .collect::<Vec<_>>();
    let mut rows = load_chart_rows(&state.db_pool, account_id, &buckets, &lower_bounds)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let expected_rows = assets.len().saturating_mul(buckets.len());
    if !grid_coordinates_are_complete(assets.len(), &buckets, &rows) {
        tracing::warn!(
            account_id,
            expected_rows,
            actual_rows = rows.len(),
            "public snapshot chart grid is incomplete"
        );
        return Ok(unavailable_response(
            Some(applied_at),
            last_snapshot_at,
            Some(coverage_start),
        ));
    }

    if let Some(wanted) = &wanted {
        rows.retain(|row| wanted.contains(row.asset.as_str()));
    }

    let mut data: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();
    for row in rows {
        let price_usd = row
            .usd_value
            .as_ref()
            .and_then(|usd_value| stored_price_usd(&row.balance, usd_value));
        let value_usd = row.usd_value.as_ref().and_then(ToPrimitive::to_f64);
        data.entry(chart_asset_id(&row.asset))
            .or_default()
            .push(BalanceSnapshot {
                timestamp: row.bucket.to_rfc3339(),
                balance: row.balance,
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
            coverage_start: Some(coverage_start),
        }),
    })
}

#[cfg(test)]
mod tests {
    use bigdecimal::BigDecimal;

    use super::*;

    fn row(
        asset: &str,
        bucket: DateTime<Utc>,
        block_height: i64,
    ) -> super::super::models::SnapshotChartRow {
        super::super::models::SnapshotChartRow {
            asset: asset.to_string(),
            bucket,
            block_height,
            balance: BigDecimal::from(1),
            usd_value: None,
        }
    }

    #[test]
    fn rejects_unsupported_intervals_and_oversized_ranges() {
        assert!(chart_interval(&Interval::Hourly).is_err());
        assert!(chart_interval(&Interval::Monthly).is_err());
        assert!(!bucket_count_is_valid(91, SnapshotGridInterval::Daily));
        assert!(bucket_count_is_valid(90, SnapshotGridInterval::Daily));
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
    fn derives_legacy_price_field_from_stored_value() {
        assert_eq!(
            stored_price_usd(&BigDecimal::from(4), &BigDecimal::from(10)),
            Some(2.5)
        );
        assert_eq!(
            stored_price_usd(&BigDecimal::from(0), &BigDecimal::from(0)),
            None
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

    #[test]
    fn complete_grid_requires_every_asset_at_one_shared_block_per_bucket() {
        let first = DateTime::parse_from_rfc3339("2026-07-20T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let second = first + Duration::days(1);
        let buckets = [first, second];
        let complete = [
            row("near", first, 10),
            row("wrap.near", first, 10),
            row("near", second, 20),
            row("wrap.near", second, 20),
        ];
        assert!(grid_coordinates_are_complete(2, &buckets, &complete));

        let missing = &complete[..3];
        assert!(!grid_coordinates_are_complete(2, &buckets, missing));

        let divergent = [
            row("near", first, 10),
            row("wrap.near", first, 11),
            row("near", second, 20),
            row("wrap.near", second, 20),
        ];
        assert!(!grid_coordinates_are_complete(2, &buckets, &divergent));
    }
}

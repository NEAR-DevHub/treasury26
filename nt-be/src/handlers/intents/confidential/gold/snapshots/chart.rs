use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use bigdecimal::{BigDecimal, ToPrimitive, Zero};
use chrono::{DateTime, NaiveDate, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};

use super::repository::{ChartSnapshotRow, load_snapshots_for_chart};
use crate::handlers::balance_changes::history::{BalanceSnapshot, Interval};
use crate::{AppState, auth::OptionalAuthUser};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidentialChartRequest {
    pub account_id: AccountId,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub interval: Interval,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidentialChartResponse {
    #[serde(flatten)]
    pub data: HashMap<String, Vec<BalanceSnapshot>>,
}

pub async fn get_confidential_balance_chart(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<ConfidentialChartRequest>,
) -> Result<Json<ConfidentialChartResponse>, (StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await?;

    let interval_timestamps: Vec<DateTime<Utc>> = {
        let mut ts = params.start_time;
        let mut out = Vec::new();
        while ts < params.end_time {
            out.push(ts);
            ts = params.interval.increment(ts);
        }
        out
    };

    if interval_timestamps.is_empty() {
        return Ok(Json(ConfidentialChartResponse {
            data: HashMap::new(),
        }));
    }

    let rows = load_snapshots_for_chart(
        &state.db_pool,
        params.account_id.as_str(),
        params.start_time,
        params.end_time,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut data = carry_forward_per_asset(rows, &interval_timestamps);

    enrich_with_prices(&mut data, &state.price_service).await;

    Ok(Json(ConfidentialChartResponse { data }))
}

/// For each bucket, take the latest snapshot whose `snapshot_at <= bucket`. Buckets
/// before the first snapshot for an asset return `0` ("no balance yet").
pub(crate) fn carry_forward_per_asset(
    rows: Vec<ChartSnapshotRow>,
    buckets: &[DateTime<Utc>],
) -> HashMap<String, Vec<BalanceSnapshot>> {
    let mut by_asset: HashMap<String, Vec<ChartSnapshotRow>> = HashMap::new();
    for row in rows {
        by_asset.entry(row.asset.clone()).or_default().push(row);
    }

    let mut data: HashMap<String, Vec<BalanceSnapshot>> = HashMap::new();
    for (asset, asset_rows) in by_asset {
        let mut snapshots = Vec::with_capacity(buckets.len());
        let mut idx = 0usize;
        let mut current_balance: Option<BigDecimal> = None;

        for &bucket in buckets {
            while idx < asset_rows.len() && asset_rows[idx].snapshot_at <= bucket {
                current_balance = Some(asset_rows[idx].balance.clone());
                idx += 1;
            }

            let balance = current_balance.clone().unwrap_or_else(BigDecimal::zero);
            snapshots.push(BalanceSnapshot {
                timestamp: bucket.to_rfc3339(),
                balance,
                price_usd: None,
                value_usd: None,
            });
        }

        data.insert(asset, snapshots);
    }

    data
}

async fn enrich_with_prices<P: crate::services::PriceProvider>(
    data: &mut HashMap<String, Vec<BalanceSnapshot>>,
    price_service: &crate::services::PriceLookupService<P>,
) {
    for (asset, snapshots) in data.iter_mut() {
        let dates: Vec<NaiveDate> = snapshots
            .iter()
            .filter_map(|s| {
                DateTime::parse_from_rfc3339(&s.timestamp)
                    .ok()
                    .map(|dt| dt.date_naive())
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        if dates.is_empty() {
            continue;
        }

        let prices = match price_service.get_prices_batch(asset, &dates).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("price lookup failed for {}: {}", asset, e);
                continue;
            }
        };

        for snapshot in snapshots.iter_mut() {
            let Some(date) = DateTime::parse_from_rfc3339(&snapshot.timestamp)
                .ok()
                .map(|dt| dt.date_naive())
            else {
                continue;
            };
            if let Some(&price) = prices.get(&date) {
                snapshot.price_usd = Some(price);
                if let Some(balance_f64) = snapshot.balance.to_f64() {
                    snapshot.value_usd = Some(balance_f64 * price);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn ts(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn row(asset: &str, at: &str, balance: &str) -> ChartSnapshotRow {
        ChartSnapshotRow {
            asset: asset.to_string(),
            snapshot_at: ts(at),
            balance: BigDecimal::from_str(balance).unwrap(),
        }
    }

    #[test]
    fn carry_forward_fills_zeros_before_first_snapshot() {
        let buckets = vec![
            ts("2026-05-01T00:00:00Z"),
            ts("2026-05-02T00:00:00Z"),
            ts("2026-05-03T00:00:00Z"),
            ts("2026-05-04T00:00:00Z"),
        ];
        let rows = vec![row("nep141:usdt.near", "2026-05-03T00:00:00Z", "10")];

        let series = carry_forward_per_asset(rows, &buckets);
        let usdt = series.get("nep141:usdt.near").unwrap();

        assert_eq!(usdt[0].balance, BigDecimal::from(0));
        assert_eq!(usdt[1].balance, BigDecimal::from(0));
        assert_eq!(usdt[2].balance, BigDecimal::from(10));
        assert_eq!(usdt[3].balance, BigDecimal::from(10));
    }

    #[test]
    fn carry_forward_advances_on_each_snapshot() {
        let buckets = vec![
            ts("2026-05-01T00:00:00Z"),
            ts("2026-05-02T00:00:00Z"),
            ts("2026-05-03T00:00:00Z"),
            ts("2026-05-04T00:00:00Z"),
        ];
        let rows = vec![
            row("nep141:usdt.near", "2026-05-01T00:00:00Z", "5"),
            row("nep141:usdt.near", "2026-05-03T00:00:00Z", "20"),
        ];

        let series = carry_forward_per_asset(rows, &buckets);
        let usdt = series.get("nep141:usdt.near").unwrap();

        assert_eq!(usdt[0].balance, BigDecimal::from(5));
        assert_eq!(usdt[1].balance, BigDecimal::from(5));
        assert_eq!(usdt[2].balance, BigDecimal::from(20));
        assert_eq!(usdt[3].balance, BigDecimal::from(20));
    }

    #[test]
    fn carry_forward_zero_tombstone_propagates() {
        let buckets = vec![
            ts("2026-05-01T00:00:00Z"),
            ts("2026-05-02T00:00:00Z"),
            ts("2026-05-03T00:00:00Z"),
        ];
        let rows = vec![
            row("nep141:usdt.near", "2026-05-01T00:00:00Z", "100"),
            row("nep141:usdt.near", "2026-05-02T00:00:00Z", "0"),
        ];

        let series = carry_forward_per_asset(rows, &buckets);
        let usdt = series.get("nep141:usdt.near").unwrap();

        assert_eq!(usdt[0].balance, BigDecimal::from(100));
        assert_eq!(usdt[1].balance, BigDecimal::from(0));
        assert_eq!(usdt[2].balance, BigDecimal::from(0));
    }

    #[test]
    fn carry_forward_per_asset_isolation() {
        let buckets = vec![ts("2026-05-02T00:00:00Z"), ts("2026-05-03T00:00:00Z")];
        let rows = vec![
            row("nep141:a", "2026-05-01T00:00:00Z", "1"),
            row("nep141:b", "2026-05-03T00:00:00Z", "2"),
        ];

        let series = carry_forward_per_asset(rows, &buckets);

        assert_eq!(series["nep141:a"][0].balance, BigDecimal::from(1));
        assert_eq!(series["nep141:a"][1].balance, BigDecimal::from(1));
        assert_eq!(series["nep141:b"][0].balance, BigDecimal::from(0));
        assert_eq!(series["nep141:b"][1].balance, BigDecimal::from(2));
    }
}

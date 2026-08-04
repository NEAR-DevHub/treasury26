use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use bigdecimal::{BigDecimal, ToPrimitive, Zero};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};

use super::repository::{ChartSnapshotRow, latest_snapshot_at, load_snapshots_for_chart};
use super::worker::{SNAPSHOT_DEDUP_WINDOW, snapshot_confidential_dao_balances};
use crate::handlers::balance_changes::history::{
    BalanceSnapshot, ChartMeta, ChartResponse, ChartStatus, Interval,
};
use crate::services::TokenPriceService;
use crate::{AppState, auth::OptionalAuthUser};

/// Public history sources emit intents tokens as `intents.near:<defuse id>`;
/// confidential chart series use the same shape so the frontend can match
/// them against its asset groups.
pub const INTENTS_TOKEN_ID_PREFIX: &str = "intents.near:";

/// Newest snapshot older than this marks the chart response as stale
/// (~2x the hourly snapshot cron cadence).
const STALE_SNAPSHOT_AFTER: Duration = Duration::hours(2);

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

    let data = build_confidential_chart_data(
        &state,
        params.account_id.as_str(),
        params.start_time,
        params.end_time,
        &params.interval,
        None,
    )
    .await?;

    Ok(Json(ConfidentialChartResponse { data }))
}

/// Snapshot-derived chart series for a confidential DAO. Series keys are
/// `intents.near:`-prefixed defuse asset ids; `token_ids` filters accept
/// both the prefixed and the raw form.
pub async fn build_confidential_chart_data(
    state: &AppState,
    account_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    interval: &Interval,
    token_ids: Option<&Vec<String>>,
) -> Result<HashMap<String, Vec<BalanceSnapshot>>, (StatusCode, String)> {
    let interval_timestamps: Vec<DateTime<Utc>> = {
        let mut ts = start_time;
        let mut out = Vec::new();
        while ts < end_time {
            out.push(ts);
            ts = interval.increment(ts);
        }
        out
    };

    if interval_timestamps.is_empty() {
        return Ok(HashMap::new());
    }

    let mut rows = load_snapshots_for_chart(&state.db_pool, account_id, start_time, end_time)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(filter) = token_ids.filter(|ids| !ids.is_empty()) {
        let wanted: HashSet<&str> = filter
            .iter()
            .map(|id| id.strip_prefix(INTENTS_TOKEN_ID_PREFIX).unwrap_or(id))
            .collect();
        rows.retain(|row| wanted.contains(row.asset.as_str()));
    }

    let mut data = carry_forward_per_asset(rows, &interval_timestamps);

    enrich_with_prices(&mut data, &state.token_price_service, &state.price_service).await;

    Ok(data
        .into_iter()
        .map(|(asset, snapshots)| (format!("{INTENTS_TOKEN_ID_PREFIX}{asset}"), snapshots))
        .collect())
}

/// [`build_confidential_chart_data`] wrapped in the `/api/balance-history/chart`
/// response shape, with snapshot freshness surfaced as `chartMeta`. When the
/// newest snapshot has fallen behind the snapshot dedup window, a refresh is
/// spawned in the background so the next load is fresh.
pub async fn build_confidential_snapshot_chart_response(
    state: &Arc<AppState>,
    account_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    interval: &Interval,
    token_ids: Option<&Vec<String>>,
) -> Result<ChartResponse, (StatusCode, String)> {
    let data =
        build_confidential_chart_data(state, account_id, start_time, end_time, interval, token_ids)
            .await?;

    let last_snapshot_at = latest_snapshot_at(&state.db_pool, account_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let now = Utc::now();
    let status = match last_snapshot_at {
        None => ChartStatus::Unavailable,
        Some(at) if at < now - STALE_SNAPSHOT_AFTER => ChartStatus::Stale,
        Some(_) => ChartStatus::Ok,
    };

    if last_snapshot_at.is_none_or(|at| at < now - SNAPSHOT_DEDUP_WINDOW) {
        let state = Arc::clone(state);
        let dao_id = account_id.to_string();
        tokio::spawn(async move {
            snapshot_confidential_dao_balances(state.as_ref(), &dao_id).await;
        });
    }

    Ok(ChartResponse {
        data,
        last_synced_at: last_snapshot_at,
        chart_meta: Some(ChartMeta {
            status,
            last_snapshot_at,
            coverage_start: None,
        }),
    })
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

/// Price each bucket from the 1Click-fed 5-minute `token_prices` series
/// (covers every intents token, including ones with no external price-feed
/// mapping), falling back to the daily-EOD `historical_prices` cache for
/// buckets that predate the stored series.
async fn enrich_with_prices<P: crate::services::PriceProvider>(
    data: &mut HashMap<String, Vec<BalanceSnapshot>>,
    token_prices: &TokenPriceService,
    eod_prices: &crate::services::PriceLookupService<P>,
) {
    let assets: Vec<String> = data.keys().cloned().collect();
    let buckets: Vec<DateTime<Utc>> = data
        .values()
        .flatten()
        .filter_map(|s| {
            DateTime::parse_from_rfc3339(&s.timestamp)
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    if assets.is_empty() || buckets.is_empty() {
        return;
    }

    let grid = match token_prices.prices_at_grid(&assets, &buckets).await {
        Ok(grid) => grid,
        Err(e) => {
            tracing::warn!("token price grid lookup failed: {}", e);
            HashMap::new()
        }
    };

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

        let eod = match eod_prices.get_prices_batch(asset, &dates).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("price lookup failed for {}: {}", asset, e);
                HashMap::new()
            }
        };

        for snapshot in snapshots.iter_mut() {
            let Some(ts) = DateTime::parse_from_rfc3339(&snapshot.timestamp)
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
            else {
                continue;
            };

            let price = grid
                .get(&(asset.clone(), ts))
                .and_then(|p| p.to_f64())
                .or_else(|| eod.get(&ts.date_naive()).copied());

            if let Some(price) = price {
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
    use crate::utils::test_utils::build_test_state;
    use sqlx::PgPool;
    use std::str::FromStr;

    fn ts(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&Utc)
    }

    const DAO: &str = "chart-test.sputnik-dao.near";

    async fn seed_snapshot(pool: &PgPool, asset: &str, balance: &str, at: DateTime<Utc>) {
        sqlx::query(
            r#"
            INSERT INTO gold_confidential_balance_snapshots
                (dao_id, asset, snapshot_at, raw_balance, balance)
            VALUES ($1, $2, $3, $4, $4)
            "#,
        )
        .bind(DAO)
        .bind(asset)
        .bind(at)
        .bind(BigDecimal::from_str(balance).unwrap())
        .execute(pool)
        .await
        .expect("seed snapshot");
    }

    #[sqlx::test]
    async fn chart_response_serves_prefixed_snapshot_series(pool: PgPool) {
        let state = Arc::new(build_test_state(pool.clone()));
        let now = Utc::now();
        seed_snapshot(&pool, "nep141:wrap.near", "5", now - Duration::days(2)).await;
        seed_snapshot(
            &pool,
            "nep141:eth.omft.near",
            "1",
            now - Duration::minutes(10),
        )
        .await;

        let response = build_confidential_snapshot_chart_response(
            &state,
            DAO,
            now - Duration::days(3),
            now,
            &Interval::Daily,
            None,
        )
        .await
        .expect("chart response");

        // Series keys use the same shape the public history sources emit.
        assert!(response.data.contains_key("intents.near:nep141:wrap.near"));
        assert!(
            response
                .data
                .contains_key("intents.near:nep141:eth.omft.near")
        );

        let meta = response.chart_meta.expect("chart meta present");
        assert_eq!(meta.status, ChartStatus::Ok);
        assert_eq!(response.last_synced_at, meta.last_snapshot_at);

        let wrap = &response.data["intents.near:nep141:wrap.near"];
        assert_eq!(wrap.last().unwrap().balance, BigDecimal::from(5));
    }

    #[sqlx::test]
    async fn chart_token_filter_accepts_prefixed_ids(pool: PgPool) {
        let state = Arc::new(build_test_state(pool.clone()));
        let now = Utc::now();
        seed_snapshot(&pool, "nep141:wrap.near", "5", now - Duration::minutes(10)).await;
        seed_snapshot(
            &pool,
            "nep141:eth.omft.near",
            "1",
            now - Duration::minutes(10),
        )
        .await;

        let filter = vec!["intents.near:nep141:wrap.near".to_string()];
        let data = build_confidential_chart_data(
            &state,
            DAO,
            now - Duration::days(1),
            now,
            &Interval::Daily,
            Some(&filter),
        )
        .await
        .expect("chart data");

        assert_eq!(data.len(), 1);
        assert!(data.contains_key("intents.near:nep141:wrap.near"));
    }

    #[sqlx::test]
    async fn chart_without_snapshots_is_unavailable(pool: PgPool) {
        let state = Arc::new(build_test_state(pool.clone()));
        let now = Utc::now();

        let response = build_confidential_snapshot_chart_response(
            &state,
            DAO,
            now - Duration::days(1),
            now,
            &Interval::Daily,
            None,
        )
        .await
        .expect("chart response");

        assert!(response.data.is_empty());
        let meta = response.chart_meta.expect("chart meta present");
        assert_eq!(meta.status, ChartStatus::Unavailable);
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

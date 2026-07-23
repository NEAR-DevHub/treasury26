use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use bigdecimal::{
    BigDecimal, Zero,
    num_traits::{FromPrimitive, Signed},
};
use chrono::{DateTime, NaiveDate, Utc};
use futures::{StreamExt, stream};
use near_api::{Chain, Reference};

use super::models::{
    PublicBalanceSnapshotRow, SnapshotAsset, SnapshotAssetKind, SnapshotUsdScanCursor,
};
use super::repository::{
    load_latest_balances_per_asset, load_missing_usd_rows, load_silver_assets,
    load_snapshot_assets, load_staking_pool_candidates, publish_sparse_snapshot_refresh,
    update_snapshot_usd_values,
};
use super::seed::LegacyHistorySeeder;
use crate::AppState;
use crate::services::public_balance_reader::{
    get_public_balance_at_block, validate_staking_pool_at_block,
};

const RPC_WORKERS: usize = 8;
const USD_REPAIR_BATCH_SIZE: usize = 5_000;
const USD_REPAIR_MAX_ROWS: usize = 50_000;

#[derive(Debug, Clone)]
pub struct SnapshotError(String);

impl SnapshotError {
    fn message(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SnapshotError {}

impl From<sqlx::Error> for SnapshotError {
    fn from(error: sqlx::Error) -> Self {
        Self(error.to_string())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SnapshotRefreshOutcome {
    pub rows_written: u64,
    pub seeded_rows: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SnapshotUsdRepairSummary {
    pub rows_scanned: usize,
    pub rows_updated: u64,
    pub unresolved_rows: usize,
}

impl fmt::Display for SnapshotUsdRepairSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "scanned={} updated={} unresolved={}",
            self.rows_scanned, self.rows_updated, self.unresolved_rows
        )
    }
}

fn is_valid_account(account_id: &str) -> bool {
    account_id.parse::<near_api::AccountId>().is_ok()
}

#[derive(Debug, Clone, Copy)]
struct FinalizedBlock {
    block_height: u64,
    block_time: DateTime<Utc>,
}

/// One finalized block per refresh so every affected balance is read at the
/// same chain state. Recent finalized blocks are served by the regular RPC —
/// no archival dependency.
async fn capture_finalized_block(state: &AppState) -> Result<FinalizedBlock, SnapshotError> {
    let block = Chain::block()
        .at(Reference::Final)
        .fetch_from(&state.network)
        .await
        .map_err(|error| SnapshotError::message(format!("final block fetch failed: {error}")))?;
    let timestamp_ns = i64::try_from(block.header.timestamp)
        .map_err(|_| SnapshotError::message("block timestamp exceeds i64"))?;
    Ok(FinalizedBlock {
        block_height: block.header.height,
        block_time: DateTime::from_timestamp_nanos(timestamp_ns),
    })
}

/// Assets whose balances the refresh must re-read.
///
/// `since = None` (first refresh after the seed, or an explicit full-rebuild
/// mark) derives the complete inventory. Otherwise the set is event-driven:
/// Silver legs name the moved tokens, any successful receipt affects `near`
/// (gas, storage, attached deposits), staking-method receipts name pool
/// candidates — plus every staking asset already held, because staking
/// rewards accrue without any on-chain event from the account.
async fn derive_affected_assets(
    state: &AppState,
    account_id: &str,
    since: Option<DateTime<Utc>>,
    validation_block_height: u64,
) -> Result<BTreeSet<SnapshotAsset>, SnapshotError> {
    let mut assets = BTreeSet::new();
    let stored_assets = load_snapshot_assets(&state.db_pool, account_id).await?;

    match since {
        None => {
            assets.insert(SnapshotAsset::near());
            assets.extend(
                stored_assets
                    .iter()
                    .map(|id| SnapshotAsset::from_stored_id(id)),
            );
        }
        Some(since) => {
            // Standing staking holdings always refresh because rewards change
            // balances without producing a receipt; everything else waits for
            // an activity signal.
            assets.extend(
                stored_assets
                    .iter()
                    .map(|id| SnapshotAsset::from_stored_id(id))
                    .filter(|asset| asset.kind == SnapshotAssetKind::Staking),
            );
            // Bronze is used only as an activity signal here. Successful
            // receipts can change NEAR through gas, storage or attached
            // deposits without producing a normalized Silver transfer leg;
            // the balance itself is read authoritatively from RPC below.
            if super::repository::has_successful_receipt_since(&state.db_pool, account_id, since)
                .await?
            {
                assets.insert(SnapshotAsset::near());
            }
        }
    }

    for row in load_silver_assets(&state.db_pool, account_id, since).await? {
        assets.insert(row.into_asset().map_err(SnapshotError::message)?);
    }

    let validated_pools: BTreeSet<&str> = assets
        .iter()
        .filter_map(|asset| asset.id.strip_prefix("staking:"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // Staking FUNCTION_CALL actions do not produce Silver transfer legs, so
    // Bronze supplies only the pool candidate. Interface validation and the
    // eventual account balance both come from RPC; no balance is derived from
    // the raw Bronze payload.
    let candidates = load_staking_pool_candidates(&state.db_pool, account_id, since)
        .await?
        .into_iter()
        .filter(|pool_id| !validated_pools.contains(pool_id.as_str()))
        .filter(|pool_id| is_valid_account(pool_id))
        .collect::<Vec<_>>();
    for pool_id in candidates {
        let is_pool = validate_staking_pool_at_block(
            &state.network,
            account_id,
            &pool_id,
            validation_block_height,
        )
        .await
        .map_err(|error| {
            SnapshotError::message(format!(
                "staking interface validation failed for {pool_id}: {error}"
            ))
        })?;
        if is_pool {
            assets.insert(SnapshotAsset::staking(pool_id));
        }
    }

    Ok(assets)
}

/// Read every affected balance at the shared finalized block. Any failure
/// aborts the whole refresh: the generation stays dirty for the durable
/// retry, and a failed read is never written as zero.
async fn fetch_live_balances(
    state: &AppState,
    account_id: &str,
    assets: &BTreeSet<SnapshotAsset>,
    block: FinalizedBlock,
) -> Result<Vec<(SnapshotAsset, BigDecimal)>, SnapshotError> {
    let mut reads = stream::iter(assets.iter().cloned().map(|asset| {
        let account_id = account_id.to_string();
        async move {
            let balance = get_public_balance_at_block(
                &state.db_pool,
                &state.network,
                &account_id,
                &asset.id,
                block.block_height,
            )
            .await
            .map_err(|error| {
                SnapshotError::message(format!(
                    "balance read failed for {} at {}: {}",
                    asset.id, block.block_height, error
                ))
            })?;
            if balance.is_negative() {
                return Err(SnapshotError::message(format!(
                    "authoritative reader returned negative balance for {} at {}",
                    asset.id, block.block_height
                )));
            }
            Ok::<_, SnapshotError>((asset, balance))
        }
    }))
    .buffer_unordered(RPC_WORKERS);

    let mut balances = Vec::with_capacity(assets.len());
    while let Some(result) = reads.next().await {
        balances.push(result?);
    }
    Ok(balances)
}

/// Execute one durable per-DAO Apalis payload. The cursor is re-read so an
/// obsolete payload is a cheap no-op; the guarded publisher performs the same
/// generation check again under the per-DAO lock after all external calls.
pub async fn project_public_balance_snapshot_generation(
    state: &Arc<AppState>,
    account_id: &str,
    generation: i64,
) -> Result<Option<SnapshotRefreshOutcome>, SnapshotError> {
    let Some(cursor) = super::repository::load_snapshot_cursor(&state.db_pool, account_id).await?
    else {
        return Ok(None);
    };
    if cursor.snapshot_dirty_generation != generation
        || cursor.snapshot_applied_generation >= generation
    {
        return Ok(None);
    }

    // The one-time historical seed. Runs outside the publication lock and is
    // idempotent (seed rows never overwrite live ones), so a lost race with
    // another payload is harmless.
    let needs_seed = cursor.snapshot_seeded_at.is_none();
    let mut seeded_rows = 0;
    if needs_seed {
        let outcome = LegacyHistorySeeder::new(&state.db_pool, account_id)
            .seed()
            .await?;
        seeded_rows = outcome.rows_written;
        tracing::info!(
            account_id,
            rows = outcome.rows_written,
            assets = outcome.assets_seeded,
            skipped_assets = outcome.assets_skipped,
            gaps = outcome.gaps_detected,
            "seeded public balance history from the trusted legacy ledger"
        );
    }

    let block = capture_finalized_block(state.as_ref()).await?;
    // A fresh seed refreshes the complete inventory so assets missing from
    // the legacy ledger get their authoritative current row immediately.
    let since = if needs_seed {
        None
    } else {
        cursor.snapshot_recompute_from
    };
    let affected =
        derive_affected_assets(state.as_ref(), account_id, since, block.block_height).await?;
    let live = fetch_live_balances(state.as_ref(), account_id, &affected, block).await?;

    let latest: HashMap<String, BigDecimal> =
        load_latest_balances_per_asset(&state.db_pool, account_id)
            .await?
            .into_iter()
            .collect();
    let rows: Vec<PublicBalanceSnapshotRow> = live
        .into_iter()
        .filter(|(asset, balance)| latest.get(&asset.id) != Some(balance))
        .map(|(asset, balance)| {
            let usd_value = if balance.is_zero() {
                Some(BigDecimal::zero())
            } else {
                state
                    .token_price_service
                    .latest_price(&asset.id)
                    .map(|(price, _)| &balance * price)
            };
            PublicBalanceSnapshotRow {
                dao_id: account_id.to_string(),
                asset: asset.id,
                block_height: block.block_height as i64,
                block_time: block.block_time,
                balance,
                usd_value,
            }
        })
        .collect();

    let written =
        publish_sparse_snapshot_refresh(&state.db_pool, account_id, generation, &rows, needs_seed)
            .await?;
    Ok(written.map(|rows_written| SnapshotRefreshOutcome {
        rows_written,
        seeded_rows,
    }))
}

fn attach_verified_zero_usd_values(
    rows: &mut BTreeMap<(String, String, i64), PublicBalanceSnapshotRow>,
) {
    for row in rows.values_mut().filter(|row| row.balance.is_zero()) {
        row.usd_value = Some(BigDecimal::zero());
    }
}

fn attach_asset_usd_values(
    rows: &mut BTreeMap<(String, String, i64), PublicBalanceSnapshotRow>,
    asset: &str,
    grid: &HashMap<(String, DateTime<Utc>), BigDecimal>,
    eod: &HashMap<NaiveDate, f64>,
) {
    for row in rows
        .values_mut()
        .filter(|row| row.asset == asset && !row.balance.is_zero())
    {
        let price = grid
            .get(&(asset.to_string(), row.block_time))
            .cloned()
            .filter(|price| !price.is_negative())
            .or_else(|| {
                eod.get(&row.block_time.date_naive())
                    .filter(|price| price.is_finite() && **price >= 0.0)
                    .and_then(|price| BigDecimal::from_f64(*price))
            });
        row.usd_value = price.map(|price| &row.balance * price);
    }
}

async fn attach_usd_values(
    state: &AppState,
    rows: &mut BTreeMap<(String, String, i64), PublicBalanceSnapshotRow>,
) {
    attach_verified_zero_usd_values(rows);

    let mut times_by_asset: BTreeMap<String, Vec<DateTime<Utc>>> = BTreeMap::new();
    for row in rows.values().filter(|row| !row.balance.is_zero()) {
        times_by_asset
            .entry(row.asset.clone())
            .or_default()
            .push(row.block_time);
    }

    for (asset, mut times) in times_by_asset {
        times.sort_unstable();
        times.dedup();
        let grid = match state
            .token_price_service
            .prices_at_same_day_grid(std::slice::from_ref(&asset), &times)
            .await
        {
            Ok(grid) => grid,
            Err(error) => {
                tracing::warn!(asset, error = %error, "snapshot minute-price lookup failed");
                HashMap::new()
            }
        };
        let dates = times
            .iter()
            .map(|time| time.date_naive())
            .collect::<HashSet<NaiveDate>>()
            .into_iter()
            .collect::<Vec<_>>();
        let eod = match state.price_service.get_prices_batch(&asset, &dates).await {
            Ok(prices) => prices,
            Err(error) => {
                tracing::warn!(asset, error = %error, "snapshot EOD-price lookup failed");
                HashMap::new()
            }
        };

        attach_asset_usd_values(rows, &asset, &grid, &eod);
    }
}

/// Hourly repair of `usd_value IS NULL` rows — primarily the seeded history,
/// whose block times predate the stored minute price series and price from
/// the EOD cache instead.
pub async fn repair_missing_public_snapshot_usd_values(
    state: &AppState,
) -> Result<SnapshotUsdRepairSummary, SnapshotError> {
    let mut summary = SnapshotUsdRepairSummary::default();
    let mut cursor: Option<SnapshotUsdScanCursor> = None;

    while summary.rows_scanned < USD_REPAIR_MAX_ROWS {
        let remaining = USD_REPAIR_MAX_ROWS - summary.rows_scanned;
        let limit = remaining.min(USD_REPAIR_BATCH_SIZE);
        let missing = load_missing_usd_rows(&state.db_pool, cursor.as_ref(), limit as i64).await?;
        if missing.is_empty() {
            break;
        }

        let batch_len = missing.len();
        cursor = missing.last().map(SnapshotUsdScanCursor::from);
        summary.rows_scanned += batch_len;

        let mut rows = missing
            .into_iter()
            .map(|row| {
                (
                    (row.dao_id.clone(), row.asset.clone(), row.block_height),
                    row,
                )
            })
            .collect::<BTreeMap<_, _>>();
        attach_usd_values(state, &mut rows).await;

        let resolved = rows
            .into_values()
            .filter(|row| row.usd_value.is_some())
            .collect::<Vec<_>>();
        summary.unresolved_rows += batch_len - resolved.len();
        summary.rows_updated += update_snapshot_usd_values(&state.db_pool, &resolved).await?;

        if batch_len < limit {
            break;
        }
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn snapshots_module_has_no_legacy_table_reference() {
        // The seed module is the single sanctioned reader of the legacy
        // table and enforces its own read-only guard.
        let sources = [
            include_str!("mod.rs"),
            include_str!("chart.rs"),
            include_str!("jobs.rs"),
            include_str!("models.rs"),
            include_str!("repository.rs"),
            include_str!("grid.rs"),
            include_str!("worker.rs"),
            include_str!("../../../services/public_balance_reader.rs"),
        ];
        let table = ["balance", "changes"].join("_");
        let sql_patterns = [
            format!("from {table}"),
            format!("join {table}"),
            format!("update {table}"),
            format!("insert into {table}"),
            format!("delete from {table}"),
        ];

        for source in sources {
            let normalized = source
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase();
            assert!(
                sql_patterns
                    .iter()
                    .all(|pattern| !normalized.contains(pattern)),
                "public snapshot SQL must not depend on the legacy balance table"
            );
        }
    }

    #[test]
    fn verified_zero_balances_get_zero_usd_without_a_price() {
        let row = PublicBalanceSnapshotRow {
            dao_id: "zero.sputnik-dao.near".to_string(),
            asset: "unknown.near".to_string(),
            block_height: 7,
            block_time: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            balance: BigDecimal::zero(),
            usd_value: None,
        };
        let key = (row.dao_id.clone(), row.asset.clone(), row.block_height);
        let mut rows = BTreeMap::from([(key, row)]);

        attach_verified_zero_usd_values(&mut rows);
        attach_asset_usd_values(&mut rows, "unknown.near", &HashMap::new(), &HashMap::new());

        assert_eq!(
            rows.values().next().unwrap().usd_value,
            Some(BigDecimal::zero())
        );
    }
}

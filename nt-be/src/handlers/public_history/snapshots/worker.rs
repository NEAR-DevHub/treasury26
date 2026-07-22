use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use bigdecimal::{
    BigDecimal, Zero,
    num_traits::{FromPrimitive, Signed},
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use futures::{StreamExt, stream};
use near_api::{Chain, Contract, Reference};
use serde::Deserialize;

use super::block_resolver::{ResolvedBlock, resolve_block_at_or_before};
use super::grid::fixed_checkpoint_grid;
use super::models::{
    AuthoritativePoint, EventDelta, PublicBalanceSnapshotRow, SnapshotAsset, SnapshotCycleStats,
    group_event_deltas,
};
use super::repository::{
    load_complete_snapshot_dataset, load_dirty_snapshot_cursors, load_historical_assets,
    load_historical_multi_token_contracts, load_missing_usd_rows, load_native_event_coordinates,
    load_real_silver_legs, load_staking_event_coordinates, mark_due_checkpoint_generations,
    publish_complete_snapshot_generation, update_snapshot_usd_values,
};
use crate::AppState;
use crate::services::public_balance_reader::{
    get_public_balance_at_block, validate_staking_pool_at_block,
};

const ACCOUNT_WORKERS: usize = 2;
const RPC_WORKERS: usize = 8;
const SUPPORTED_MULTI_TOKEN_CONTRACTS: &[&str] = &["intents.near", "v2_1.omni.hot.tg"];
pub const SOURCE_REFRESH_MAX_AGE_MINUTES: i64 = 15;
pub const SOURCE_REFRESH_BLOCK_LAG_ALLOWANCE: i64 = 1_200;

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

#[derive(Debug, Deserialize)]
struct StrictFastNearToken {
    contract_id: String,
    balance: String,
}

#[derive(Debug, Deserialize)]
struct StrictFastNearAccount {
    tokens: Vec<StrictFastNearToken>,
}

#[derive(Debug, Deserialize)]
struct OwnedMultiToken {
    token_id: String,
}

#[derive(Debug, Deserialize)]
struct StrictStakingPool {
    pool_id: String,
}

#[derive(Debug, Deserialize)]
struct StrictStakingResponse {
    pools: Vec<StrictStakingPool>,
}

#[derive(Debug)]
struct CurrentAssetDiscovery {
    assets: BTreeSet<SnapshotAsset>,
    staking_candidates: BTreeSet<String>,
}

fn is_valid_account(account_id: &str) -> bool {
    account_id.parse::<near_api::AccountId>().is_ok()
}

fn multi_token_contract_from_asset_id(asset_id: &str) -> Option<&str> {
    if let Some(rest) = asset_id.strip_prefix("nep245:") {
        return rest
            .split_once(':')
            .map(|(contract, _)| contract)
            .filter(|contract| !contract.is_empty());
    }
    asset_id
        .strip_prefix("intents.near:")
        .map(|_| "intents.near")
}

fn canonical_multi_token_asset_id(
    contract_id: &str,
    token_id: &str,
) -> Result<String, SnapshotError> {
    if !is_valid_account(contract_id) || token_id.is_empty() {
        return Err(SnapshotError::message(format!(
            "invalid multi-token inventory entry contract={contract_id} token={token_id}"
        )));
    }

    if contract_id == "intents.near" {
        if token_id.starts_with("intents.near:") {
            return Ok(token_id.to_string());
        }
        if let Some(token) = token_id.strip_prefix("nep245:intents.near:") {
            if token.is_empty() {
                return Err(SnapshotError::message("empty intents token id"));
            }
            return Ok(format!("intents.near:{token}"));
        }
        return Ok(format!("intents.near:{token_id}"));
    }

    let canonical_prefix = format!("nep245:{contract_id}:");
    if token_id.starts_with(&canonical_prefix) {
        return Ok(token_id.to_string());
    }
    let contract_prefix = format!("{contract_id}:");
    if token_id.starts_with(&contract_prefix) {
        return Ok(format!("nep245:{token_id}"));
    }
    Ok(format!("{canonical_prefix}{token_id}"))
}

async fn validates_staking_interface_at_block(
    state: &AppState,
    account_id: &str,
    pool_id: &str,
    block_height: u64,
) -> Result<bool, SnapshotError> {
    if !is_valid_account(pool_id) {
        return Ok(false);
    }

    validate_staking_pool_at_block(&state.archival_network, account_id, pool_id, block_height)
        .await
        .map_err(|error| {
            SnapshotError::message(format!(
                "staking interface validation failed for {pool_id} at {block_height}: {error}"
            ))
        })
}

async fn discover_current_assets(
    state: &AppState,
    account_id: &str,
    anchor_height: u64,
    multi_token_contracts: &BTreeSet<String>,
) -> Result<CurrentAssetDiscovery, SnapshotError> {
    let fastnear = state
        .http_client
        .get(format!(
            "https://api.fastnear.com/v1/account/{account_id}/full"
        ))
        .header(
            "Authorization",
            format!("Bearer {}", state.env_vars.fastnear_api_key),
        )
        .send()
        .await
        .map_err(|error| SnapshotError::message(format!("FT discovery failed: {error}")))?
        .error_for_status()
        .map_err(|error| SnapshotError::message(format!("FT discovery failed: {error}")))?
        .json::<StrictFastNearAccount>()
        .await
        .map_err(|error| SnapshotError::message(format!("invalid FT inventory: {error}")))?;

    let mut assets = BTreeSet::from([SnapshotAsset::near()]);
    for token in fastnear.tokens {
        let balance = u128::from_str(&token.balance).map_err(|error| {
            SnapshotError::message(format!(
                "invalid FT balance for {}: {error}",
                token.contract_id
            ))
        })?;
        if balance > 0 {
            assets.insert(SnapshotAsset::fungible(token.contract_id));
        }
    }

    for contract_id in multi_token_contracts {
        let contract = near_api::AccountId::from_str(contract_id)
            .map_err(|error| SnapshotError::message(error.to_string()))?;
        let owned: near_api::Data<Vec<OwnedMultiToken>> = Contract(contract)
            .call_function(
                "mt_tokens_for_owner",
                serde_json::json!({ "account_id": account_id }),
            )
            .read_only()
            .at(Reference::AtBlock(anchor_height))
            .fetch_from(&state.archival_network)
            .await
            .map_err(|error| {
                SnapshotError::message(format!(
                    "multi-token discovery failed for {contract_id}: {error}"
                ))
            })?;
        for token in owned.data {
            let asset_id = canonical_multi_token_asset_id(contract_id, &token.token_id)?;
            assets.insert(SnapshotAsset::multi_token(asset_id));
        }
    }

    let fastnear_staking = state
        .http_client
        .get(format!(
            "https://api.fastnear.com/v1/account/{account_id}/staking"
        ))
        .header(
            "Authorization",
            format!("Bearer {}", state.env_vars.fastnear_api_key),
        )
        .send();
    let treasury_staking = state
        .http_client
        .get(format!(
            "https://staking-pools-api.neartreasury.com/v1/account/{account_id}/staking"
        ))
        .send();
    let (fastnear_staking, treasury_staking) = tokio::join!(fastnear_staking, treasury_staking);
    let mut staking_candidates = BTreeSet::new();
    for response in [fastnear_staking, treasury_staking] {
        let response = response
            .map_err(|error| SnapshotError::message(format!("staking discovery failed: {error}")))?
            .error_for_status()
            .map_err(|error| SnapshotError::message(format!("staking discovery failed: {error}")))?
            .json::<StrictStakingResponse>()
            .await
            .map_err(|error| {
                SnapshotError::message(format!("invalid staking inventory: {error}"))
            })?;
        for pool in response.pools {
            if !is_valid_account(&pool.pool_id) {
                return Err(SnapshotError::message(format!(
                    "staking inventory returned invalid pool id {}",
                    pool.pool_id
                )));
            }
            staking_candidates.insert(pool.pool_id);
        }
    }

    Ok(CurrentAssetDiscovery {
        assets,
        staking_candidates,
    })
}

async fn discover_complete_inventory(
    state: &AppState,
    account_id: &str,
    anchor_height: u64,
) -> Result<BTreeSet<SnapshotAsset>, SnapshotError> {
    let historical_assets = load_historical_assets(&state.db_pool, account_id).await?;
    let mut multi_token_contracts =
        load_historical_multi_token_contracts(&state.db_pool, account_id)
            .await?
            .into_iter()
            .collect::<BTreeSet<_>>();
    multi_token_contracts.extend(
        SUPPORTED_MULTI_TOKEN_CONTRACTS
            .iter()
            .map(|contract| (*contract).to_string()),
    );
    for historical in &historical_assets {
        if historical.token_standard == "nep245"
            && let Some(contract) = multi_token_contract_from_asset_id(&historical.token_id)
        {
            multi_token_contracts.insert(contract.to_string());
        }
    }

    let current =
        discover_current_assets(state, account_id, anchor_height, &multi_token_contracts).await?;
    let mut assets = current.assets;
    assets.insert(SnapshotAsset::near());

    for historical in historical_assets {
        assets.insert(historical.into_asset().map_err(SnapshotError::message)?);
    }

    let mut staking_validation_blocks = BTreeMap::<String, u64>::new();
    for event in load_staking_event_coordinates(&state.db_pool, account_id, None).await? {
        let Some(pool_id) = event.contract_account_id.filter(|id| is_valid_account(id)) else {
            continue;
        };
        let block_height = u64::try_from(event.block_height).map_err(|_| {
            SnapshotError::message(format!(
                "negative staking event block height {} for {pool_id}",
                event.block_height
            ))
        })?;
        // A successful historical staking call is a stronger validation
        // coordinate than today's contract state and keeps exited pools.
        staking_validation_blocks
            .entry(pool_id)
            .or_insert(block_height);
    }

    let mut staking_candidates = current.staking_candidates;
    staking_candidates.extend(staking_validation_blocks.keys().cloned());
    for pool_id in staking_candidates {
        let validation_height = staking_validation_blocks
            .get(&pool_id)
            .copied()
            .unwrap_or(anchor_height);
        if validates_staking_interface_at_block(state, account_id, &pool_id, validation_height)
            .await?
        {
            assets.insert(SnapshotAsset::staking(pool_id));
        }
    }

    Ok(assets)
}

async fn validate_inventory_at_anchor(
    state: &AppState,
    account_id: &str,
    inventory: &BTreeSet<SnapshotAsset>,
    height: u64,
) -> Result<(), SnapshotError> {
    let mut results = stream::iter(inventory.iter().cloned().map(|asset| {
        let account_id = account_id.to_string();
        async move {
            get_public_balance_at_block(
                &state.db_pool,
                &state.archival_network,
                &account_id,
                &asset.id,
                height,
            )
            .await
            .map_err(|error| {
                SnapshotError::message(format!(
                    "anchor read failed for {} at {}: {}",
                    asset.id, height, error
                ))
            })
        }
    }))
    .buffer_unordered(RPC_WORKERS);
    while let Some(result) = results.next().await {
        result?;
    }
    Ok(())
}

async fn resolve_checkpoints(
    state: &AppState,
    grid: &[DateTime<Utc>],
) -> Result<Vec<ResolvedBlock>, SnapshotError> {
    let network = state.archival_network.clone();
    let cache = state.cache.clone();
    let mut resolved = stream::iter(grid.iter().copied().map(|boundary| {
        let network = network.clone();
        let cache = cache.clone();
        async move {
            resolve_block_at_or_before(&cache, &network, boundary)
                .await
                .map_err(|error| {
                    SnapshotError::message(format!(
                        "could not resolve checkpoint {boundary}: {error}"
                    ))
                })
        }
    }))
    .buffer_unordered(RPC_WORKERS)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    resolved.sort_by_key(|block| (block.block_height, block.block_time));
    resolved.dedup_by_key(|block| block.block_height);
    Ok(resolved)
}

async fn fetch_balance(
    state: &AppState,
    account_id: &str,
    asset: &SnapshotAsset,
    block_height: i64,
) -> Result<BigDecimal, SnapshotError> {
    let height = u64::try_from(block_height)
        .map_err(|_| SnapshotError::message(format!("negative block height {block_height}")))?;
    let balance = get_public_balance_at_block(
        &state.db_pool,
        &state.archival_network,
        account_id,
        &asset.id,
        height,
    )
    .await
    .map_err(|error| {
        SnapshotError::message(format!(
            "balance read failed for {} at {}: {}",
            asset.id, block_height, error
        ))
    })?;
    if balance.is_negative() {
        return Err(SnapshotError::message(format!(
            "authoritative reader returned negative balance for {} at {}",
            asset.id, block_height
        )));
    }
    Ok(balance)
}

async fn fetch_checkpoint_balances(
    state: &AppState,
    account_id: &str,
    inventory: &BTreeSet<SnapshotAsset>,
    checkpoints: &[ResolvedBlock],
) -> Result<BTreeMap<SnapshotAsset, Vec<AuthoritativePoint>>, SnapshotError> {
    // Own the Cartesian work list before constructing async tasks. Keeping
    // the nested slice iterators in the stream made this future lifetime-
    // dependent and therefore unusable by Send job executors such as Apalis.
    let work = inventory
        .iter()
        .cloned()
        .flat_map(|asset| {
            checkpoints
                .iter()
                .cloned()
                .map(move |checkpoint| (asset.clone(), checkpoint))
        })
        .collect::<Vec<_>>();
    let mut results = stream::iter(work.into_iter().map(|(asset, checkpoint)| {
        let account_id = account_id.to_string();
        async move {
            let balance =
                fetch_balance(state, &account_id, &asset, checkpoint.block_height).await?;
            Ok::<_, SnapshotError>((
                asset,
                AuthoritativePoint {
                    block_height: checkpoint.block_height,
                    block_time: checkpoint.block_time,
                    balance,
                },
            ))
        }
    }))
    .buffer_unordered(RPC_WORKERS);

    let mut by_asset: BTreeMap<SnapshotAsset, Vec<AuthoritativePoint>> = BTreeMap::new();
    while let Some(result) = results.next().await {
        let (asset, point) = result?;
        by_asset.entry(asset).or_default().push(point);
    }
    for points in by_asset.values_mut() {
        points.sort_by_key(|point| (point.block_height, point.block_time));
        points.dedup_by_key(|point| point.block_height);
    }
    Ok(by_asset)
}

/// Replay one anchor-bounded event segment. A segment is accepted only when
/// its exact decimal delta reaches the authoritative closing balance and no
/// intermediate balance becomes negative.
pub(crate) fn replay_segment(
    starting_balance: &BigDecimal,
    ending_balance: &BigDecimal,
    decimals: i32,
    events: &[EventDelta],
) -> Option<Vec<AuthoritativePoint>> {
    let mut scale_text = String::from("1");
    for _ in 0..decimals.max(0) {
        scale_text.push('0');
    }
    let scale = BigDecimal::from_str(&scale_text).ok()?;
    let mut raw_balance = starting_balance * &scale;
    let expected_raw_balance = ending_balance * &scale;
    let mut points = Vec::with_capacity(events.len());
    for event in events {
        raw_balance += &event.delta_raw;
        if raw_balance.is_negative() {
            return None;
        }
        points.push(AuthoritativePoint {
            block_height: event.block_height,
            block_time: event.block_time,
            balance: &raw_balance / &scale,
        });
    }
    (raw_balance == expected_raw_balance).then_some(points)
}

async fn materialize_event_points(
    state: &AppState,
    account_id: &str,
    asset: &SnapshotAsset,
    decimals: i32,
    events: &[EventDelta],
    checkpoints: &[AuthoritativePoint],
) -> Result<(Vec<AuthoritativePoint>, u64), SnapshotError> {
    if events.is_empty() {
        return Ok((Vec::new(), 0));
    }

    let mut points = Vec::new();
    let mut exact = BTreeMap::<i64, DateTime<Utc>>::new();
    let mut repaired = 0;
    let checkpoint_by_height: HashMap<i64, &AuthoritativePoint> = checkpoints
        .iter()
        .map(|checkpoint| (checkpoint.block_height, checkpoint))
        .collect();

    for event in events {
        if let Some(checkpoint) = checkpoint_by_height.get(&event.block_height) {
            points.push((*checkpoint).clone());
        }
    }

    let Some(first) = checkpoints.first() else {
        return Err(SnapshotError::message("checkpoint grid is empty"));
    };
    let last = checkpoints.last().expect("checked non-empty");
    for event in events {
        if event.block_height < first.block_height || event.block_height > last.block_height {
            exact.insert(event.block_height, event.block_time);
        }
    }

    for anchors in checkpoints.windows(2) {
        let start = &anchors[0];
        let end = &anchors[1];
        let segment = events
            .iter()
            .filter(|event| {
                event.block_height > start.block_height && event.block_height <= end.block_height
            })
            .cloned()
            .collect::<Vec<_>>();
        if segment.is_empty() {
            continue;
        }
        if let Some(replayed) = replay_segment(&start.balance, &end.balance, decimals, &segment) {
            points.extend(replayed);
        } else {
            repaired += 1;
            for event in segment {
                exact.insert(event.block_height, event.block_time);
            }
        }
    }

    let exact_work = exact.into_iter().collect::<Vec<_>>();
    let mut exact_reads = stream::iter(exact_work.into_iter().map(|(block_height, block_time)| {
        let account_id = account_id.to_string();
        let asset = asset.clone();
        async move {
            Ok::<_, SnapshotError>(AuthoritativePoint {
                block_height,
                block_time,
                balance: fetch_balance(state, &account_id, &asset, block_height).await?,
            })
        }
    }))
    .buffer_unordered(RPC_WORKERS);
    while let Some(point) = exact_reads.next().await {
        points.push(point?);
    }
    points.sort_by_key(|point| (point.block_height, point.block_time));
    points.dedup_by_key(|point| point.block_height);
    Ok((points, repaired))
}

fn insert_point(
    rows: &mut BTreeMap<(String, i64), PublicBalanceSnapshotRow>,
    account_id: &str,
    asset: &SnapshotAsset,
    point: AuthoritativePoint,
) -> Result<(), SnapshotError> {
    if point.balance.is_negative() {
        return Err(SnapshotError::message(format!(
            "negative balance for {} at {}",
            asset.id, point.block_height
        )));
    }
    rows.insert(
        (asset.id.clone(), point.block_height),
        PublicBalanceSnapshotRow {
            dao_id: account_id.to_string(),
            asset: asset.id.clone(),
            block_height: point.block_height,
            block_time: point.block_time,
            balance: point.balance,
            usd_value: None,
        },
    );
    Ok(())
}

async fn add_exact_coordinates(
    state: &AppState,
    account_id: &str,
    asset: &SnapshotAsset,
    coordinates: impl IntoIterator<Item = (i64, DateTime<Utc>)>,
    rows: &mut BTreeMap<(String, i64), PublicBalanceSnapshotRow>,
) -> Result<(), SnapshotError> {
    let mut unique = BTreeMap::new();
    for (height, at) in coordinates {
        unique.insert(height, at);
    }
    let work = unique.into_iter().collect::<Vec<_>>();
    let mut fetched = stream::iter(work.into_iter().map(|(block_height, block_time)| {
        let account_id = account_id.to_string();
        let asset = asset.clone();
        async move {
            let balance = fetch_balance(state, &account_id, &asset, block_height).await?;
            Ok::<_, SnapshotError>(AuthoritativePoint {
                block_height,
                block_time,
                balance,
            })
        }
    }))
    .buffer_unordered(RPC_WORKERS);
    while let Some(point) = fetched.next().await {
        insert_point(rows, account_id, asset, point?)?;
    }
    Ok(())
}

async fn attach_usd_values(
    state: &AppState,
    rows: &mut BTreeMap<(String, i64), PublicBalanceSnapshotRow>,
) {
    let mut times_by_asset: BTreeMap<String, Vec<DateTime<Utc>>> = BTreeMap::new();
    for row in rows.values() {
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

        for row in rows.values_mut().filter(|row| row.asset == asset) {
            if row.balance.is_zero() {
                row.usd_value = Some(BigDecimal::zero());
                continue;
            }
            let price = grid
                .get(&(asset.clone(), row.block_time))
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
}

pub async fn repair_missing_public_snapshot_usd_values(
    state: &AppState,
) -> Result<u64, SnapshotError> {
    let missing = load_missing_usd_rows(&state.db_pool, 1_000).await?;
    let mut rows = missing
        .into_iter()
        .map(|row| {
            (
                (format!("{}\0{}", row.dao_id, row.asset), row.block_height),
                row,
            )
        })
        .collect::<BTreeMap<_, _>>();
    attach_usd_values(state, &mut rows).await;
    update_snapshot_usd_values(&state.db_pool, &rows.into_values().collect::<Vec<_>>())
        .await
        .map_err(Into::into)
}

async fn build_complete_dataset(
    state: &AppState,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
    checkpoint_grid: &[DateTime<Utc>],
) -> Result<(Vec<PublicBalanceSnapshotRow>, u64, i64, bool), SnapshotError> {
    // Capture one finalized anchor before any provider discovery, then verify
    // every discovered candidate against that exact common block.
    let anchor = Chain::block()
        .at(Reference::Final)
        .fetch_from(&state.archival_network)
        .await
        .map_err(|error| SnapshotError::message(format!("final block fetch failed: {error}")))?;
    let inventory = discover_complete_inventory(state, account_id, anchor.header.height).await?;
    validate_inventory_at_anchor(state, account_id, &inventory, anchor.header.height).await?;
    let checkpoints = resolve_checkpoints(state, checkpoint_grid).await?;
    if checkpoints.is_empty() {
        return Err(SnapshotError::message("resolved checkpoint grid is empty"));
    }
    let existing = if recompute_from.is_some() {
        load_complete_snapshot_dataset(&state.db_pool, account_id).await?
    } else {
        Vec::new()
    };
    let existing_assets = existing
        .iter()
        .map(|row| row.asset.as_str())
        .collect::<BTreeSet<_>>();
    let inventory_ids = inventory
        .iter()
        .map(|asset| asset.id.as_str())
        .collect::<BTreeSet<_>>();
    let is_backdated_correction = recompute_from
        .is_some_and(|boundary| existing.iter().any(|row| row.block_time >= boundary));
    let may_reuse = recompute_from.is_some()
        && !existing.is_empty()
        && existing_assets == inventory_ids
        && !is_backdated_correction;
    if is_backdated_correction {
        tracing::info!(
            account_id,
            recompute_from = ?recompute_from,
            "backdated public balance change requires a full snapshot rebuild"
        );
    }
    let existing_by_key = existing
        .iter()
        .map(|row| ((row.asset.clone(), row.block_height), row.clone()))
        .collect::<BTreeMap<_, _>>();
    let reuse_before = recompute_from.filter(|_| may_reuse);
    let replay_after_block = reuse_before.and_then(|boundary| {
        checkpoints
            .iter()
            .filter(|checkpoint| checkpoint.block_time < boundary)
            .map(|checkpoint| checkpoint.block_height)
            .max()
    });

    let mut balances: BTreeMap<SnapshotAsset, Vec<AuthoritativePoint>> = BTreeMap::new();
    let mut missing: BTreeMap<SnapshotAsset, Vec<ResolvedBlock>> = BTreeMap::new();
    for asset in &inventory {
        for checkpoint in &checkpoints {
            if may_reuse {
                if let Some(row) = existing_by_key.get(&(asset.id.clone(), checkpoint.block_height))
                {
                    if reuse_before.is_some_and(|boundary| row.block_time < boundary) {
                        balances
                            .entry(asset.clone())
                            .or_default()
                            .push(AuthoritativePoint {
                                block_height: row.block_height,
                                block_time: row.block_time,
                                balance: row.balance.clone(),
                            });
                        continue;
                    }
                }
            }
            missing
                .entry(asset.clone())
                .or_default()
                .push(checkpoint.clone());
        }
    }
    for (asset, asset_checkpoints) in missing {
        let fetched = fetch_checkpoint_balances(
            state,
            account_id,
            &BTreeSet::from([asset.clone()]),
            &asset_checkpoints,
        )
        .await?;
        balances
            .entry(asset.clone())
            .or_default()
            .extend(fetched.get(&asset).cloned().unwrap_or_default());
    }
    for points in balances.values_mut() {
        points.sort_by_key(|point| (point.block_height, point.block_time));
        points.dedup_by_key(|point| point.block_height);
    }

    let mut rows = BTreeMap::new();
    if may_reuse {
        let boundary = recompute_from.expect("reuse requires a recompute boundary");
        for row in existing.into_iter().filter(|row| row.block_time < boundary) {
            rows.insert((row.asset.clone(), row.block_height), row);
        }
    }
    for (asset, points) in &balances {
        if points.len() != checkpoints.len() {
            return Err(SnapshotError::message(format!(
                "incomplete checkpoint grid for {}: {} of {}",
                asset.id,
                points.len(),
                checkpoints.len()
            )));
        }
        for point in points.iter().cloned() {
            insert_point(&mut rows, account_id, asset, point)?;
        }
    }

    let legs = load_real_silver_legs(&state.db_pool, account_id, replay_after_block).await?;
    let deltas = group_event_deltas(legs).map_err(SnapshotError::message)?;
    let mut repaired = 0;
    for (asset, ledger) in deltas {
        let asset_checkpoints = balances.get(&asset).ok_or_else(|| {
            SnapshotError::message(format!("asset {} missing checkpoint balances", asset.id))
        })?;
        let (points, repairs) = materialize_event_points(
            state,
            account_id,
            &asset,
            ledger.decimals,
            &ledger.events,
            asset_checkpoints,
        )
        .await?;
        repaired += repairs;
        for point in points {
            insert_point(&mut rows, account_id, &asset, point)?;
        }
    }

    let native = SnapshotAsset::near();
    let native_coordinates =
        load_native_event_coordinates(&state.db_pool, account_id, reuse_before)
            .await?
            .into_iter()
            .map(|event| (event.block_height, event.block_time));
    add_exact_coordinates(state, account_id, &native, native_coordinates, &mut rows).await?;

    let staking_events =
        load_staking_event_coordinates(&state.db_pool, account_id, reuse_before).await?;
    let validated_staking_pools = inventory
        .iter()
        .filter_map(|asset| asset.id.strip_prefix("staking:"))
        .collect::<BTreeSet<_>>();
    let mut staking_coordinates: BTreeMap<String, Vec<(i64, DateTime<Utc>)>> = BTreeMap::new();
    for event in staking_events {
        let Some(pool) = event
            .contract_account_id
            .filter(|pool| is_valid_account(pool))
        else {
            continue;
        };
        if !validated_staking_pools.contains(pool.as_str()) {
            continue;
        }
        staking_coordinates
            .entry(pool)
            .or_default()
            .push((event.block_height, event.block_time));
    }
    for (pool, coordinates) in staking_coordinates {
        add_exact_coordinates(
            state,
            account_id,
            &SnapshotAsset::staking(pool),
            coordinates,
            &mut rows,
        )
        .await?;
    }

    let final_inventory =
        discover_complete_inventory(state, account_id, anchor.header.height).await?;
    if final_inventory != inventory {
        return Err(SnapshotError::message(
            "asset inventory changed while snapshot dataset was being built",
        ));
    }

    attach_usd_values(state, &mut rows).await;
    Ok((
        rows.into_values().collect(),
        repaired,
        anchor.header.height as i64,
        may_reuse,
    ))
}

async fn project_one(
    state: &AppState,
    account_id: &str,
    generation: i64,
    recompute_from: Option<DateTime<Utc>>,
    required_latest_refresh_at: DateTime<Utc>,
    checkpoint_grid: Vec<DateTime<Utc>>,
) -> Result<Option<(u64, u64)>, SnapshotError> {
    let (mut rows, mut repaired, mut anchor_height, used_incremental) =
        build_complete_dataset(state, account_id, recompute_from, &checkpoint_grid).await?;
    if used_incremental && repaired > 0 {
        tracing::warn!(
            account_id,
            repaired_segments = repaired,
            "incremental reconciliation failed; rebuilding the complete snapshot dataset"
        );
        let rebuilt = build_complete_dataset(state, account_id, None, &checkpoint_grid).await?;
        rows = rebuilt.0;
        repaired = rebuilt.1;
        anchor_height = rebuilt.2;
    }
    if fixed_checkpoint_grid(Utc::now()) != checkpoint_grid {
        return Err(SnapshotError::message(
            "checkpoint boundary changed while snapshot dataset was being built",
        ));
    }
    let written = publish_complete_snapshot_generation(
        &state.db_pool,
        account_id,
        generation,
        required_latest_refresh_at,
        anchor_height.saturating_sub(SOURCE_REFRESH_BLOCK_LAG_ALLOWANCE),
        &rows,
    )
    .await?;
    Ok(written.map(|written| (written, repaired)))
}

/// Execute one durable per-DAO Apalis payload. The cursor is re-read so an
/// obsolete payload is a cheap no-op; the guarded publisher performs the same
/// generation check again after all external calls.
pub async fn project_public_balance_snapshot_generation(
    state: &Arc<AppState>,
    account_id: &str,
    generation: i64,
) -> Result<Option<(u64, u64)>, SnapshotError> {
    let Some(cursor) = super::repository::load_snapshot_cursor(&state.db_pool, account_id).await?
    else {
        return Ok(None);
    };
    if cursor.snapshot_dirty_generation != generation
        || cursor.snapshot_applied_generation >= generation
    {
        return Ok(None);
    }
    let checkpoint_grid = fixed_checkpoint_grid(Utc::now());
    let required_latest_refresh_at = Utc::now() - Duration::minutes(SOURCE_REFRESH_MAX_AGE_MINUTES);
    project_one(
        state.as_ref(),
        account_id,
        generation,
        cursor.snapshot_recompute_from,
        required_latest_refresh_at,
        checkpoint_grid,
    )
    .await
}

/// Apalis-compatible sweep entry point. The daily dirty mark supplies the
/// checkpoint schedule; the cursor scan also recovers lost post-commit nudges
/// and retries failed/redelivered jobs durably.
pub async fn project_dirty_public_balance_snapshots(
    state: &Arc<AppState>,
) -> Result<SnapshotCycleStats, SnapshotError> {
    mark_due_checkpoint_generations(&state.db_pool).await?;
    let cursors = load_dirty_snapshot_cursors(&state.db_pool).await?;
    let accounts_seen = cursors.len();
    let state = Arc::clone(state);
    let checkpoint_grid = fixed_checkpoint_grid(Utc::now());
    // A latest drain within the provider-lag window is required again under
    // the publication lock. This prevents seeded backfills from racing the
    // first post-deploy FT/MT/receipt refresh.
    let required_latest_refresh_at = Utc::now() - Duration::minutes(SOURCE_REFRESH_MAX_AGE_MINUTES);
    let mut work = stream::iter(cursors.into_iter().map(|cursor| {
        let state = Arc::clone(&state);
        let checkpoint_grid = checkpoint_grid.clone();
        async move {
            let account_id = cursor.account_id;
            let result = project_one(
                state.as_ref(),
                &account_id,
                cursor.snapshot_dirty_generation,
                cursor.snapshot_recompute_from,
                required_latest_refresh_at,
                checkpoint_grid,
            )
            .await;
            (account_id, result)
        }
    }))
    .buffer_unordered(ACCOUNT_WORKERS);

    let mut stats = SnapshotCycleStats {
        accounts_seen,
        ..SnapshotCycleStats::default()
    };
    while let Some((account_id, result)) = work.next().await {
        match result {
            Ok(Some((rows, repaired))) => {
                stats.accounts_applied += 1;
                stats.rows_written += rows;
                stats.replay_segments_repaired += repaired;
            }
            Ok(None) => stats.accounts_skipped += 1,
            Err(error) => {
                stats.accounts_failed += 1;
                tracing::warn!(
                    account_id,
                    error = %error,
                    "public balance snapshot projection failed"
                );
            }
        }
    }
    stats.usd_values_repaired = repair_missing_public_snapshot_usd_values(state.as_ref()).await?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(height: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(height, 0).unwrap()
    }

    #[test]
    fn replay_accepts_matching_anchors() {
        let events = vec![
            EventDelta {
                block_height: 2,
                block_time: at(2),
                delta_raw: BigDecimal::from(5),
            },
            EventDelta {
                block_height: 3,
                block_time: at(3),
                delta_raw: BigDecimal::from(-2),
            },
        ];
        let result = replay_segment(&BigDecimal::from(10), &BigDecimal::from(13), 0, &events)
            .expect("segment reconciles");
        assert_eq!(result[0].balance, BigDecimal::from(15));
        assert_eq!(result[1].balance, BigDecimal::from(13));
    }

    #[test]
    fn replay_rejects_mismatch_or_negative_intermediate() {
        let mismatch = [EventDelta {
            block_height: 2,
            block_time: at(2),
            delta_raw: BigDecimal::from(1),
        }];
        assert!(
            replay_segment(&BigDecimal::from(10), &BigDecimal::from(12), 0, &mismatch).is_none()
        );

        let negative = [EventDelta {
            block_height: 2,
            block_time: at(2),
            delta_raw: BigDecimal::from(-11),
        }];
        assert!(
            replay_segment(&BigDecimal::from(10), &BigDecimal::from(0), 0, &negative).is_none()
        );
    }

    #[test]
    fn canonicalizes_owner_multi_token_inventory_for_each_contract() {
        assert_eq!(
            canonical_multi_token_asset_id("intents.near", "nep141:wrap.near").unwrap(),
            "intents.near:nep141:wrap.near"
        );
        assert_eq!(
            canonical_multi_token_asset_id("intents.near", "intents.near:nep141:wrap.near")
                .unwrap(),
            "intents.near:nep141:wrap.near"
        );
        assert_eq!(
            canonical_multi_token_asset_id("collectibles.near", "collection:edition:token:7")
                .unwrap(),
            "nep245:collectibles.near:collection:edition:token:7"
        );
        assert_eq!(
            canonical_multi_token_asset_id(
                "collectibles.near",
                "collectibles.near:collection:token:7"
            )
            .unwrap(),
            "nep245:collectibles.near:collection:token:7"
        );
        assert_eq!(
            canonical_multi_token_asset_id(
                "collectibles.near",
                "nep245:collectibles.near:collection:token:7"
            )
            .unwrap(),
            "nep245:collectibles.near:collection:token:7"
        );
        assert!(canonical_multi_token_asset_id("not an account", "token").is_err());
        assert!(canonical_multi_token_asset_id("collectibles.near", "").is_err());
    }

    #[test]
    fn extracts_observed_multi_token_contracts_from_canonical_assets() {
        assert_eq!(
            multi_token_contract_from_asset_id(
                "nep245:collectibles.near:collection:edition:token:7"
            ),
            Some("collectibles.near")
        );
        assert_eq!(
            multi_token_contract_from_asset_id("intents.near:nep141:wrap.near"),
            Some("intents.near")
        );
        assert_eq!(multi_token_contract_from_asset_id("wrap.near"), None);
        assert_eq!(multi_token_contract_from_asset_id("nep245::token"), None);
    }

    #[test]
    fn snapshots_module_has_no_legacy_table_reference() {
        let sources = [
            include_str!("mod.rs"),
            include_str!("block_resolver.rs"),
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
}

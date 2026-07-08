use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Arc,
};
use tokio::{sync::Semaphore, task::JoinSet};

use bigdecimal::BigDecimal;
use chrono::{NaiveDate, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::{
    AppState,
    handlers::user::assets::{SimplifiedToken, compute_user_assets},
};

const TOP_TOKENS_LIMIT: usize = 20;
const REFRESH_CONCURRENCY: usize = 10;
const REFRESH_LOG_INTERVAL: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicDashboardToken {
    pub rank: i32,
    pub token_id: String,
    pub symbol: String,
    pub name: String,
    pub icon: Option<String>,
    pub decimals: u8,
    pub total_amount_raw: String,
    pub total_usd: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicDashboardSnapshot {
    pub snapshot_date: String,
    pub dao_count: i32,
    pub total_aum_usd: String,
    pub top_tokens: Vec<PublicDashboardToken>,
}

#[derive(Clone, Debug, PartialEq)]
struct AggregatedToken {
    /// Unified grouping key (e.g. "near", "usdc") — matches SimplifiedToken::id.
    token_id: String,
    /// Actual contract / defuse asset ID used for metadata lookup (e.g. "wrap.near",
    /// "nep141:usdc.tether-token.near"). None for native NEAR.
    contract_id: Option<String>,
    symbol: String,
    name: String,
    icon: Option<String>,
    decimals: u8,
    total_amount_raw: BigDecimal,
    price_usd: BigDecimal,
    total_usd: BigDecimal,
}

#[derive(Clone, Debug, PartialEq)]
struct StoredDailyBalance {
    dao_id: String,
    is_trezu: bool,
    token: AggregatedToken,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RefreshSummary {
    snapshot_date: NaiveDate,
    dao_count: i32,
    trezu_dao_count: i32,
    failed_dao_count: i32,
    balance_rows: usize,
}

#[derive(FromRow)]
struct RunRow {
    snapshot_date: NaiveDate,
    dao_count: i32,
}

#[derive(FromRow)]
struct BalanceRow {
    token_id: String,
    contract_id: Option<String>,
    total_amount_raw: BigDecimal,
    price_usd: BigDecimal,
    total_usd: BigDecimal,
}

fn decimal_to_string(value: &BigDecimal) -> String {
    let raw = value.to_string();
    let plain = scientific_to_plain_string(&raw);

    if !plain.contains('.') {
        return plain;
    }

    let trimmed = plain.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-0" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn scientific_to_plain_string(raw: &str) -> String {
    let Some((mantissa, exponent)) = raw.split_once(['e', 'E']) else {
        return raw.to_string();
    };

    let exponent: i64 = exponent.parse().unwrap_or(0);
    let negative = mantissa.starts_with('-');
    let unsigned = mantissa.strip_prefix('-').unwrap_or(mantissa);
    let (integer, fractional) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let digits = format!("{}{}", integer, fractional);
    let decimal_pos = integer.len() as i64;
    let new_decimal_pos = decimal_pos + exponent;

    let mut result = if new_decimal_pos <= 0 {
        format!("0.{}{}", "0".repeat((-new_decimal_pos) as usize), digits)
    } else if new_decimal_pos as usize >= digits.len() {
        format!(
            "{}{}",
            digits,
            "0".repeat(new_decimal_pos as usize - digits.len())
        )
    } else {
        let split = new_decimal_pos as usize;
        format!("{}.{}", &digits[..split], &digits[split..])
    };

    if negative && result != "0" {
        result.insert(0, '-');
    }

    result
}

fn decimal_divisor(decimals: u8) -> BigDecimal {
    let divisor = format!("1{}", "0".repeat(decimals as usize));
    BigDecimal::from_str(&divisor).expect("decimal divisor should parse")
}

fn asset_raw_amount(asset: &SimplifiedToken) -> BigDecimal {
    BigDecimal::from_str(&asset.balance.total_raw().0.to_string())
        .expect("raw amount should parse as BigDecimal")
}

fn asset_price_usd(asset: &SimplifiedToken) -> BigDecimal {
    BigDecimal::from_str(&asset.price).unwrap_or_else(|_| BigDecimal::from(0))
}

fn asset_usd_value(asset: &SimplifiedToken) -> BigDecimal {
    let raw_amount = asset_raw_amount(asset);
    if raw_amount == 0 {
        return BigDecimal::from(0);
    }

    let divisor = decimal_divisor(asset.decimals);
    let price = asset_price_usd(asset);

    (raw_amount / divisor) * price
}

/// Returns the contract ID to store for a token:
///
/// - Native / lockup / staked (no contract) → `"near"`
/// - Intents token                           → `"intents.near:{raw_contract_id}"`
/// - FT token                                → bare contract ID as-is
fn normalize_contract_id(token: &SimplifiedToken) -> Option<String> {
    use crate::handlers::user::assets::TokenResidency;
    match &token.contract_id {
        None => Some("near".to_string()),
        Some(cid) => match &token.residency {
            TokenResidency::Intents => Some(format!("intents.near:{}", cid)),
            _ => Some(cid.clone()),
        },
    }
}

fn aggregate_tokens(tokens: &[SimplifiedToken]) -> Vec<AggregatedToken> {
    let mut by_token: HashMap<String, AggregatedToken> = HashMap::new();

    for token in tokens {
        let raw_amount = asset_raw_amount(token);
        if raw_amount == 0 {
            continue;
        }

        let usd_value = asset_usd_value(token);
        let price_usd = asset_price_usd(token);
        let contract_id = normalize_contract_id(token);
        let entry = by_token
            .entry(token.id.clone())
            .or_insert_with(|| AggregatedToken {
                token_id: token.id.clone(),
                contract_id: contract_id.clone(),
                symbol: token.symbol.clone(),
                name: token.name.clone(),
                icon: token.icon.clone(),
                decimals: token.decimals,
                total_amount_raw: BigDecimal::from(0),
                price_usd: price_usd.clone(),
                total_usd: BigDecimal::from(0),
            });

        // Keep the first non-None normalized contract_id seen for this unified token.
        if entry.contract_id.is_none() {
            entry.contract_id = contract_id;
        }

        entry.total_amount_raw += raw_amount;
        entry.total_usd += usd_value;
        if entry.price_usd == 0 && price_usd != 0 {
            entry.price_usd = price_usd;
        }
    }

    let mut aggregated: Vec<AggregatedToken> = by_token.into_values().collect();
    aggregated.sort_by(|a, b| {
        b.total_usd
            .partial_cmp(&a.total_usd)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.token_id.cmp(&b.token_id))
    });
    aggregated
}

fn summarize_tokens(
    aggregated_tokens: Vec<AggregatedToken>,
) -> (BigDecimal, Vec<PublicDashboardToken>) {
    let total_aum_usd = aggregated_tokens
        .iter()
        .fold(BigDecimal::from(0), |acc, token| {
            acc + token.total_usd.clone()
        });

    let top_tokens = aggregated_tokens
        .into_iter()
        .take(TOP_TOKENS_LIMIT)
        .enumerate()
        .map(|(index, token)| PublicDashboardToken {
            rank: (index + 1) as i32,
            token_id: token.token_id,
            symbol: token.symbol,
            name: token.name,
            icon: token.icon,
            decimals: token.decimals,
            total_amount_raw: decimal_to_string(&token.total_amount_raw),
            total_usd: decimal_to_string(&token.total_usd),
        })
        .collect();

    (total_aum_usd, top_tokens)
}

fn aggregate_balance_rows(rows: &[BalanceRow]) -> Vec<AggregatedToken> {
    let mut by_token: HashMap<String, AggregatedToken> = HashMap::new();

    for row in rows {
        let entry = by_token
            .entry(row.token_id.clone())
            .or_insert_with(|| AggregatedToken {
                token_id: row.token_id.clone(),
                contract_id: row.contract_id.clone(),
                // Metadata is not stored; it will be enriched at request time.
                symbol: row.token_id.clone(),
                name: row.token_id.clone(),
                icon: None,
                decimals: 0,
                total_amount_raw: BigDecimal::from(0),
                price_usd: row.price_usd.clone(),
                total_usd: BigDecimal::from(0),
            });

        entry.total_amount_raw += row.total_amount_raw.clone();
        entry.total_usd += row.total_usd.clone();
        if entry.price_usd == 0 && row.price_usd != 0 {
            entry.price_usd = row.price_usd.clone();
        }
    }

    let mut aggregated: Vec<AggregatedToken> = by_token.into_values().collect();
    aggregated.sort_by(|a, b| {
        b.total_usd
            .partial_cmp(&a.total_usd)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.token_id.cmp(&b.token_id))
    });
    aggregated
}

/// All DAOs known to the system that have not failed syncing.
async fn list_all_dao_ids(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String,)>(
        r#"
        SELECT d.dao_id
        FROM daos d
        LEFT JOIN monitored_accounts ma ON ma.account_id = d.dao_id
        WHERE d.sync_failed = false
          AND COALESCE(ma.is_testing, false) = false
        ORDER BY d.dao_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(dao_id,)| dao_id).collect())
}

/// DAOs that are onboarded to Trezu (used to set the `is_trezu` flag).
async fn load_trezu_dao_set(pool: &PgPool) -> Result<HashSet<String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String,)>(
        r#"
        SELECT dao_id
        FROM onboarded_daos
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(dao_id,)| dao_id).collect())
}

#[cfg(test)]
async fn snapshot_exists_for_date(
    pool: &PgPool,
    snapshot_date: NaiveDate,
) -> Result<bool, sqlx::Error> {
    let (exists,) = sqlx::query_as::<_, (bool,)>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM public_dashboard_daily_runs
            WHERE snapshot_date = $1
        )
        "#,
    )
    .bind(snapshot_date)
    .fetch_one(pool)
    .await?;

    Ok(exists)
}

async fn store_daily_balance_snapshot(
    pool: &PgPool,
    snapshot_date: NaiveDate,
    dao_count: i32,
    trezu_dao_count: i32,
    failed_dao_count: i32,
    balances: &[StoredDailyBalance],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query!(
        r#"
        INSERT INTO public_dashboard_daily_runs (
            snapshot_date, dao_count, trezu_dao_count, failed_dao_count,
            computed_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (snapshot_date) DO UPDATE SET
            dao_count = EXCLUDED.dao_count,
            trezu_dao_count = EXCLUDED.trezu_dao_count,
            failed_dao_count = EXCLUDED.failed_dao_count,
            computed_at = NOW()
        "#,
        snapshot_date,
        dao_count,
        trezu_dao_count,
        failed_dao_count,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        r#"
        DELETE FROM public_dashboard_daily_balances
        WHERE snapshot_date = $1
        "#,
        snapshot_date,
    )
    .execute(&mut *tx)
    .await?;

    for balance in balances {
        sqlx::query!(
            r#"
            INSERT INTO public_dashboard_daily_balances (
                snapshot_date,
                dao_id,
                is_trezu,
                token_id,
                contract_id,
                total_amount_raw,
                price_usd,
                total_usd
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
            snapshot_date,
            &balance.dao_id,
            balance.is_trezu,
            &balance.token.token_id,
            balance.token.contract_id,
            &balance.token.total_amount_raw,
            &balance.token.price_usd,
            &balance.token.total_usd,
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn load_latest_public_dashboard_snapshot(
    state: &Arc<AppState>,
) -> Result<Option<PublicDashboardSnapshot>, sqlx::Error> {
    let run = sqlx::query_as::<_, RunRow>(
        r#"
        SELECT snapshot_date, dao_count
        FROM public_dashboard_daily_runs
        ORDER BY snapshot_date DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db_pool)
    .await?;

    let Some(run) = run else {
        return Ok(None);
    };

    // Aggregate per-token totals in the DB — returns one row per unique token
    // across all DAOs, already sorted by USD value descending. Much faster than
    // fetching every per-DAO row and aggregating in Rust.
    let balance_rows = sqlx::query_as::<_, BalanceRow>(
        r#"
        SELECT
            token_id,
            MIN(contract_id) FILTER (WHERE contract_id IS NOT NULL) AS contract_id,
            SUM(total_amount_raw) AS total_amount_raw,
            MAX(price_usd)       AS price_usd,
            SUM(total_usd)       AS total_usd
        FROM public_dashboard_daily_balances
        WHERE snapshot_date = $1
        GROUP BY token_id
        ORDER BY SUM(total_usd) DESC
        "#,
    )
    .bind(run.snapshot_date)
    .fetch_all(&state.db_pool)
    .await?;

    // Rows are already one-per-token from the GROUP BY.
    let mut aggregated_tokens = aggregate_balance_rows(&balance_rows);

    // Enrich with fresh metadata before summarizing.
    // Prefer contract_id for the lookup (e.g. "wrap.near", "nep141:usdc.tether-token.near")
    // so the metadata service can resolve it correctly; fall back to token_id otherwise.
    let lookup_ids: Vec<String> = aggregated_tokens
        .iter()
        .map(|t| t.contract_id.clone().unwrap_or_else(|| t.token_id.clone()))
        .collect();
    let metadata =
        crate::handlers::token::metadata::fetch_tokens_metadata_enriched(state, &lookup_ids, false)
            .await;

    // Build NEAR metadata once and reuse for all NEAR variants, mirroring assets.rs.
    let near_meta = {
        use crate::handlers::token::metadata::TokenMetadata;
        let m = metadata.get("near");
        TokenMetadata::create_near_metadata(
            m.and_then(|m| m.price),
            m.and_then(|m| m.price_updated_at.clone()),
        )
    };

    for token in &mut aggregated_tokens {
        let lookup_id = token.contract_id.as_deref().unwrap_or(&token.token_id);
        let meta = if matches!(lookup_id, "near" | "wrap.near" | "nep141:wrap.near") {
            &near_meta
        } else if let Some(m) = metadata.get(lookup_id) {
            m
        } else {
            continue;
        };
        token.symbol = meta.symbol.clone();
        token.name = meta.name.clone();
        token.icon = meta.icon.clone();
        token.decimals = meta.decimals;
    }

    let (total_aum_usd, top_tokens) = summarize_tokens(aggregated_tokens);

    Ok(Some(PublicDashboardSnapshot {
        snapshot_date: run.snapshot_date.to_string(),
        dao_count: run.dao_count,
        total_aum_usd: decimal_to_string(&total_aum_usd),
        top_tokens,
    }))
}

#[tracing::instrument(
    level = "info",
    skip_all,
    fields(job = "public_dashboard_refresh", snapshot_date = %snapshot_date)
)]
async fn refresh_public_dashboard_snapshot_for_date(
    state: &Arc<AppState>,
    snapshot_date: NaiveDate,
) -> Result<RefreshSummary, Box<dyn std::error::Error + Send + Sync>> {
    let dao_ids = list_all_dao_ids(&state.db_pool).await?;
    let trezu_set = load_trezu_dao_set(&state.db_pool)
        .await
        .unwrap_or_else(|err| {
            tracing::warn!("Failed to load Trezu DAO set: {}", err);
            HashSet::new()
        });

    let total_daos = dao_ids.len();
    tracing::info!(
        "Starting refresh for {} DAOs (concurrency={})",
        total_daos,
        REFRESH_CONCURRENCY
    );

    // Split parse errors out early so the hot loop only deals with valid IDs.
    let mut failed_dao_count = 0i32;
    let mut tasks: Vec<(AccountId, bool)> = Vec::with_capacity(total_daos);
    for dao_id in dao_ids {
        match dao_id.parse::<AccountId>() {
            Ok(account_id) => {
                let is_trezu = trezu_set.contains(account_id.as_str());
                tasks.push((account_id, is_trezu));
            }
            Err(err) => {
                failed_dao_count += 1;
                tracing::warn!("Skipping invalid DAO {}: {}", dao_id, err);
            }
        }
    }

    // Process all DAOs concurrently, bounded by REFRESH_CONCURRENCY.
    let semaphore = Arc::new(Semaphore::new(REFRESH_CONCURRENCY));
    let mut join_set = JoinSet::new();

    for (account_id, is_trezu) in tasks {
        let state = state.clone();
        let sem = semaphore.clone();
        join_set.spawn(async move {
            let _permit = sem
                .acquire_owned()
                .await
                .expect("semaphore should not close");
            // TODO: we need to decide whether confidential treasuries should be included in the public dashboard
            let result = compute_user_assets(&state, &account_id, false).await;
            (account_id, is_trezu, result)
        });
    }

    let mut successful_dao_count = 0i32;
    let mut completed: usize = 0;
    let mut balances = Vec::new();

    while let Some(join_result) = join_set.join_next().await {
        completed += 1;

        match join_result {
            Ok((account_id, is_trezu, Ok(tokens))) => {
                successful_dao_count += 1;
                for token in aggregate_tokens(&tokens) {
                    balances.push(StoredDailyBalance {
                        dao_id: account_id.to_string(),
                        is_trezu,
                        token,
                    });
                }
            }
            Ok((account_id, _is_trezu, Err((status, message)))) => {
                failed_dao_count += 1;
                tracing::warn!(
                    "Failed to compute assets for {} ({}): {}",
                    account_id,
                    status,
                    message
                );
            }
            Err(join_err) => {
                failed_dao_count += 1;
                tracing::warn!("Task panicked: {}", join_err);
            }
        }

        if completed.is_multiple_of(REFRESH_LOG_INTERVAL) || completed == total_daos {
            tracing::info!(
                "Progress: {}/{} DAOs processed ({} ok, {} failed)",
                completed,
                total_daos,
                successful_dao_count,
                failed_dao_count
            );
        }
    }

    if successful_dao_count == 0 && failed_dao_count > 0 {
        return Err("failed to compute public dashboard snapshot for all DAOs".into());
    }

    let trezu_dao_count = trezu_set.len() as i32;

    store_daily_balance_snapshot(
        &state.db_pool,
        snapshot_date,
        successful_dao_count,
        trezu_dao_count,
        failed_dao_count,
        &balances,
    )
    .await?;

    Ok(RefreshSummary {
        snapshot_date,
        dao_count: successful_dao_count,
        trezu_dao_count,
        failed_dao_count,
        balance_rows: balances.len(),
    })
}

/// Returns true if any snapshot exists within the current ISO week (Monday–Sunday).
async fn snapshot_exists_this_week(pool: &PgPool) -> Result<bool, sqlx::Error> {
    use chrono::Datelike;
    let today = Utc::now().date_naive();
    let days_since_monday = today.weekday().num_days_from_monday() as i64;
    let week_start = today - chrono::Duration::days(days_since_monday);

    let (exists,) = sqlx::query_as::<_, (bool,)>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM public_dashboard_daily_runs
            WHERE snapshot_date >= $1
        )
        "#,
    )
    .bind(week_start)
    .fetch_one(pool)
    .await?;

    Ok(exists)
}

#[tracing::instrument(level = "info", skip_all, fields(job = "public_dashboard_refresh"))]
pub async fn ensure_this_week_public_dashboard_snapshot(
    state: &Arc<AppState>,
) -> Result<Option<RefreshSummary>, Box<dyn std::error::Error + Send + Sync>> {
    if snapshot_exists_this_week(&state.db_pool).await? {
        return Ok(None);
    }

    let today = Utc::now().date_naive();
    refresh_public_dashboard_snapshot_for_date(state, today)
        .await
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::user::{
        assets::{Balance, TokenResidency},
        lockup::LockupBalance,
        staking::{StakingBalance, StakingPoolAccountInfo},
    };
    use near_api::NearToken;

    fn standard_token(
        token_id: &str,
        symbol: &str,
        decimals: u8,
        total_raw: &str,
        price: &str,
    ) -> SimplifiedToken {
        SimplifiedToken {
            id: token_id.to_string(),
            contract_id: Some(format!("{}.near", token_id)),
            lockup_instance_id: None,
            ft_lockup_schedule: None,
            residency: TokenResidency::Ft,
            network: "near".to_string(),
            chain_name: "Near Protocol".to_string(),
            symbol: symbol.to_string(),
            balance: Balance::Standard {
                total: total_raw.to_string(),
                locked: "0".to_string(),
            },
            decimals,
            price: price.to_string(),
            name: symbol.to_string(),
            icon: None,
            chain_icons: None,
        }
    }

    #[test]
    fn test_aggregate_tokens_mixed_balance_types() {
        let tokens = vec![
            standard_token("usdc", "USDC", 6, "1500000", "1"),
            standard_token("usdc", "USDC", 6, "2500000", "1"),
            SimplifiedToken {
                id: "near".to_string(),
                contract_id: None,
                lockup_instance_id: None,
                ft_lockup_schedule: None,
                residency: TokenResidency::Staked,
                network: "near".to_string(),
                chain_name: "Near Protocol".to_string(),
                symbol: "NEAR".to_string(),
                balance: Balance::Staked(StakingBalance {
                    staked_balance: NearToken::from_yoctonear(2_000_000_000_000_000_000_000_000),
                    unstaked_balance: NearToken::from_yoctonear(500_000_000_000_000_000_000_000),
                    can_withdraw: false,
                    pools: vec![StakingPoolAccountInfo {
                        pool_id: "poolv1.near".to_string(),
                        staked_balance: NearToken::from_yoctonear(
                            2_000_000_000_000_000_000_000_000,
                        ),
                        unstaked_balance: NearToken::from_yoctonear(
                            500_000_000_000_000_000_000_000,
                        ),
                        can_withdraw: false,
                    }],
                }),
                decimals: 24,
                price: "3".to_string(),
                name: "NEAR".to_string(),
                icon: None,
                chain_icons: None,
            },
            SimplifiedToken {
                id: "near".to_string(),
                contract_id: None,
                lockup_instance_id: None,
                ft_lockup_schedule: None,
                residency: TokenResidency::Lockup,
                network: "near".to_string(),
                chain_name: "Near Protocol".to_string(),
                symbol: "NEAR".to_string(),
                balance: Balance::Vested(LockupBalance {
                    total: NearToken::from_yoctonear(1_500_000_000_000_000_000_000_000),
                    storage_locked: NearToken::from_yoctonear(0),
                    total_allocated: NearToken::from_yoctonear(0),
                    unvested: NearToken::from_yoctonear(0),
                    staked: NearToken::from_yoctonear(0),
                    unstaked_balance: NearToken::from_yoctonear(0),
                    can_withdraw: false,
                    staking_pool_id: None,
                }),
                decimals: 24,
                price: "3".to_string(),
                name: "NEAR".to_string(),
                icon: None,
                chain_icons: None,
            },
        ];

        let aggregated = aggregate_tokens(&tokens);
        let (total_aum_usd, top_tokens) = summarize_tokens(aggregated);

        assert_eq!(decimal_to_string(&total_aum_usd), "16");
        assert_eq!(top_tokens.len(), 2);
        assert_eq!(top_tokens[0].token_id, "near");
        assert_eq!(top_tokens[0].total_amount_raw, "4000000000000000000000000");
        assert_eq!(top_tokens[0].total_usd, "12");
        assert_eq!(top_tokens[1].token_id, "usdc");
        assert_eq!(top_tokens[1].total_amount_raw, "4000000");
        assert_eq!(top_tokens[1].total_usd, "4");
    }

    #[sqlx::test]
    async fn test_store_and_load_latest_public_dashboard_snapshot(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let snapshot_date =
            NaiveDate::from_ymd_opt(2026, 3, 25).expect("test snapshot date should be valid");
        let balances = vec![
            StoredDailyBalance {
                dao_id: "dao-1.sputnik-dao.near".to_string(),
                is_trezu: true,
                token: AggregatedToken {
                    token_id: "near".to_string(),
                    contract_id: None,
                    symbol: "NEAR".to_string(),
                    name: "NEAR".to_string(),
                    icon: None,
                    decimals: 24,
                    total_amount_raw: BigDecimal::from_str("2500000000000000000000000").unwrap(),
                    price_usd: BigDecimal::from_str("3").unwrap(),
                    total_usd: BigDecimal::from_str("7.5").unwrap(),
                },
            },
            StoredDailyBalance {
                dao_id: "dao-2.sputnik-dao.near".to_string(),
                is_trezu: true,
                token: AggregatedToken {
                    token_id: "near".to_string(),
                    contract_id: None,
                    symbol: "NEAR".to_string(),
                    name: "NEAR".to_string(),
                    icon: None,
                    decimals: 24,
                    total_amount_raw: BigDecimal::from_str("1500000000000000000000000").unwrap(),
                    price_usd: BigDecimal::from_str("3").unwrap(),
                    total_usd: BigDecimal::from_str("4.5").unwrap(),
                },
            },
            StoredDailyBalance {
                dao_id: "dao-2.sputnik-dao.near".to_string(),
                is_trezu: false,
                token: AggregatedToken {
                    token_id: "usdc".to_string(),
                    contract_id: Some("usdc.tether-token.near".to_string()),
                    symbol: "USDC".to_string(),
                    name: "USDC".to_string(),
                    icon: None,
                    decimals: 6,
                    total_amount_raw: BigDecimal::from_str("4000000").unwrap(),
                    price_usd: BigDecimal::from_str("1").unwrap(),
                    total_usd: BigDecimal::from_str("4").unwrap(),
                },
            },
        ];

        store_daily_balance_snapshot(&pool, snapshot_date, 3, 2, 1, &balances).await?;

        let state = Arc::new(
            AppState::builder()
                .db_pool(pool.clone())
                .build()
                .await
                .expect("AppState should build"),
        );

        let snapshot = load_latest_public_dashboard_snapshot(&state)
            .await?
            .expect("snapshot should exist");
        assert_eq!(snapshot.snapshot_date, "2026-03-25");
        assert_eq!(snapshot.dao_count, 3);
        assert_eq!(snapshot.total_aum_usd, "16");
        assert_eq!(snapshot.top_tokens.len(), 2);
        assert_eq!(snapshot.top_tokens[0].rank, 1);
        assert_eq!(snapshot.top_tokens[0].token_id, "near");
        assert_eq!(
            snapshot.top_tokens[0].total_amount_raw,
            "4000000000000000000000000"
        );
        assert_eq!(snapshot.top_tokens[1].rank, 2);
        assert_eq!(snapshot.top_tokens[1].token_id, "usdc");

        assert!(
            snapshot_exists_for_date(&pool, snapshot_date).await?,
            "snapshot existence check should succeed"
        );

        Ok(())
    }

    /// snapshot_exists_this_week uses Utc::now() internally, so we seed a snapshot
    /// on the current week's Monday and verify the function returns true; then verify
    /// a snapshot from a prior week returns false.
    #[sqlx::test]
    async fn test_snapshot_exists_this_week(pool: PgPool) -> sqlx::Result<()> {
        use chrono::Datelike;

        let today = Utc::now().date_naive();
        let days_since_monday = today.weekday().num_days_from_monday() as i64;
        let this_monday = today - chrono::Duration::days(days_since_monday);
        let last_week = this_monday - chrono::Duration::days(7);

        // No snapshot yet → should be false
        assert!(
            !snapshot_exists_this_week(&pool).await?,
            "should be false when no snapshots exist"
        );

        // Insert a snapshot from last week → still false
        store_daily_balance_snapshot(&pool, last_week, 1, 0, 0, &[]).await?;
        assert!(
            !snapshot_exists_this_week(&pool).await?,
            "snapshot from prior week should not count"
        );

        // Insert a snapshot for this Monday → true
        store_daily_balance_snapshot(&pool, this_monday, 1, 0, 0, &[]).await?;
        assert!(
            snapshot_exists_this_week(&pool).await?,
            "snapshot on this week's Monday should be detected"
        );

        Ok(())
    }

    /// A snapshot mid-week (Wednesday) also satisfies the weekly check.
    #[sqlx::test]
    async fn test_snapshot_exists_this_week_mid_week(pool: PgPool) -> sqlx::Result<()> {
        use chrono::Datelike;

        let today = Utc::now().date_naive();
        let days_since_monday = today.weekday().num_days_from_monday() as i64;
        let this_wednesday =
            today - chrono::Duration::days(days_since_monday) + chrono::Duration::days(2);

        store_daily_balance_snapshot(&pool, this_wednesday, 5, 2, 1, &[]).await?;
        assert!(
            snapshot_exists_this_week(&pool).await?,
            "mid-week snapshot should satisfy the weekly check"
        );

        Ok(())
    }
}

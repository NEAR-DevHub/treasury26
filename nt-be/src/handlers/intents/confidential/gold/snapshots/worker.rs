use std::str::FromStr;
use std::sync::Arc;

use bigdecimal::{BigDecimal, FromPrimitive, Zero};
use chrono::{Duration, Utc};
use futures::{StreamExt, stream};
use near_account_id::AccountIdRef;

use super::repository::{
    SnapshotRow, insert_snapshot_rows, latest_snapshot_at, load_latest_balances_per_asset,
};
use crate::AppState;
use crate::constants::intents_tokens::get_defuse_tokens_map;
use crate::handlers::intents::confidential::balances::fetch_confidential_balances;
use crate::handlers::intents::confidential::bronze::store::load_confidential_history_accounts;

const SNAPSHOT_DEDUP_WINDOW: Duration = Duration::seconds(3300);
const CONFIDENTIAL_BALANCE_SNAPSHOT_WORKERS: usize = 5;

/// Write a snapshot row per non-zero asset plus zero tombstones for any asset
/// that was present in the prior snapshot but absent now. Transport errors are
/// logged and swallowed -- the next tick retries.
#[tracing::instrument(level = "info", skip_all, fields(dao_id = dao_id))]
pub async fn snapshot_confidential_dao_balances(state: &AppState, dao_id: &str) {
    let account_ref = match AccountIdRef::new(dao_id) {
        Ok(account_ref) => account_ref,
        Err(e) => {
            tracing::warn!("invalid account {}: {}", dao_id, e);
            return;
        }
    };

    let live_balances = match fetch_confidential_balances(state, account_ref).await {
        Ok(balances) => balances,
        Err((status, message)) => {
            tracing::warn!("fetch failed for {} ({}): {}", dao_id, status, message);
            return;
        }
    };

    let prior_balances = match load_latest_balances_per_asset(&state.db_pool, dao_id).await {
        Ok(map) => map,
        Err(e) => {
            tracing::warn!("prior snapshot load failed for {}: {}", dao_id, e);
            return;
        }
    };

    let defuse_map = get_defuse_tokens_map();
    let snapshot_at = Utc::now();
    let live_balances: Vec<(String, String)> = live_balances.into_iter().collect();
    let live_assets: Vec<String> = live_balances
        .iter()
        .map(|(asset, _)| asset.clone())
        .collect();
    let latest_prices = match state
        .price_service
        .get_cached_tokens_latest_price(&live_assets)
        .await
    {
        Ok(prices) => prices,
        Err(e) => {
            tracing::warn!("{} batch snapshot price lookup failed: {}", dao_id, e);
            std::collections::HashMap::new()
        }
    };
    let mut rows: Vec<SnapshotRow> = Vec::with_capacity(live_balances.len());
    let mut seen_assets = std::collections::HashSet::with_capacity(live_balances.len());

    for (asset, raw_available) in live_balances {
        let raw_balance = match BigDecimal::from_str(&raw_available) {
            Ok(value) => value,
            Err(e) => {
                tracing::warn!(
                    "{} {} unparseable raw balance '{}': {}",
                    dao_id,
                    asset,
                    raw_available,
                    e
                );
                continue;
            }
        };

        let Some(token_info) = defuse_map.get(&asset) else {
            tracing::warn!("{} unknown defuse asset {}, skipping", dao_id, asset);
            continue;
        };
        let scale = (0..token_info.decimals).fold(BigDecimal::from(1u32), |acc, _| {
            acc * BigDecimal::from(10u32)
        });
        let balance = &raw_balance / &scale;
        let price_usd = match latest_prices.get(&asset).copied() {
            Some(price) => {
                tracing::debug!(
                    "{} {} resolved cached snapshot price: {}",
                    dao_id,
                    asset,
                    price
                );
                BigDecimal::from_f64(price)
            }
            None => {
                tracing::debug!("{} {} no snapshot USD price available", dao_id, asset);
                None
            }
        };
        let value_usd = price_usd.as_ref().map(|price| &balance * price);

        seen_assets.insert(asset.clone());
        rows.push(SnapshotRow {
            asset,
            raw_balance,
            balance,
            price_usd,
            value_usd,
        });
    }

    for (prior_asset, prior_balance) in prior_balances {
        if seen_assets.contains(&prior_asset) {
            continue;
        }
        if prior_balance.is_zero() {
            continue;
        }
        rows.push(SnapshotRow {
            asset: prior_asset,
            raw_balance: BigDecimal::zero(),
            balance: BigDecimal::zero(),
            price_usd: None,
            value_usd: Some(BigDecimal::zero()),
        });
    }

    if rows.is_empty() {
        tracing::debug!("{} no rows to write at {}", dao_id, snapshot_at);
        return;
    }

    match insert_snapshot_rows(&state.db_pool, dao_id, snapshot_at, &rows).await {
        Ok(inserted) => tracing::info!("{} wrote {} rows at {}", dao_id, inserted, snapshot_at),
        Err(e) => tracing::warn!("{} insert failed: {}", dao_id, e),
    }
}

/// Dedup window covers activity-triggered snapshots that may have fired
/// within the same hour as this cron tick.
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(job = "confidential_balance_snapshot")
)]
pub async fn tick_confidential_balance_snapshot_cron(state: &Arc<AppState>) {
    let dao_ids = match load_confidential_history_accounts(&state.db_pool).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::error!("account load failed: {}", e);
            return;
        }
    };

    let accounts_seen = dao_ids.len();
    if accounts_seen > 0 {
        tracing::info!(
            "processing {} accounts with {} workers",
            accounts_seen,
            CONFIDENTIAL_BALANCE_SNAPSHOT_WORKERS
        );
    }

    let dedup_cutoff = Utc::now() - SNAPSHOT_DEDUP_WINDOW;
    let state = Arc::clone(state);

    stream::iter(dao_ids)
        .for_each_concurrent(CONFIDENTIAL_BALANCE_SNAPSHOT_WORKERS, |dao_id| {
            let state = Arc::clone(&state);
            async move {
                match latest_snapshot_at(&state.db_pool, &dao_id).await {
                    Ok(Some(latest)) if latest > dedup_cutoff => {
                        tracing::debug!("{} skipped, recent snapshot at {}", dao_id, latest);
                        return;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!("latest_snapshot_at failed for {}: {}", dao_id, e);
                        return;
                    }
                }

                snapshot_confidential_dao_balances(state.as_ref(), &dao_id).await;
            }
        })
        .await;
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::sync::Arc;

    use super::*;
    use crate::utils::env::EnvVars;
    use sqlx::postgres::PgPool;

    async fn create_real_api_state() -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();
        let env_vars = EnvVars::default();
        let db_pool = PgPool::connect(&env_vars.database_url)
            .await
            .expect("Failed to connect to database");
        Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("Failed to build AppState"),
        )
    }

    #[tokio::test]
    #[ignore]
    async fn test_snapshot_writes_nonzero_assets_and_zero_tombstones() {
        let state = create_real_api_state().await;
        let dao_id = std::env::var("CONFIDENTIAL_HISTORY_TEST_DAO")
            .unwrap_or_else(|_| "tobi.sputnik-dao.near".to_string());

        sqlx::query("DELETE FROM gold_confidential_balance_snapshots WHERE dao_id = $1")
            .bind(&dao_id)
            .execute(&state.db_pool)
            .await
            .expect("cleanup should succeed");

        let baseline_at = chrono::Utc::now() - chrono::Duration::hours(2);
        sqlx::query(
            r#"
            INSERT INTO gold_confidential_balance_snapshots
                (dao_id, asset, snapshot_at, raw_balance, balance)
            VALUES
                ($1, $2, $3, $4, $5),
                ($1, $6, $3, $4, $5)
            "#,
        )
        .bind(&dao_id)
        .bind("nep141:disappearing.test")
        .bind(baseline_at)
        .bind(BigDecimal::from_str("1000000").unwrap())
        .bind(BigDecimal::from_str("1").unwrap())
        .bind("nep141:also.disappearing.test")
        .execute(&state.db_pool)
        .await
        .expect("baseline insert should succeed");

        snapshot_confidential_dao_balances(&state, &dao_id).await;

        let new_rows: Vec<(String, BigDecimal)> = sqlx::query_as(
            r#"
            SELECT asset, balance
            FROM gold_confidential_balance_snapshots
            WHERE dao_id = $1 AND snapshot_at > $2
            ORDER BY asset
            "#,
        )
        .bind(&dao_id)
        .bind(baseline_at)
        .fetch_all(&state.db_pool)
        .await
        .expect("read should succeed");

        let disappeared_tombstones: Vec<&(String, BigDecimal)> = new_rows
            .iter()
            .filter(|(asset, _)| {
                asset == "nep141:disappearing.test" || asset == "nep141:also.disappearing.test"
            })
            .collect();
        assert_eq!(
            disappeared_tombstones.len(),
            2,
            "expected zero tombstones for both disappeared baseline assets"
        );
        for (_, balance) in &disappeared_tombstones {
            assert!(balance.is_zero(), "tombstone should have balance = 0");
        }
    }
}

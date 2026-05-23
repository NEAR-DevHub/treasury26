use std::str::FromStr;

use bigdecimal::{BigDecimal, Zero};
use chrono::{Duration, Utc};
use near_account_id::AccountIdRef;

use super::repository::{
    SnapshotRow, insert_snapshot_rows, latest_snapshot_at, load_latest_balances_per_asset,
};
use crate::AppState;
use crate::constants::intents_tokens::get_defuse_tokens_map;
use crate::handlers::intents::confidential::balances::fetch_confidential_balances;
use crate::handlers::intents::confidential::history_store::load_confidential_history_accounts;

pub const HOURLY_SNAPSHOT_CRON_TICK_SECS: u64 = 3600;

const SNAPSHOT_DEDUP_WINDOW_SECS: i64 = 3300;

/// Write a snapshot row per non-zero asset plus zero tombstones for any asset
/// that was present in the prior snapshot but absent now. Transport errors are
/// logged and swallowed — the next tick retries.
pub async fn snapshot_confidential_dao_balances(state: &AppState, dao_id: &str) {
    let account_ref = match AccountIdRef::new(dao_id) {
        Ok(account_ref) => account_ref,
        Err(e) => {
            log::warn!(
                "[confidential-balance-snapshot] invalid account {}: {}",
                dao_id,
                e
            );
            return;
        }
    };

    let live_balances = match fetch_confidential_balances(state, account_ref).await {
        Ok(balances) => balances,
        Err((status, message)) => {
            log::warn!(
                "[confidential-balance-snapshot] fetch failed for {} ({}): {}",
                dao_id,
                status,
                message
            );
            return;
        }
    };

    let prior_balances = match load_latest_balances_per_asset(&state.db_pool, dao_id).await {
        Ok(map) => map,
        Err(e) => {
            log::warn!(
                "[confidential-balance-snapshot] prior snapshot load failed for {}: {}",
                dao_id,
                e
            );
            return;
        }
    };

    let defuse_map = get_defuse_tokens_map();
    let snapshot_at = Utc::now();
    let mut rows: Vec<SnapshotRow> = Vec::with_capacity(live_balances.len());
    let mut seen_assets = std::collections::HashSet::with_capacity(live_balances.len());

    for (asset, raw_available) in live_balances {
        let raw_balance = match BigDecimal::from_str(&raw_available) {
            Ok(value) => value,
            Err(e) => {
                log::warn!(
                    "[confidential-balance-snapshot] {} {} unparseable raw balance '{}': {}",
                    dao_id,
                    asset,
                    raw_available,
                    e
                );
                continue;
            }
        };

        let Some(token_info) = defuse_map.get(&asset) else {
            log::warn!(
                "[confidential-balance-snapshot] {} unknown defuse asset {}, skipping",
                dao_id,
                asset
            );
            continue;
        };
        let scale = (0..token_info.decimals).fold(BigDecimal::from(1u32), |acc, _| {
            acc * BigDecimal::from(10u32)
        });
        let balance = &raw_balance / &scale;

        seen_assets.insert(asset.clone());
        rows.push(SnapshotRow {
            asset,
            raw_balance,
            balance,
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
        });
    }

    if rows.is_empty() {
        log::debug!(
            "[confidential-balance-snapshot] {} no rows to write at {}",
            dao_id,
            snapshot_at
        );
        return;
    }

    match insert_snapshot_rows(&state.db_pool, dao_id, snapshot_at, &rows).await {
        Ok(inserted) => log::info!(
            "[confidential-balance-snapshot] {} wrote {} rows at {}",
            dao_id,
            inserted,
            snapshot_at
        ),
        Err(e) => log::warn!(
            "[confidential-balance-snapshot] {} insert failed: {}",
            dao_id,
            e
        ),
    }
}

/// Dedup window covers activity-triggered snapshots that may have fired
/// within the same hour as this cron tick.
pub async fn tick_confidential_balance_snapshot_cron(state: &AppState) {
    let dao_ids = match load_confidential_history_accounts(&state.db_pool).await {
        Ok(ids) => ids,
        Err(e) => {
            log::error!(
                "[confidential-balance-snapshot-cron] account load failed: {}",
                e
            );
            return;
        }
    };

    let dedup_cutoff = Utc::now() - Duration::seconds(SNAPSHOT_DEDUP_WINDOW_SECS);

    for dao_id in dao_ids {
        match latest_snapshot_at(&state.db_pool, &dao_id).await {
            Ok(Some(latest)) if latest > dedup_cutoff => {
                log::debug!(
                    "[confidential-balance-snapshot-cron] {} skipped, recent snapshot at {}",
                    dao_id,
                    latest
                );
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                log::warn!(
                    "[confidential-balance-snapshot-cron] latest_snapshot_at failed for {}: {}",
                    dao_id,
                    e
                );
                continue;
            }
        }

        snapshot_confidential_dao_balances(state, &dao_id).await;
    }
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

        sqlx::query("DELETE FROM confidential_balance_snapshots WHERE dao_id = $1")
            .bind(&dao_id)
            .execute(&state.db_pool)
            .await
            .expect("cleanup should succeed");

        let baseline_at = chrono::Utc::now() - chrono::Duration::hours(2);
        sqlx::query(
            r#"
            INSERT INTO confidential_balance_snapshots
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
            FROM confidential_balance_snapshots
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

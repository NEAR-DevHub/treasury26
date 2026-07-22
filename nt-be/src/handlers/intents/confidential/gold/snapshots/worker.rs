use std::str::FromStr;
use std::sync::Arc;

use bigdecimal::{BigDecimal, Zero};
use chrono::{Duration, Utc};
use futures::{StreamExt, stream};
use near_account_id::AccountIdRef;

use super::repository::{
    SnapshotRow, has_outflow_events_since, insert_snapshot_rows, latest_snapshot_at,
    load_latest_balances_per_asset,
};
use crate::AppState;
use crate::constants::intents_tokens::get_defuse_tokens_map;
use crate::handlers::intents::confidential::balances::fetch_confidential_balances;
use crate::handlers::intents::confidential::bronze::store::load_confidential_history_accounts;

pub(crate) const SNAPSHOT_DEDUP_WINDOW: Duration = Duration::seconds(3300);
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

    let fetch = match fetch_confidential_balances(state, account_ref).await {
        Ok(fetch) => fetch,
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
    let live_balances: Vec<(String, String)> = fetch.balances;
    let mut rows: Vec<SnapshotRow> = Vec::with_capacity(live_balances.len());
    let mut seen_assets = std::collections::HashSet::with_capacity(live_balances.len());
    // Assets the API reported but we could not turn into a row must never be
    // treated as disappeared — a tombstone would record a false zero balance.
    seen_assets.extend(fetch.unparseable_assets);

    for (asset, raw_available) in live_balances {
        // Mark as seen before any skip below for the same reason.
        seen_assets.insert(asset.clone());
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
        // Priced exclusively from the 1Click-fed token registry snapshot
        // (minute-fresh, covers every intents token). No price known yet
        // stays NULL — charts re-price at read time from the same series.
        let price_usd = state
            .token_price_service
            .latest_price(&asset)
            .map(|(price, _)| price);
        if price_usd.is_none() {
            tracing::debug!("{} {} no snapshot USD price available", dao_id, asset);
        }
        let value_usd = price_usd.as_ref().map(|price| &balance * price);

        rows.push(SnapshotRow {
            asset,
            raw_balance,
            balance,
            price_usd,
            value_usd,
        });
    }

    // A 200 response with no usable balances would tombstone every held asset
    // to zero. That is indistinguishable from an upstream glitch, so only
    // trust it when the event ledger records outflows since the last snapshot.
    if seen_assets.is_empty() && prior_balances.values().any(|b| !b.is_zero()) {
        let since = match latest_snapshot_at(&state.db_pool, dao_id).await {
            Ok(at) => at.unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
            Err(e) => {
                tracing::warn!("{} latest_snapshot_at failed: {}", dao_id, e);
                return;
            }
        };
        match has_outflow_events_since(&state.db_pool, dao_id, since).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(
                    "{} refusing full-wipeout snapshot: empty balances response \
                     with no outflow events since {}",
                    dao_id,
                    since
                );
                return;
            }
            Err(e) => {
                tracing::warn!("{} outflow corroboration check failed: {}", dao_id, e);
                return;
            }
        }
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
    use crate::utils::test_utils::build_test_state;
    use sqlx::postgres::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const DAO: &str = "guard-test.sputnik-dao.near";

    async fn state_with_mock_api(pool: PgPool, mock: &MockServer) -> Arc<AppState> {
        let mut state = build_test_state(pool);
        state.env_vars.confidential_api_url = mock.uri();
        Arc::new(state)
    }

    /// Monitored confidential account with a still-valid JWT so the balance
    /// fetch goes straight to the (mocked) balances endpoint.
    async fn seed_confidential_dao(pool: &PgPool) {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts
                (account_id, enabled, is_confidential_account,
                 confidential_access_token, confidential_refresh_token,
                 confidential_token_expires_at)
            VALUES ($1, true, true, 'test-access', 'test-refresh', NOW() + INTERVAL '1 hour')
            ON CONFLICT (account_id) DO UPDATE SET
                is_confidential_account = true,
                confidential_access_token = 'test-access',
                confidential_refresh_token = 'test-refresh',
                confidential_token_expires_at = NOW() + INTERVAL '1 hour'
            "#,
        )
        .bind(DAO)
        .execute(pool)
        .await
        .expect("seed monitored account");
    }

    async fn seed_snapshot(pool: &PgPool, asset: &str, balance: &str, at: chrono::DateTime<Utc>) {
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

    async fn seed_sent_event(pool: &PgPool, at: chrono::DateTime<Utc>) {
        let bronze_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO bronze_confidential_history_events
                (account_id, created_at_external, deposit_address, status,
                 deposit_type, destination_asset, raw_payload)
            VALUES ($1, $2, 'addr', 'SUCCESS', 'ORIGIN_CHAIN', 'nep141:wrap.near', '{}'::jsonb)
            RETURNING id
            "#,
        )
        .bind(DAO)
        .bind(at)
        .fetch_one(pool)
        .await
        .expect("seed bronze event");

        sqlx::query(
            r#"
            INSERT INTO gold_confidential_history_events
                (history_event_id, dao_id, transaction_type, destination_asset,
                 amount_out, recipient, refund_to, counterparty, deposit_address,
                 quote_created_at)
            VALUES ($1, $2, 'sent', 'nep141:wrap.near', 1, 'bob.near', $2,
                    'bob.near', 'addr', $3)
            "#,
        )
        .bind(bronze_id)
        .bind(DAO)
        .bind(at)
        .execute(pool)
        .await
        .expect("seed gold event");
    }

    async fn mock_balances(mock: &MockServer, entries: serde_json::Value) {
        Mock::given(method("GET"))
            .and(path("/v0/account/balances"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "balances": entries })),
            )
            .mount(mock)
            .await;
    }

    async fn snapshots_after(
        pool: &PgPool,
        after: chrono::DateTime<Utc>,
    ) -> Vec<(String, BigDecimal)> {
        sqlx::query_as(
            r#"
            SELECT asset, balance
            FROM gold_confidential_balance_snapshots
            WHERE dao_id = $1 AND snapshot_at > $2
            ORDER BY asset
            "#,
        )
        .bind(DAO)
        .bind(after)
        .fetch_all(pool)
        .await
        .expect("read snapshots")
    }

    #[sqlx::test]
    async fn empty_balances_without_outflows_is_refused(pool: PgPool) {
        let mock = MockServer::start().await;
        mock_balances(&mock, serde_json::json!([])).await;
        let state = state_with_mock_api(pool.clone(), &mock).await;

        seed_confidential_dao(&pool).await;
        let baseline_at = Utc::now() - Duration::hours(2);
        seed_snapshot(&pool, "nep141:wrap.near", "5", baseline_at).await;

        snapshot_confidential_dao_balances(&state, DAO).await;

        assert!(
            snapshots_after(&pool, baseline_at).await.is_empty(),
            "uncorroborated full wipeout must not write tombstones"
        );
    }

    #[sqlx::test]
    async fn empty_balances_with_outflows_writes_tombstones(pool: PgPool) {
        let mock = MockServer::start().await;
        mock_balances(&mock, serde_json::json!([])).await;
        let state = state_with_mock_api(pool.clone(), &mock).await;

        seed_confidential_dao(&pool).await;
        let baseline_at = Utc::now() - Duration::hours(2);
        seed_snapshot(&pool, "nep141:wrap.near", "5", baseline_at).await;
        seed_sent_event(&pool, Utc::now() - Duration::minutes(30)).await;

        snapshot_confidential_dao_balances(&state, DAO).await;

        let rows = snapshots_after(&pool, baseline_at).await;
        assert_eq!(rows.len(), 1, "corroborated wipeout writes the tombstone");
        assert_eq!(rows[0].0, "nep141:wrap.near");
        assert!(rows[0].1.is_zero());
    }

    #[sqlx::test]
    async fn unparseable_balance_is_skipped_without_tombstone(pool: PgPool) {
        let mock = MockServer::start().await;
        mock_balances(
            &mock,
            serde_json::json!([
                { "tokenId": "nep141:wrap.near", "available": "not-a-number" },
                { "tokenId": "nep141:eth.omft.near", "available": "1000000000000000000" },
            ]),
        )
        .await;
        let state = state_with_mock_api(pool.clone(), &mock).await;

        seed_confidential_dao(&pool).await;
        let baseline_at = Utc::now() - Duration::hours(2);
        seed_snapshot(&pool, "nep141:wrap.near", "5", baseline_at).await;

        snapshot_confidential_dao_balances(&state, DAO).await;

        let rows = snapshots_after(&pool, baseline_at).await;
        assert_eq!(
            rows.len(),
            1,
            "only the parseable asset writes a row; the unparseable one is neither written nor tombstoned"
        );
        assert_eq!(rows[0].0, "nep141:eth.omft.near");
        assert!(!rows[0].1.is_zero());
    }

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

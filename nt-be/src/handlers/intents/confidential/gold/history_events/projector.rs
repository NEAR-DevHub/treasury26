use std::collections::{BTreeSet, HashMap, HashSet};
use std::str::FromStr;

use bigdecimal::{BigDecimal, Zero};
use futures::StreamExt;
use near_account_id::AccountIdRef;
use sqlx::PgPool;

use super::convert::bronze_to_gold;
use super::models::{ConfidentialDepositCorrectionIndex, DaoProjectionStats, ProjectionCycleStats};
use super::repository::{
    clear_balance_check_errors, clear_projection_error, delete_stale_gold_rows,
    delete_stale_legacy_gold_rows, earliest_success_for_dao, has_gold_before, load_bronze_suffix,
    load_confidential_deposit_corrections, load_dirty_daos, load_ledger_head_balances,
    record_balance_check_mismatch, seed_ledger_before, upsert_legacy_projection, upsert_projection,
    upsert_projection_error,
};
use crate::AppState;
use crate::constants::intents_tokens::get_defuse_tokens_map;
use crate::handlers::intents::confidential::balances::fetch_confidential_balances;
use crate::handlers::intents::confidential::gold::cursors::clear_gold_dirty_if_not_advanced;

/// Env flag (default ON) gating the confidential deposit-amount correction.
/// Set `CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS=false` to revert to raw 1Click
/// history amounts; re-project (reconciliation or manual dirty) to apply.
pub(crate) fn confidential_deposit_corrections_enabled() -> bool {
    !matches!(
        std::env::var("CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS").as_deref(),
        Ok("false") | Ok("0")
    )
}

#[tracing::instrument(level = "info", skip_all, fields(dao_id = dao_id))]
pub async fn project_confidential_gold_for_dao(
    pool: &PgPool,
    dao_id: &str,
) -> Result<DaoProjectionStats, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let got_lock: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1))")
        .bind(dao_id)
        .fetch_one(&mut *tx)
        .await?;
    if !got_lock {
        tx.commit().await?;
        return Ok(DaoProjectionStats {
            skipped_locked: true,
            ..DaoProjectionStats::default()
        });
    }

    let cursor = sqlx::query_as::<
        _,
        (
            chrono::DateTime<chrono::Utc>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        r#"
        SELECT gold_dirty_since, gold_recompute_from
        FROM gold_confidential_history_cursors
        WHERE account_id = $1
          AND gold_dirty_since IS NOT NULL
        FOR UPDATE
        "#,
    )
    .bind(dao_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((dirty_since, cursor_recompute_from)) = cursor else {
        tx.commit().await?;
        return Ok(DaoProjectionStats::default());
    };

    let earliest_success = earliest_success_for_dao(&mut tx, dao_id).await?;
    let Some(earliest_success) = earliest_success else {
        clear_gold_dirty_if_not_advanced(&mut tx, dao_id, dirty_since).await?;
        tx.commit().await?;
        return Ok(DaoProjectionStats::default());
    };

    let mut recompute_from = cursor_recompute_from.unwrap_or(earliest_success);
    if earliest_success < recompute_from
        && !has_gold_before(&mut tx, dao_id, recompute_from).await?
    {
        recompute_from = earliest_success;
    }

    let mut stats = DaoProjectionStats::default();
    let mut ledger = seed_ledger_before(&mut tx, dao_id, recompute_from).await?;
    let rows = load_bronze_suffix(&mut tx, dao_id, recompute_from).await?;
    let corrections = if confidential_deposit_corrections_enabled() {
        load_confidential_deposit_corrections(&mut tx, dao_id, recompute_from).await?
    } else {
        ConfidentialDepositCorrectionIndex::empty_disabled()
    };

    // Preserve gold rows for any bronze event we *considered* and either
    // projected successfully or could not project (errored). A transient
    // projection failure must not wipe out a previously good gold row.
    // Skipped events (Ok(None)) are intentionally excluded — they represent
    // bronze events that should not have a gold row at all.

    let mut preserve_ids: HashSet<i64> = HashSet::new();

    for row in rows {
        match bronze_to_gold(&row, &mut ledger, &corrections) {
            Ok(Some(projected)) => {
                preserve_ids.insert(projected.history_event_id);
                upsert_projection(&mut tx, &projected).await?;
                upsert_legacy_projection(&mut tx, &projected).await?;
                stats.rows_projected += 1;
            }
            Ok(None) => {
                clear_projection_error(&mut tx, row.id).await?;
            }
            Err(reason) => {
                preserve_ids.insert(row.id);
                upsert_projection_error(&mut tx, row.id, dao_id, &reason, &row.raw_payload).await?;
                stats.errors_written += 1;
            }
        }
    }

    let preserve_ids: Vec<i64> = preserve_ids.into_iter().collect();
    stats.rows_deleted =
        delete_stale_gold_rows(&mut tx, dao_id, recompute_from, &preserve_ids).await?;
    delete_stale_legacy_gold_rows(&mut tx, dao_id, recompute_from, &preserve_ids).await?;

    clear_gold_dirty_if_not_advanced(&mut tx, dao_id, dirty_since).await?;

    tx.commit().await?;
    Ok(stats)
}

/// Inline post-projection balance check: compare the unified ledger's
/// per-asset head balances against the live 1Click `/v0/account/balances`.
/// Runs only once the bronze backfill is complete and the gold cursor is
/// clean — a partial history cannot match live balances. A mismatch is
/// logged and recorded in the projection-errors table; the projected rows
/// keep serving. A fetch failure skips the check — the next projection pass
/// re-runs it.
#[tracing::instrument(level = "info", skip_all, fields(dao_id = dao_id))]
pub async fn verify_confidential_ledger_heads(state: &AppState, dao_id: &str) {
    let ready: Option<bool> = match sqlx::query_scalar(
        r#"
        SELECT bchc.backfill_done AND gchc.gold_dirty_since IS NULL
        FROM bronze_confidential_history_cursors bchc
        LEFT JOIN gold_confidential_history_cursors gchc
            ON gchc.account_id = bchc.account_id
        WHERE bchc.account_id = $1
        "#,
    )
    .bind(dao_id)
    .fetch_optional(&state.db_pool)
    .await
    {
        Ok(ready) => ready,
        Err(e) => {
            tracing::warn!("balance check readiness load failed for {}: {}", dao_id, e);
            return;
        }
    };
    if !ready.unwrap_or(false) {
        return;
    }

    let account_ref = match AccountIdRef::new(dao_id) {
        Ok(account_ref) => account_ref,
        Err(e) => {
            tracing::warn!("balance check skipped, invalid account {}: {}", dao_id, e);
            return;
        }
    };
    let fetch = match fetch_confidential_balances(state, account_ref).await {
        Ok(fetch) => fetch,
        Err((status, message)) => {
            tracing::warn!(
                "balance check skipped for {} ({}): {}",
                dao_id,
                status,
                message
            );
            return;
        }
    };

    let defuse_map = get_defuse_tokens_map();
    // Assets the API reported but we cannot compare (unparseable amount or
    // unknown decimals) are excluded from the check rather than treated as
    // zero/mismatched.
    let mut unverifiable: HashSet<String> = fetch.unparseable_assets.iter().cloned().collect();
    let mut api_balances: HashMap<String, BigDecimal> = HashMap::new();
    for (asset, raw_available) in fetch.balances {
        let (Ok(raw_balance), Some(token_info)) =
            (BigDecimal::from_str(&raw_available), defuse_map.get(&asset))
        else {
            tracing::warn!("{} {} not comparable, skipping in check", dao_id, asset);
            unverifiable.insert(asset);
            continue;
        };
        let scale = (0..token_info.decimals).fold(BigDecimal::from(1u32), |acc, _| {
            acc * BigDecimal::from(10u32)
        });
        api_balances.insert(asset, raw_balance / scale);
    }

    let ledger_heads = match load_ledger_head_balances(&state.db_pool, dao_id).await {
        Ok(heads) => heads,
        Err(e) => {
            tracing::warn!("balance check ledger load failed for {}: {}", dao_id, e);
            return;
        }
    };

    let assets: BTreeSet<&String> = api_balances.keys().chain(ledger_heads.keys()).collect();
    let zero = BigDecimal::zero();
    let mut mismatches: Vec<String> = Vec::new();
    for asset in assets {
        if unverifiable.contains(asset.as_str()) {
            continue;
        }
        let ledger = ledger_heads.get(asset.as_str()).unwrap_or(&zero);
        let api = api_balances.get(asset.as_str()).unwrap_or(&zero);
        if ledger != api {
            mismatches.push(format!("{asset} ledger={ledger} 1click={api}"));
        }
    }

    if mismatches.is_empty() {
        if let Err(e) = clear_balance_check_errors(&state.db_pool, dao_id).await {
            tracing::warn!("balance check error clear failed for {}: {}", dao_id, e);
        }
        return;
    }

    let detail = mismatches.join("; ");
    tracing::warn!("ledger/1click balance mismatch for {}: {}", dao_id, detail);
    if let Err(e) = record_balance_check_mismatch(&state.db_pool, dao_id, &detail).await {
        tracing::warn!("balance check error record failed for {}: {}", dao_id, e);
    }
}

#[tracing::instrument(
    level = "info",
    skip_all,
    fields(job = "confidential_gold_projection", worker_limit = worker_limit)
)]
pub async fn project_confidential_gold_for_dirty_daos(
    pool: &PgPool,
    worker_limit: usize,
) -> Result<ProjectionCycleStats, sqlx::Error> {
    let dirty_daos = load_dirty_daos(pool).await?;
    let accounts_seen = dirty_daos.len();
    let worker_limit = worker_limit.max(1);

    let mut stream = futures::stream::iter(dirty_daos.into_iter().map(|dao| {
        let pool = pool.clone();
        async move {
            let dao_id = dao.account_id;
            let dirty_since = dao.gold_dirty_since;
            let recompute_from = dao.gold_recompute_from;
            let result = project_confidential_gold_for_dao(&pool, &dao_id).await;
            (dao_id, dirty_since, recompute_from, result)
        }
    }))
    .buffer_unordered(worker_limit);

    let mut stats = ProjectionCycleStats {
        accounts_seen,
        ..ProjectionCycleStats::default()
    };

    while let Some((dao_id, dirty_since, recompute_from, result)) = stream.next().await {
        match result {
            Ok(dao_stats) if dao_stats.skipped_locked => {
                stats.accounts_skipped_locked += 1;
            }
            Ok(dao_stats) => {
                if dao_stats.rows_projected > 0 || dao_stats.rows_deleted > 0 {
                    stats.changed_accounts.push(dao_id.clone());
                }
                stats.accounts_projected += 1;
                stats.rows_projected += dao_stats.rows_projected;
                stats.rows_deleted += dao_stats.rows_deleted;
                stats.errors_written += dao_stats.errors_written;
                tracing::info!(
                    "projected dao={} dirty_since={} recompute_from={:?} rows={} deleted={} errors={}",
                    dao_id,
                    dirty_since,
                    recompute_from,
                    dao_stats.rows_projected,
                    dao_stats.rows_deleted,
                    dao_stats.errors_written
                );
            }
            Err(e) => {
                stats.accounts_failed += 1;
                tracing::warn!(
                    "projection failed for dao={} dirty_since={} recompute_from={:?}: {}",
                    dao_id,
                    dirty_since,
                    recompute_from,
                    e
                );
            }
        }
    }

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bigdecimal::BigDecimal;
    use chrono::{Duration, Utc};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty;
    use crate::utils::test_utils::build_test_state;

    const DAO: &str = "proj-test.sputnik-dao.near";

    async fn seed_confidential_dao(pool: &PgPool) {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
            VALUES ($1, true, true)
            ON CONFLICT (account_id) DO UPDATE SET is_confidential_account = true
            "#,
        )
        .bind(DAO)
        .execute(pool)
        .await
        .expect("seed monitored account");

        crate::services::ConfidentialCredentialStore::new(pool.clone(), None)
            .store_new(
                DAO,
                crate::services::CredentialScope::Dao,
                &crate::services::TokenBundle {
                    access_token: "test-access".to_string(),
                    refresh_token: "test-refresh".to_string(),
                },
                Utc::now() + Duration::hours(1),
            )
            .await
            .expect("seed credentials");
    }

    async fn seed_bronze_event(
        pool: &PgPool,
        at: chrono::DateTime<Utc>,
        recipient: &str,
        origin_asset: Option<&str>,
        destination_asset: &str,
        amount_in: Option<&str>,
        amount_out: &str,
    ) -> i64 {
        let mut payload = serde_json::json!({
            "recipient": recipient,
            "amountOutFormatted": amount_out,
        });
        if let Some(amount_in) = amount_in {
            payload["amountInFormatted"] = serde_json::json!(amount_in);
        }
        sqlx::query_scalar(
            r#"
            INSERT INTO bronze_confidential_history_events
                (account_id, created_at_external, deposit_address, status,
                 deposit_type, recipient_type, recipient, origin_asset,
                 destination_asset, raw_payload)
            VALUES ($1, $2, 'addr-' || $2::text, 'SUCCESS',
                'CONFIDENTIAL_INTENTS', 'CONFIDENTIAL_INTENTS', $3, $4, $5, $6)
            RETURNING id
            "#,
        )
        .bind(DAO)
        .bind(at)
        .bind(recipient)
        .bind(origin_asset)
        .bind(destination_asset)
        .bind(payload)
        .fetch_one(pool)
        .await
        .expect("seed bronze event")
    }

    #[derive(Debug, sqlx::FromRow)]
    struct UnifiedRow {
        gold_event_key: String,
        transaction_type: String,
        token_in: Option<String>,
        amount_in: Option<BigDecimal>,
        token_in_user_balance_after: Option<BigDecimal>,
        token_out: Option<String>,
        amount_out: Option<BigDecimal>,
        token_out_user_balance_after: Option<BigDecimal>,
        source_order: i64,
    }

    async fn load_unified_rows(pool: &PgPool) -> Vec<UnifiedRow> {
        sqlx::query_as(
            r#"
            SELECT gold_event_key, transaction_type::text AS transaction_type,
                   token_in, amount_in, token_in_user_balance_after,
                   token_out, amount_out, token_out_user_balance_after,
                   source_order
            FROM gold_treasury_ledger_events
            WHERE dao_id = $1 AND source_kind = 'confidential_history_event'
            ORDER BY event_time ASC, source_order ASC
            "#,
        )
        .bind(DAO)
        .fetch_all(pool)
        .await
        .expect("load unified rows")
    }

    #[sqlx::test]
    async fn projector_replays_bronze_into_unified_rows(pool: PgPool) {
        seed_confidential_dao(&pool).await;
        let t0 = Utc::now() - Duration::minutes(30);

        // deposit 5 wrap → sent 2 wrap → exchange 1 wrap for 3 usdt
        let deposit_id =
            seed_bronze_event(&pool, t0, DAO, None, "nep141:wrap.near", None, "5").await;
        let sent_id = seed_bronze_event(
            &pool,
            t0 + Duration::minutes(1),
            "external.near",
            Some("nep141:wrap.near"),
            "nep141:wrap.near",
            Some("2"),
            "2",
        )
        .await;
        let exchange_id = seed_bronze_event(
            &pool,
            t0 + Duration::minutes(2),
            DAO,
            Some("nep141:wrap.near"),
            "nep141:usdt.near",
            Some("1"),
            "3",
        )
        .await;

        mark_gold_dirty(&pool, DAO, None).await.expect("mark dirty");
        let stats = project_confidential_gold_for_dao(&pool, DAO)
            .await
            .expect("projection succeeds");
        assert_eq!(stats.rows_projected, 3);
        assert_eq!(stats.errors_written, 0);

        let rows = load_unified_rows(&pool).await;
        assert_eq!(rows.len(), 3);

        let deposit = &rows[0];
        assert_eq!(deposit.gold_event_key, format!("confidential:{deposit_id}"));
        assert_eq!(deposit.transaction_type, "deposit");
        assert_eq!(deposit.source_order, deposit_id);
        assert_eq!(deposit.token_in.as_deref(), Some("nep141:wrap.near"));
        assert_eq!(deposit.amount_in, Some(BigDecimal::from(5)));
        assert_eq!(
            deposit.token_in_user_balance_after,
            Some(BigDecimal::from(5))
        );
        assert!(deposit.token_out.is_none());

        let sent = &rows[1];
        assert_eq!(sent.gold_event_key, format!("confidential:{sent_id}"));
        assert_eq!(sent.transaction_type, "sent");
        assert_eq!(sent.token_out.as_deref(), Some("nep141:wrap.near"));
        assert_eq!(sent.amount_out, Some(BigDecimal::from(2)));
        assert_eq!(sent.token_out_user_balance_after, Some(BigDecimal::from(3)));
        assert!(sent.token_in.is_none());

        let exchange = &rows[2];
        assert_eq!(
            exchange.gold_event_key,
            format!("confidential:{exchange_id}")
        );
        assert_eq!(exchange.transaction_type, "exchange");
        assert_eq!(exchange.token_out.as_deref(), Some("nep141:wrap.near"));
        assert_eq!(exchange.amount_out, Some(BigDecimal::from(1)));
        assert_eq!(
            exchange.token_out_user_balance_after,
            Some(BigDecimal::from(2))
        );
        assert_eq!(exchange.token_in.as_deref(), Some("nep141:usdt.near"));
        assert_eq!(exchange.amount_in, Some(BigDecimal::from(3)));
        assert_eq!(
            exchange.token_in_user_balance_after,
            Some(BigDecimal::from(3))
        );
    }

    #[sqlx::test]
    async fn reprojection_deletes_rows_whose_bronze_event_stopped_succeeding(pool: PgPool) {
        seed_confidential_dao(&pool).await;
        let t0 = Utc::now() - Duration::minutes(30);
        let deposit_id =
            seed_bronze_event(&pool, t0, DAO, None, "nep141:wrap.near", None, "5").await;
        seed_bronze_event(
            &pool,
            t0 + Duration::minutes(1),
            DAO,
            None,
            "nep141:usdt.near",
            None,
            "1",
        )
        .await;

        mark_gold_dirty(&pool, DAO, None).await.expect("mark dirty");
        project_confidential_gold_for_dao(&pool, DAO)
            .await
            .expect("projection succeeds");
        assert_eq!(load_unified_rows(&pool).await.len(), 2);

        sqlx::query(
            "UPDATE bronze_confidential_history_events SET status = 'REFUNDED' WHERE id = $1",
        )
        .bind(deposit_id)
        .execute(&pool)
        .await
        .expect("flip bronze status");
        mark_gold_dirty(&pool, DAO, Some(t0))
            .await
            .expect("mark dirty");
        let stats = project_confidential_gold_for_dao(&pool, DAO)
            .await
            .expect("re-projection succeeds");

        assert_eq!(stats.rows_deleted, 1);
        let rows = load_unified_rows(&pool).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].token_in.as_deref(), Some("nep141:usdt.near"));
    }

    async fn state_with_mock_api(pool: PgPool, mock: &MockServer) -> Arc<AppState> {
        let mut state = build_test_state(pool);
        state.env_vars.confidential_api_url = mock.uri();
        Arc::new(state)
    }

    async fn mock_balances(mock: &MockServer, entries: serde_json::Value) {
        mock.reset().await;
        Mock::given(method("GET"))
            .and(path("/v0/account/balances"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "balances": entries })),
            )
            .mount(mock)
            .await;
    }

    async fn balance_check_errors(pool: &PgPool) -> Vec<String> {
        sqlx::query_scalar(
            r#"
            SELECT reason FROM gold_confidential_history_projection_errors
            WHERE dao_id = $1 AND reason LIKE 'balance check: %'
            "#,
        )
        .bind(DAO)
        .fetch_all(pool)
        .await
        .expect("load balance check errors")
    }

    #[sqlx::test]
    async fn inline_balance_check_flags_mismatch_and_clears_on_match(pool: PgPool) {
        seed_confidential_dao(&pool).await;
        sqlx::query(
            r#"
            INSERT INTO bronze_confidential_history_cursors (account_id, backfill_done, last_polled_at)
            VALUES ($1, true, NOW())
            "#,
        )
        .bind(DAO)
        .execute(&pool)
        .await
        .expect("seed bronze cursor");

        let t0 = Utc::now() - Duration::minutes(30);
        seed_bronze_event(&pool, t0, DAO, None, "nep141:wrap.near", None, "5").await;
        mark_gold_dirty(&pool, DAO, None).await.expect("mark dirty");
        project_confidential_gold_for_dao(&pool, DAO)
            .await
            .expect("projection succeeds");

        let mock = MockServer::start().await;
        let state = state_with_mock_api(pool.clone(), &mock).await;

        // Ledger head is 5 wrap (24 decimals). Matching balances: no error.
        mock_balances(
            &mock,
            serde_json::json!([
                { "tokenId": "nep141:wrap.near", "available": "5000000000000000000000000" }
            ]),
        )
        .await;
        verify_confidential_ledger_heads(&state, DAO).await;
        assert!(balance_check_errors(&pool).await.is_empty());

        // Drifted balances: error recorded, projected rows untouched.
        mock_balances(
            &mock,
            serde_json::json!([
                { "tokenId": "nep141:wrap.near", "available": "7000000000000000000000000" }
            ]),
        )
        .await;
        verify_confidential_ledger_heads(&state, DAO).await;
        let errors = balance_check_errors(&pool).await;
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("nep141:wrap.near"));
        assert_eq!(load_unified_rows(&pool).await.len(), 1);

        // Fetch failure: check skipped, prior error row stays as-is.
        mock.reset().await;
        Mock::given(method("GET"))
            .and(path("/v0/account/balances"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;
        verify_confidential_ledger_heads(&state, DAO).await;
        assert_eq!(balance_check_errors(&pool).await.len(), 1);

        // Matching again: the recorded mismatch clears.
        mock_balances(
            &mock,
            serde_json::json!([
                { "tokenId": "nep141:wrap.near", "available": "5000000000000000000000000" }
            ]),
        )
        .await;
        verify_confidential_ledger_heads(&state, DAO).await;
        assert!(balance_check_errors(&pool).await.is_empty());
    }
}

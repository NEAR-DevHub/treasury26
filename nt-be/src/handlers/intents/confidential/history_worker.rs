use near_account_id::AccountIdRef;
use reqwest::StatusCode;

use crate::AppState;
use crate::handlers::intents::confidential::history::fetch_history;
use crate::handlers::intents::confidential::history_store::{
    load_confidential_history_accounts, load_history_cursor, mark_history_backfill_done,
    save_history_cursors, upsert_history_events,
};

#[derive(Debug, Clone)]
pub struct HistoryPollResult {
    pub account_id: String,
    pub items_fetched: usize,
    pub rows_touched: u64,
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HistoryBackfillResult {
    pub account_id: String,
    pub items_fetched: usize,
    pub rows_touched: u64,
    pub prev_cursor: Option<String>,
    pub backfill_done: bool,
}

#[derive(Debug, Clone)]
pub struct HistoryBackfillDrainResult {
    pub account_id: String,
    pub pages_fetched: usize,
    pub items_fetched: usize,
    pub rows_touched: u64,
    pub last_prev_cursor: Option<String>,
    pub backfill_done: bool,
}

#[derive(Debug, Clone)]
pub struct HistoryCycleAccountResult {
    pub account_id: String,
    pub forward: Option<HistoryPollResult>,
    pub backfill: Option<HistoryBackfillDrainResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HistoryCycleResult {
    pub accounts_seen: usize,
    pub accounts_processed: usize,
    pub accounts_failed: usize,
    pub forward_items_fetched: usize,
    pub forward_rows_touched: u64,
    pub backfill_items_fetched: usize,
    pub backfill_rows_touched: u64,
    pub accounts: Vec<HistoryCycleAccountResult>,
}

fn latest_page_poll_cursors() -> (Option<&'static str>, Option<&'static str>) {
    (None, None)
}

pub async fn poll_confidential_history_once(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> Result<HistoryPollResult, (StatusCode, String)> {
    log::debug!(
        "[confidential-history] {} latest page poll limit={}",
        account_id,
        limit
    );

    let (next_cursor, prev_cursor) = latest_page_poll_cursors();
    let page = fetch_history(state, account_id, limit, next_cursor, prev_cursor).await?;

    let rows_touched = upsert_history_events(&state.db_pool, account_id.as_str(), &page.items)
        .await
        .map_err(|e| {
            log::error!(
                "[confidential-history] {} Bronze upsert failed: {}",
                account_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("history Bronze upsert failed: {}", e),
            )
        })?;

    save_history_cursors(
        &state.db_pool,
        account_id.as_str(),
        page.next_cursor.as_deref(),
        page.prev_cursor.as_deref(),
    )
    .await
    .map_err(|e| {
        log::error!(
            "[confidential-history] {} cursor save failed: {}",
            account_id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("history cursor save failed: {}", e),
        )
    })?;

    Ok(HistoryPollResult {
        account_id: account_id.as_str().to_string(),
        items_fetched: page.items.len(),
        rows_touched,
        next_cursor: page.next_cursor,
        prev_cursor: page.prev_cursor,
    })
}

pub async fn backfill_confidential_history_once(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> Result<HistoryBackfillResult, (StatusCode, String)> {
    let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
        .await
        .map_err(|e| {
            log::error!(
                "[confidential-history-backfill] {} cursor load failed: {}",
                account_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("history cursor load failed: {}", e),
            )
        })?;

    if matches!(cursor.as_ref().map(|c| c.backfill_done), Some(true)) {
        return Ok(HistoryBackfillResult {
            account_id: account_id.as_str().to_string(),
            items_fetched: 0,
            rows_touched: 0,
            prev_cursor: cursor.and_then(|c| c.backward_cursor),
            backfill_done: true,
        });
    }

    let backward_cursor = cursor.as_ref().and_then(|c| c.backward_cursor.as_deref());
    let saved_backward_cursor = backward_cursor.map(ToString::to_string);
    let page = fetch_history(state, account_id, limit, None, backward_cursor).await?;

    let rows_touched = upsert_history_events(&state.db_pool, account_id.as_str(), &page.items)
        .await
        .map_err(|e| {
            log::error!(
                "[confidential-history-backfill] {} Bronze upsert failed: {}",
                account_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("history Bronze upsert failed: {}", e),
            )
        })?;

    let forward_cursor_to_save = if cursor.is_none() {
        page.next_cursor.as_deref()
    } else {
        None
    };

    save_history_cursors(
        &state.db_pool,
        account_id.as_str(),
        forward_cursor_to_save,
        page.prev_cursor.as_deref(),
    )
    .await
    .map_err(|e| {
        log::error!(
            "[confidential-history-backfill] {} cursor save failed: {}",
            account_id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("history cursor save failed: {}", e),
        )
    })?;

    let backfill_done = page.items.is_empty()
        || page.prev_cursor.is_none()
        || page.prev_cursor.as_deref() == saved_backward_cursor.as_deref();
    if backfill_done {
        mark_history_backfill_done(&state.db_pool, account_id.as_str())
            .await
            .map_err(|e| {
                log::error!(
                    "[confidential-history-backfill] {} mark done failed: {}",
                    account_id,
                    e
                );
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("history backfill mark done failed: {}", e),
                )
            })?;
    }

    Ok(HistoryBackfillResult {
        account_id: account_id.as_str().to_string(),
        items_fetched: page.items.len(),
        rows_touched,
        prev_cursor: page.prev_cursor,
        backfill_done,
    })
}

pub async fn backfill_confidential_history_until_done(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> Result<HistoryBackfillDrainResult, (StatusCode, String)> {
    let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
        .await
        .map_err(|e| {
            log::error!(
                "[confidential-history-backfill] {} cursor load failed: {}",
                account_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("history cursor load failed: {}", e),
            )
        })?;

    if matches!(cursor.as_ref().map(|c| c.backfill_done), Some(true)) {
        return Ok(HistoryBackfillDrainResult {
            account_id: account_id.as_str().to_string(),
            pages_fetched: 0,
            items_fetched: 0,
            rows_touched: 0,
            last_prev_cursor: cursor.and_then(|c| c.backward_cursor),
            backfill_done: true,
        });
    }

    let mut pages_fetched = 0usize;
    let mut items_fetched = 0usize;
    let mut rows_touched = 0u64;

    loop {
        let page = backfill_confidential_history_once(state, account_id, limit).await?;
        pages_fetched += 1;
        items_fetched += page.items_fetched;
        rows_touched += page.rows_touched;

        if page.backfill_done {
            return Ok(HistoryBackfillDrainResult {
                account_id: account_id.as_str().to_string(),
                pages_fetched,
                items_fetched,
                rows_touched,
                last_prev_cursor: page.prev_cursor,
                backfill_done: true,
            });
        }
    }
}

pub async fn run_confidential_history_account_cycle(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> Result<HistoryCycleAccountResult, (StatusCode, String)> {
    let forward = poll_confidential_history_once(state, account_id, limit).await?;
    let backfill = backfill_confidential_history_until_done(state, account_id, limit).await?;

    Ok(HistoryCycleAccountResult {
        account_id: account_id.as_str().to_string(),
        forward: Some(forward),
        backfill: Some(backfill),
        error: None,
    })
}

pub async fn run_confidential_history_cycle(
    state: &AppState,
    limit: u32,
) -> Result<HistoryCycleResult, (StatusCode, String)> {
    let account_ids = load_confidential_history_accounts(&state.db_pool)
        .await
        .map_err(|e| {
            log::error!("[confidential-history-cycle] account load failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("history account load failed: {}", e),
            )
        })?;

    let mut result = HistoryCycleResult {
        accounts_seen: account_ids.len(),
        accounts_processed: 0,
        accounts_failed: 0,
        forward_items_fetched: 0,
        forward_rows_touched: 0,
        backfill_items_fetched: 0,
        backfill_rows_touched: 0,
        accounts: Vec::with_capacity(account_ids.len()),
    };

    for account_id in account_ids {
        let account_ref = match AccountIdRef::new(&account_id) {
            Ok(account_ref) => account_ref,
            Err(e) => {
                let error = format!("invalid account id: {}", e);
                log::warn!("[confidential-history-cycle] {}: {}", account_id, error);
                result.accounts_failed += 1;
                result.accounts.push(HistoryCycleAccountResult {
                    account_id,
                    forward: None,
                    backfill: None,
                    error: Some(error),
                });
                continue;
            }
        };

        let forward = match poll_confidential_history_once(state, account_ref, limit).await {
            Ok(forward) => forward,
            Err((status, message)) => {
                let error = format!("forward poll failed ({}): {}", status, message);
                log::warn!("[confidential-history-cycle] {}: {}", account_id, error);
                result.accounts_failed += 1;
                result.accounts.push(HistoryCycleAccountResult {
                    account_id,
                    forward: None,
                    backfill: None,
                    error: Some(error),
                });
                continue;
            }
        };

        result.accounts_processed += 1;
        result.forward_items_fetched += forward.items_fetched;
        result.forward_rows_touched += forward.rows_touched;

        let backfill =
            match backfill_confidential_history_until_done(state, account_ref, limit).await {
                Ok(backfill) => {
                    result.backfill_items_fetched += backfill.items_fetched;
                    result.backfill_rows_touched += backfill.rows_touched;
                    Some(backfill)
                }
                Err((status, message)) => {
                    let error = format!("backfill failed ({}): {}", status, message);
                    log::warn!("[confidential-history-cycle] {}: {}", account_id, error);
                    result.accounts_failed += 1;
                    result.accounts.push(HistoryCycleAccountResult {
                        account_id,
                        forward: Some(forward),
                        backfill: None,
                        error: Some(error),
                    });
                    continue;
                }
            };

        result.accounts.push(HistoryCycleAccountResult {
            account_id,
            forward: Some(forward),
            backfill,
            error: None,
        });
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::handlers::intents::confidential::history_store::{
        load_confidential_history_accounts, load_history_cursor, mark_history_backfill_done,
    };
    use crate::utils::env::EnvVars;

    #[test]
    fn test_latest_page_poll_uses_no_cursors() {
        let (next_cursor, prev_cursor) = latest_page_poll_cursors();

        assert!(next_cursor.is_none());
        assert!(prev_cursor.is_none());
    }

    async fn create_real_api_state() -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let env_vars = EnvVars::default();
        let db_pool = sqlx::postgres::PgPool::connect(&env_vars.database_url)
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
    async fn test_poll_confidential_history_once_ingests_bronze_and_cursor() {
        let state = create_real_api_state().await;
        let dao_id = std::env::var("CONFIDENTIAL_HISTORY_TEST_DAO")
            .unwrap_or_else(|_| "tobi.sputnik-dao.near".to_string());
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");
        let limit = 5;

        let first = poll_confidential_history_once(&state, account_id, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("first history poll failed: {} - {}", status, msg)
            });

        assert_eq!(first.account_id, account_id.as_str());
        assert!(first.items_fetched <= limit as usize);
        assert_eq!(first.rows_touched, first.items_fetched as u64);

        let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
            .await
            .expect("cursor load should succeed")
            .expect("cursor should exist after polling");
        assert_eq!(cursor.account_id, account_id.as_str());
        assert!(cursor.forward_cursor.is_some() || first.next_cursor.is_none());
        assert!(cursor.backward_cursor.is_some() || first.prev_cursor.is_none());

        let second = poll_confidential_history_once(&state, account_id, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("second history poll failed: {} - {}", status, msg)
            });
        assert!(second.items_fetched <= limit as usize);

        let duplicate_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM confidential_history_events
                WHERE account_id = $1
                GROUP BY created_at_external, deposit_address
                HAVING COUNT(*) > 1
            ) duplicates
            "#,
        )
        .bind(account_id.as_str())
        .fetch_one(&state.db_pool)
        .await
        .expect("duplicate check should succeed");

        assert_eq!(duplicate_count, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn test_backfill_confidential_history_once_ingests_bronze_and_cursor() {
        let state = create_real_api_state().await;
        let dao_id = std::env::var("CONFIDENTIAL_HISTORY_TEST_DAO")
            .unwrap_or_else(|_| "tobi.sputnik-dao.near".to_string());
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");
        let limit = 5;

        let first = backfill_confidential_history_once(&state, account_id, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("first backfill poll failed: {} - {}", status, msg)
            });

        assert_eq!(first.account_id, account_id.as_str());
        assert!(first.items_fetched <= limit as usize);
        assert_eq!(first.rows_touched, first.items_fetched as u64);

        let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
            .await
            .expect("cursor load should succeed")
            .expect("cursor should exist after backfill");
        assert_eq!(cursor.account_id, account_id.as_str());

        let second = backfill_confidential_history_once(&state, account_id, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("second backfill poll failed: {} - {}", status, msg)
            });
        assert!(second.items_fetched <= limit as usize);

        let duplicate_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM confidential_history_events
                WHERE account_id = $1
                GROUP BY created_at_external, deposit_address
                HAVING COUNT(*) > 1
            ) duplicates
            "#,
        )
        .bind(account_id.as_str())
        .fetch_one(&state.db_pool)
        .await
        .expect("duplicate check should succeed");

        assert_eq!(duplicate_count, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn test_backfill_confidential_history_once_returns_when_already_done() {
        let state = create_real_api_state().await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let dao_id = format!("test-{}.near", &suffix[..8]);
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");

        mark_history_backfill_done(&state.db_pool, account_id.as_str())
            .await
            .expect("mark done should succeed");

        let result = backfill_confidential_history_once(&state, account_id, 5)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("done backfill poll failed: {} - {}", status, msg)
            });

        assert_eq!(result.items_fetched, 0);
        assert_eq!(result.rows_touched, 0);
        assert!(result.backfill_done);
    }

    #[tokio::test]
    #[ignore]
    async fn test_backfill_confidential_history_until_done_skips_when_already_done() {
        let state = create_real_api_state().await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let dao_id = format!("test-{}.near", &suffix[..8]);
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");

        mark_history_backfill_done(&state.db_pool, account_id.as_str())
            .await
            .expect("mark done should succeed");

        let result = backfill_confidential_history_until_done(&state, account_id, 5)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("done backfill drain failed: {} - {}", status, msg)
            });

        assert_eq!(result.account_id, account_id.as_str());
        assert_eq!(result.pages_fetched, 0);
        assert_eq!(result.items_fetched, 0);
        assert_eq!(result.rows_touched, 0);
        assert!(result.backfill_done);
    }

    #[tokio::test]
    #[ignore]
    async fn test_run_confidential_history_cycle_fills_bronze_without_duplicates() {
        let state = create_real_api_state().await;
        let limit = 5;

        let result = run_confidential_history_cycle(&state, limit)
            .await
            .unwrap_or_else(|(status, msg)| panic!("history cycle failed: {} - {}", status, msg));
        let second_result = run_confidential_history_cycle(&state, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("second history cycle failed: {} - {}", status, msg)
            });

        assert_eq!(result.accounts_seen, result.accounts.len());
        assert_eq!(
            result.accounts_processed,
            result
                .accounts
                .iter()
                .filter(|account| account.forward.is_some())
                .count()
        );
        assert_eq!(
            result.accounts_failed,
            result
                .accounts
                .iter()
                .filter(|account| account.error.is_some())
                .count()
        );
        assert_eq!(
            result.forward_items_fetched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.forward.as_ref())
                .map(|forward| forward.items_fetched)
                .sum::<usize>()
        );
        assert_eq!(
            result.forward_rows_touched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.forward.as_ref())
                .map(|forward| forward.rows_touched)
                .sum::<u64>()
        );
        assert_eq!(
            result.backfill_items_fetched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .map(|backfill| backfill.items_fetched)
                .sum::<usize>()
        );
        assert_eq!(
            result.backfill_rows_touched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .map(|backfill| backfill.rows_touched)
                .sum::<u64>()
        );
        assert!(
            result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .all(|backfill| backfill.backfill_done)
        );
        assert!(
            second_result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .all(|backfill| backfill.pages_fetched == 0 || backfill.backfill_done)
        );

        let touched_accounts: Vec<String> = result
            .accounts
            .iter()
            .filter(|account| account.forward.is_some() || account.backfill.is_some())
            .map(|account| account.account_id.clone())
            .collect();
        if touched_accounts.is_empty() {
            return;
        }

        let duplicate_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM confidential_history_events
                WHERE account_id = ANY($1)
                GROUP BY account_id, created_at_external, deposit_address
                HAVING COUNT(*) > 1
            ) duplicates
            "#,
        )
        .bind(&touched_accounts)
        .fetch_one(&state.db_pool)
        .await
        .expect("duplicate check should succeed");

        assert_eq!(duplicate_count, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn test_load_confidential_history_accounts_for_cycle() {
        let state = create_real_api_state().await;

        let accounts = load_confidential_history_accounts(&state.db_pool)
            .await
            .expect("account load should succeed");

        let mut sorted = accounts.clone();
        sorted.sort();
        assert_eq!(accounts, sorted);
    }
}

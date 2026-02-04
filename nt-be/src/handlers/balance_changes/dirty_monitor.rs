//! Dirty Account Priority Monitor
//!
//! This module implements priority gap-filling for accounts marked as "dirty".
//! When a user interacts with a treasury via the UI, the account is marked dirty
//! with a timestamp indicating how far back to fill gaps. This module spawns
//! parallel tasks for each dirty account, filling gaps most-recent-first.
//!
//! The dirty monitor runs alongside the main monitoring cycle — dirty accounts
//! get attention from both, giving them double coverage.

use near_api::{Chain, NetworkConfig};
use sqlx::types::chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::HashMap;
use tokio::task::JoinHandle;

use super::gap_filler::fill_gaps_with_hints;
use super::staking_rewards::is_staking_token;
use super::transfer_hints::TransferHintService;

/// Run one poll cycle of the dirty account monitor.
///
/// This function:
/// 1. Cleans up finished tasks from `active_tasks`
/// 2. Queries for dirty accounts
/// 3. Spawns a parallel task for each dirty account not already in-flight
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR archival network configuration
/// * `hint_service` - Optional shared transfer hint service
/// * `active_tasks` - Map of account_id -> JoinHandle for in-flight tasks
pub async fn run_dirty_monitor(
    pool: &PgPool,
    network: &NetworkConfig,
    _hint_service: Option<&TransferHintService>,
    active_tasks: &mut HashMap<String, JoinHandle<()>>,
) {
    // 1. Clean up finished tasks
    active_tasks.retain(|account_id, handle| {
        if handle.is_finished() {
            log::info!("[dirty-monitor] Task for {} completed", account_id);
            false
        } else {
            true
        }
    });

    // 2. Query dirty accounts
    let dirty_accounts: Vec<(String, DateTime<Utc>)> = match sqlx::query_as(
        r#"
        SELECT account_id, dirty_at
        FROM monitored_accounts
        WHERE dirty_at IS NOT NULL AND enabled = true
        "#,
    )
    .fetch_all(pool)
    .await
    {
        Ok(accounts) => accounts,
        Err(e) => {
            log::error!("[dirty-monitor] Failed to query dirty accounts: {}", e);
            return;
        }
    };

    if dirty_accounts.is_empty() {
        return;
    }

    // 3. Spawn tasks for accounts not already in-flight
    for (account_id, dirty_at) in dirty_accounts {
        if active_tasks.contains_key(&account_id) {
            continue;
        }

        let original_dirty_at = dirty_at;
        let pool = pool.clone();
        let network = network.clone();
        let account_id_clone = account_id.clone();

        log::info!(
            "[dirty-monitor] Spawning priority task for {} (dirty_at: {})",
            account_id,
            original_dirty_at
        );

        let handle = tokio::spawn(async move {
            // Note: hint_service is not passed to spawned tasks because
            // TransferHintService is not Clone. Binary search fallback is used instead.
            // This can be improved later by wrapping the service in Arc in AppState.
            if let Err(e) = run_dirty_task(
                &pool,
                &network,
                &account_id_clone,
                original_dirty_at,
                None,
            )
            .await
            {
                log::error!(
                    "[dirty-monitor] Task for {} failed: {}",
                    account_id_clone,
                    e
                );
            }
        });

        active_tasks.insert(account_id, handle);
    }
}

/// Run priority gap-filling for a single dirty account.
///
/// Fills gaps between `dirty_at` and now, most-recent-first.
/// After all gaps are filled, conditionally clears `dirty_at` only if
/// it hasn't been updated by the API while this task was running.
async fn run_dirty_task(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    original_dirty_at: DateTime<Utc>,
    hint_service: Option<&TransferHintService>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Get current block height
    let up_to_block = Chain::block().fetch_from(network).await?.header.height as i64;

    // Get all tokens for this account (excluding staking tokens)
    let tokens: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
        ORDER BY token_id
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    let mut total_filled = 0;

    for token_id in &tokens {
        if is_staking_token(token_id) {
            continue;
        }

        match fill_gaps_with_hints(pool, network, account_id, token_id, up_to_block, hint_service)
            .await
        {
            Ok(filled) => {
                if !filled.is_empty() {
                    log::info!(
                        "[dirty-monitor] {}/{}: Filled {} gaps",
                        account_id,
                        token_id,
                        filled.len()
                    );
                    total_filled += filled.len();
                }
            }
            Err(e) => {
                log::error!(
                    "[dirty-monitor] {}/{}: Error filling gaps: {}",
                    account_id,
                    token_id,
                    e
                );
            }
        }
    }

    log::info!(
        "[dirty-monitor] {} completed: filled {} total gaps",
        account_id,
        total_filled
    );

    // Conditional clear: only clear if dirty_at hasn't changed since we started
    let result = sqlx::query(
        r#"
        UPDATE monitored_accounts
        SET dirty_at = NULL
        WHERE account_id = $1 AND dirty_at = $2
        "#,
    )
    .bind(account_id)
    .bind(original_dirty_at)
    .execute(pool)
    .await?;

    if result.rows_affected() > 0 {
        log::info!("[dirty-monitor] {} dirty flag cleared", account_id);
    } else {
        log::info!(
            "[dirty-monitor] {} dirty flag was re-set during task, leaving for next cycle",
            account_id
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test]
    async fn test_dirty_monitor_no_dirty_accounts(pool: PgPool) -> sqlx::Result<()> {
        let network = NetworkConfig::mainnet();
        let mut active_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

        // Should not error with no dirty accounts
        run_dirty_monitor(&pool, &network, None, &mut active_tasks).await;

        assert!(
            active_tasks.is_empty(),
            "No tasks should be spawned when no dirty accounts exist"
        );

        Ok(())
    }

    #[sqlx::test]
    async fn test_dirty_monitor_spawns_task_for_dirty_account(pool: PgPool) -> sqlx::Result<()> {
        // Insert a dirty account
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, dirty_at)
            VALUES ($1, true, NOW() - INTERVAL '24 hours')
            "#,
        )
        .bind("test.sputnik-dao.near")
        .execute(&pool)
        .await?;

        let network = NetworkConfig::mainnet();
        let mut active_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

        // Run dirty monitor — should spawn a task
        run_dirty_monitor(&pool, &network, None, &mut active_tasks).await;

        assert_eq!(
            active_tasks.len(),
            1,
            "Should spawn one task for the dirty account"
        );
        assert!(
            active_tasks.contains_key("test.sputnik-dao.near"),
            "Task should be keyed by account_id"
        );

        // Clean up
        for (_, handle) in active_tasks.drain() {
            handle.abort();
        }

        Ok(())
    }

    #[sqlx::test]
    async fn test_dirty_monitor_skips_in_flight_accounts(pool: PgPool) -> sqlx::Result<()> {
        // Insert a dirty account
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, dirty_at)
            VALUES ($1, true, NOW() - INTERVAL '24 hours')
            "#,
        )
        .bind("test.sputnik-dao.near")
        .execute(&pool)
        .await?;

        let network = NetworkConfig::mainnet();
        let mut active_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

        // Insert a fake in-flight task for this account
        let handle = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        });
        active_tasks.insert("test.sputnik-dao.near".to_string(), handle);

        // Run dirty monitor — should NOT spawn a duplicate task
        run_dirty_monitor(&pool, &network, None, &mut active_tasks).await;

        assert_eq!(
            active_tasks.len(),
            1,
            "Should still have exactly one task (the original)"
        );

        // Clean up
        for (_, handle) in active_tasks.drain() {
            handle.abort();
        }

        Ok(())
    }

    #[sqlx::test]
    async fn test_dirty_monitor_skips_disabled_accounts(pool: PgPool) -> sqlx::Result<()> {
        // Insert a dirty but disabled account
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, dirty_at)
            VALUES ($1, false, NOW() - INTERVAL '24 hours')
            "#,
        )
        .bind("test.sputnik-dao.near")
        .execute(&pool)
        .await?;

        let network = NetworkConfig::mainnet();
        let mut active_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

        run_dirty_monitor(&pool, &network, None, &mut active_tasks).await;

        assert!(
            active_tasks.is_empty(),
            "Should not spawn tasks for disabled accounts"
        );

        Ok(())
    }

    #[sqlx::test]
    async fn test_conditional_clear_respects_updated_dirty_at(pool: PgPool) -> sqlx::Result<()> {
        let original_dirty_at = Utc::now() - chrono::Duration::hours(24);

        // Insert a dirty account
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, dirty_at)
            VALUES ($1, true, $2)
            "#,
        )
        .bind("test.sputnik-dao.near")
        .bind(original_dirty_at)
        .execute(&pool)
        .await?;

        // Simulate the API re-dirtying the account (different timestamp)
        let new_dirty_at = Utc::now() - chrono::Duration::hours(48);
        sqlx::query(
            r#"
            UPDATE monitored_accounts SET dirty_at = $2 WHERE account_id = $1
            "#,
        )
        .bind("test.sputnik-dao.near")
        .bind(new_dirty_at)
        .execute(&pool)
        .await?;

        // Attempt conditional clear with the original dirty_at — should be a no-op
        let result = sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET dirty_at = NULL
            WHERE account_id = $1 AND dirty_at = $2
            "#,
        )
        .bind("test.sputnik-dao.near")
        .bind(original_dirty_at)
        .execute(&pool)
        .await?;

        assert_eq!(
            result.rows_affected(),
            0,
            "Conditional clear should be a no-op when dirty_at was updated"
        );

        // Verify dirty_at still has the new value
        let row: (Option<DateTime<Utc>>,) = sqlx::query_as(
            r#"
            SELECT dirty_at FROM monitored_accounts WHERE account_id = $1
            "#,
        )
        .bind("test.sputnik-dao.near")
        .fetch_one(&pool)
        .await?;

        assert!(
            row.0.is_some(),
            "dirty_at should still be set after failed conditional clear"
        );

        Ok(())
    }

    #[sqlx::test]
    async fn test_conditional_clear_succeeds_when_unchanged(pool: PgPool) -> sqlx::Result<()> {
        let original_dirty_at = Utc::now() - chrono::Duration::hours(24);

        // Insert a dirty account
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, dirty_at)
            VALUES ($1, true, $2)
            "#,
        )
        .bind("test.sputnik-dao.near")
        .bind(original_dirty_at)
        .execute(&pool)
        .await?;

        // Conditional clear with matching dirty_at — should succeed
        let result = sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET dirty_at = NULL
            WHERE account_id = $1 AND dirty_at = $2
            "#,
        )
        .bind("test.sputnik-dao.near")
        .bind(original_dirty_at)
        .execute(&pool)
        .await?;

        assert_eq!(
            result.rows_affected(),
            1,
            "Conditional clear should succeed when dirty_at is unchanged"
        );

        // Verify dirty_at is now NULL
        let row: (Option<DateTime<Utc>>,) = sqlx::query_as(
            r#"
            SELECT dirty_at FROM monitored_accounts WHERE account_id = $1
            "#,
        )
        .bind("test.sputnik-dao.near")
        .fetch_one(&pool)
        .await?;

        assert!(
            row.0.is_none(),
            "dirty_at should be NULL after successful conditional clear"
        );

        Ok(())
    }

    #[sqlx::test]
    async fn test_cleanup_finished_tasks(pool: PgPool) -> sqlx::Result<()> {
        let network = NetworkConfig::mainnet();
        let mut active_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

        // Insert a task that completes immediately
        let handle = tokio::spawn(async {});
        active_tasks.insert("finished.sputnik-dao.near".to_string(), handle);

        // Give the task a moment to finish
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Run dirty monitor — should clean up the finished task
        run_dirty_monitor(&pool, &network, None, &mut active_tasks).await;

        assert!(
            active_tasks.is_empty(),
            "Finished tasks should be cleaned up"
        );

        Ok(())
    }
}

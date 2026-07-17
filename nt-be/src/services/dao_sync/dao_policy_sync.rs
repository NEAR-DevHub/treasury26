//! DAO policy synchronization service
//!
//! Processes DAOs to extract member information from their policies.
//! Dirty DAOs are processed immediately (every 1 second check).
//! Stale DAOs are processed periodically (daily refresh).

use near_api::{AccountId, Contract, NetworkConfig};
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;

/// Max DAOs to process per cycle
const MAX_DAOS_PER_CYCLE: i64 = 50;

/// Period after which non-dirty DAOs should be re-synced (24 hours = daily)
const STALE_THRESHOLD_HOURS: i64 = 24;

/// Per-DAO RPC timeout for a single `get_policy` call. The dirty worker runs
/// `concurrency(1)` and syncs DAOs sequentially, so without a bound one hung
/// RPC would stall *all* dirty processing indefinitely.
const GET_POLICY_TIMEOUT: Duration = Duration::from_secs(30);

/// Process dirty DAOs (high priority)
///
/// Selects only DAOs that are *due* (`next_retry_at` in the past or unset) and
/// orders never-synced DAOs first, so a freshly created treasury is indexed
/// promptly instead of queuing behind DAOs that keep failing to sync. A
/// transient failure backs the DAO off (see [`record_transient_sync_failure`])
/// so it frees its slot instead of being retried every cycle.
pub async fn process_dirty_daos(
    pool: &PgPool,
    network: &NetworkConfig,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let dirty_daos = select_due_dirty_daos(pool, MAX_DAOS_PER_CYCLE).await?;

    let mut processed = 0;
    for dao_id in dirty_daos {
        match sync_dao_members(pool, network, &dao_id).await {
            Ok(_) => {
                processed += 1;
            }
            Err(e) => {
                let error_str = e.to_string();
                // Check if this is a permanent error (incompatible contract)
                if is_permanent_error(&error_str) {
                    tracing::warn!(
                        "DAO {} has incompatible contract, marking as failed: {}",
                        dao_id,
                        e
                    );
                    mark_dao_sync_failed(pool, &dao_id).await;
                } else {
                    // Transient: back the DAO off so it stops occupying a
                    // processing slot every cycle and can't starve fresh DAOs.
                    record_transient_sync_failure(pool, &dao_id, &error_str).await;
                }
            }
        }
        // Small delay between DAOs to avoid rate limiting
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Ok(processed)
}

/// Selects the dirty, non-failed DAOs that are due for a sync attempt.
///
/// `next_retry_at` in the future is skipped (a DAO backing off after a
/// transient failure), and never-synced DAOs (`last_policy_sync_at IS NULL`,
/// i.e. freshly created treasuries) are ordered first so they index promptly
/// even when older DAOs keep failing.
async fn select_due_dirty_daos(pool: &PgPool, limit: i64) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT dao_id FROM daos
        WHERE is_dirty = true AND sync_failed = false
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY last_policy_sync_at ASC NULLS FIRST,
                 next_retry_at ASC NULLS FIRST,
                 updated_at ASC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Records a transient sync failure: increments the attempt counter and defers
/// the next attempt with exponential backoff (30s, 60s, … capped at 1h). The
/// DAO stays `is_dirty = true` and is **not** marked `sync_failed`, so it keeps
/// retrying (and self-heals once the transient condition clears) without
/// blocking every cycle — the due-filter in [`process_dirty_daos`] skips it
/// until `next_retry_at`.
async fn record_transient_sync_failure(pool: &PgPool, dao_id: &str, error: &str) {
    // Backoff uses the pre-increment attempt count (SET reads old row values):
    // 30·2^min(attempts,7)s, capped at 3600s. `min(_, 7)` avoids the pow
    // exploding before the cap clamps it.
    let updated = sqlx::query!(
        r#"
        UPDATE daos
        SET sync_attempts = sync_attempts + 1,
            next_retry_at = NOW() + make_interval(
                secs => LEAST(30.0 * (2 ^ LEAST(sync_attempts, 7)), 3600.0)
            )
        WHERE dao_id = $1
        RETURNING sync_attempts, next_retry_at
        "#,
        dao_id
    )
    .fetch_optional(pool)
    .await;

    match updated {
        Ok(Some(row)) => tracing::warn!(
            dao_id,
            attempt = row.sync_attempts,
            next_retry_at = ?row.next_retry_at,
            "Failed to sync DAO (transient); backing off: {error}"
        ),
        Ok(None) => tracing::warn!(dao_id, "Failed to sync DAO but row vanished: {error}"),
        Err(e) => tracing::error!(dao_id, "Failed to record DAO sync backoff: {e}"),
    }
}

/// Process stale DAOs (low priority, daily refresh)
pub async fn process_stale_daos(
    pool: &PgPool,
    network: &NetworkConfig,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let stale_daos: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT d.dao_id FROM daos d
        INNER JOIN monitored_accounts ma ON ma.account_id = d.dao_id AND ma.enabled = true
        WHERE d.is_dirty = false AND d.sync_failed = false
          AND (d.last_policy_sync_at IS NULL
               OR d.last_policy_sync_at < NOW() - INTERVAL '1 hour' * $1)
        ORDER BY d.last_policy_sync_at ASC NULLS FIRST
        LIMIT $2
        "#,
    )
    .bind(STALE_THRESHOLD_HOURS)
    .bind(MAX_DAOS_PER_CYCLE / 2) // Lower priority than dirty
    .fetch_all(pool)
    .await?;

    let mut processed = 0;
    for dao_id in stale_daos {
        match sync_dao_members(pool, network, &dao_id).await {
            Ok(_) => {
                processed += 1;
            }
            Err(e) => {
                let error_str = e.to_string();
                if is_permanent_error(&error_str) {
                    tracing::warn!(
                        "DAO {} has incompatible contract, marking as failed: {}",
                        dao_id,
                        e
                    );
                    mark_dao_sync_failed(pool, &dao_id).await;
                } else {
                    tracing::warn!("Failed to refresh DAO {}: {}", dao_id, e);
                }
            }
        }
        // Small delay between DAOs to avoid rate limiting
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    Ok(processed)
}

/// Check if an error is permanent (contract is incompatible)
fn is_permanent_error(error: &str) -> bool {
    error.contains("Cannot deserialize")
        || error.contains("Borsh")
        || error.contains("MethodNotFound")
        || error.contains("CodeDoesNotExist")
}

/// Mark a DAO as having failed sync
async fn mark_dao_sync_failed(pool: &PgPool, dao_id: &str) {
    if let Err(e) = sqlx::query!(
        r#"
        UPDATE daos
        SET sync_failed = true, is_dirty = false
        WHERE dao_id = $1
        "#,
        dao_id
    )
    .execute(pool)
    .await
    {
        tracing::error!("Failed to mark DAO {} as sync_failed: {}", dao_id, e);
    }
}

/// Sync members for a single DAO
///
/// Fetches the DAO policy, extracts members from roles, and updates the database.
async fn sync_dao_members(
    pool: &PgPool,
    network: &NetworkConfig,
    dao_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let account_id: AccountId = dao_id.parse()?;

    // Fetch policy from the DAO contract, bounded so a hung RPC can't stall the
    // single-threaded dirty worker forever.
    let policy_future = Contract(account_id.clone())
        .call_function("get_policy", ())
        .read_only::<serde_json::Value>()
        .fetch_from(network);
    let policy = tokio::time::timeout(GET_POLICY_TIMEOUT, policy_future)
        .await
        .map_err(|_| -> Box<dyn std::error::Error + Send + Sync> {
            format!("get_policy timed out after {GET_POLICY_TIMEOUT:?}").into()
        })??
        .data;

    // Extract unique members from roles (no duplicates)
    let members = extract_members_from_policy(&policy);

    tracing::debug!("DAO {}: extracted {} unique members", dao_id, members.len());

    // Transaction: reconcile policy members without deleting user-saved rows
    let mut tx = pool.begin().await?;

    let members_vec: Vec<String> = members.into_iter().collect();
    reconcile_policy_membership(&mut tx, dao_id, &members_vec).await?;

    // Mark DAO as clean, update sync timestamp, and clear any backoff so a
    // DAO that failed transiently before is treated as fresh next time.
    sqlx::query!(
        r#"
        UPDATE daos
        SET is_dirty = false,
            last_policy_sync_at = NOW(),
            sync_attempts = 0,
            next_retry_at = NULL
        WHERE dao_id = $1
        "#,
        dao_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(())
}

async fn reconcile_policy_membership(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    dao_id: &str,
    members_vec: &[String],
) -> Result<(), sqlx::Error> {
    // Upsert current policy members as active policy members.
    // Keep user-managed flags (is_saved / is_hidden) untouched.
    if !members_vec.is_empty() {
        let dao_ids: Vec<String> = vec![dao_id.to_string(); members_vec.len()];
        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member)
            SELECT unnest($1::text[]), unnest($2::text[]), true
            ON CONFLICT (dao_id, account_id) DO UPDATE
            SET is_policy_member = true
            "#,
            &dao_ids,
            members_vec
        )
        .execute(&mut **tx)
        .await?;
    }

    // Mark previous policy members that are no longer in policy as inactive policy members.
    if members_vec.is_empty() {
        sqlx::query!(
            r#"
            UPDATE dao_members
            SET is_policy_member = false
            WHERE dao_id = $1
              AND is_policy_member = true
            "#,
            dao_id
        )
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query!(
            r#"
            UPDATE dao_members
            SET is_policy_member = false
            WHERE dao_id = $1
              AND is_policy_member = true
              AND NOT (account_id = ANY($2::text[]))
            "#,
            dao_id,
            members_vec
        )
        .execute(&mut **tx)
        .await?;
    }

    // Cleanup rows no longer used by policy and not explicitly saved by user.
    sqlx::query!(
        r#"
        DELETE FROM dao_members
        WHERE dao_id = $1
          AND is_policy_member = false
          AND is_saved = false
        "#,
        dao_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/// Extract unique members from a DAO policy
///
/// Returns a set of unique account_ids (no role information).
fn extract_members_from_policy(policy: &serde_json::Value) -> HashSet<String> {
    let mut members = HashSet::new();

    if let Some(roles) = policy.get("roles").and_then(|r| r.as_array()) {
        for role in roles {
            // Extract Group members: { "kind": { "Group": ["account1", "account2"] } }
            if let Some(kind) = role.get("kind")
                && let Some(group) = kind.get("Group").and_then(|g| g.as_array())
            {
                for account in group {
                    if let Some(account_str) = account.as_str() {
                        members.insert(account_str.to_string());
                    }
                }
            }
        }
    }

    members
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    #[test]
    fn test_extract_members_from_policy() {
        let policy = serde_json::json!({
            "roles": [
                {
                    "name": "Requestor",
                    "kind": { "Group": ["alice.near", "bob.near"] }
                },
                {
                    "name": "Admin",
                    "kind": { "Group": ["admin.near", "alice.near"] }  // alice appears twice
                },
                {
                    "name": "Everyone",
                    "kind": "Everyone"
                }
            ]
        });

        let members = extract_members_from_policy(&policy);

        assert_eq!(members.len(), 3, "Should extract 3 unique members");
        assert!(members.contains("alice.near"), "Should contain alice");
        assert!(members.contains("bob.near"), "Should contain bob");
        assert!(members.contains("admin.near"), "Should contain admin");
    }

    #[test]
    fn test_extract_members_empty_policy() {
        let policy = serde_json::json!({});
        let members = extract_members_from_policy(&policy);
        assert!(members.is_empty(), "Should return empty for empty policy");
    }

    #[test]
    fn test_is_permanent_error() {
        assert!(is_permanent_error("Cannot deserialize value with Borsh"));
        assert!(is_permanent_error("MethodNotFound: get_policy"));
        assert!(is_permanent_error("CodeDoesNotExist"));
        assert!(!is_permanent_error("Network timeout"));
        assert!(!is_permanent_error("Connection refused"));
    }

    #[sqlx::test]
    async fn test_reconcile_policy_membership_preserves_saved_guest_rows(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let dao_id = "test-dao.sputnik-dao.near";

        sqlx::query!(
            r#"
            INSERT INTO daos (dao_id, is_dirty, source)
            VALUES ($1, true, 'manual')
            "#,
            dao_id
        )
        .execute(&pool)
        .await?;

        // Existing saved guest row (not policy member) should survive reconciliation.
        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ($1, 'guest.near', false, true, false)
            "#,
            dao_id
        )
        .execute(&pool)
        .await?;

        let mut tx = pool.begin().await?;
        let members = vec!["member1.near".to_string(), "member2.near".to_string()];
        reconcile_policy_membership(&mut tx, dao_id, &members).await?;
        tx.commit().await?;

        let guest = sqlx::query!(
            r#"
            SELECT is_policy_member, is_saved, is_hidden
            FROM dao_members
            WHERE dao_id = $1 AND account_id = 'guest.near'
            "#,
            dao_id
        )
        .fetch_one(&pool)
        .await?;
        assert!(
            !guest.is_policy_member,
            "Guest should remain non-policy member"
        );
        assert!(guest.is_saved, "Guest should remain saved");
        assert!(!guest.is_hidden, "Guest visibility should be preserved");

        let members_count = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) as "count!"
            FROM dao_members
            WHERE dao_id = $1 AND is_policy_member = true
            "#,
            dao_id
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(members_count, 2, "Should upsert both policy members");

        Ok(())
    }

    #[sqlx::test]
    async fn test_reconcile_policy_membership_removes_unsaved_removed_members(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let dao_id = "test-dao-cleanup.sputnik-dao.near";

        sqlx::query!(
            r#"
            INSERT INTO daos (dao_id, is_dirty, source)
            VALUES ($1, true, 'manual')
            "#,
            dao_id
        )
        .execute(&pool)
        .await?;

        // Previously policy-managed member
        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ($1, 'old-member.near', true, false, false)
            "#,
            dao_id
        )
        .execute(&pool)
        .await?;

        // Saved non-policy row should survive cleanup
        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id, is_policy_member, is_saved, is_hidden)
            VALUES ($1, 'saved.near', false, true, false)
            "#,
            dao_id
        )
        .execute(&pool)
        .await?;

        let mut tx = pool.begin().await?;
        let members: Vec<String> = Vec::new();
        reconcile_policy_membership(&mut tx, dao_id, &members).await?;
        tx.commit().await?;

        let removed_count = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) as "count!"
            FROM dao_members
            WHERE dao_id = $1 AND account_id = 'old-member.near'
            "#,
            dao_id
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(removed_count, 0, "Unsaved removed member should be deleted");

        let saved_count = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) as "count!"
            FROM dao_members
            WHERE dao_id = $1 AND account_id = 'saved.near'
            "#,
            dao_id
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(saved_count, 1, "Saved row should remain");

        Ok(())
    }

    /// Inserts a dirty DAO row with explicit sync state for selection tests.
    async fn insert_dirty_dao(
        pool: &PgPool,
        dao_id: &str,
        last_policy_sync_at: Option<&str>,
        next_retry_at_sql: &str,
    ) -> sqlx::Result<()> {
        let query = format!(
            r#"
            INSERT INTO daos (dao_id, is_dirty, sync_failed, source, last_policy_sync_at, next_retry_at)
            VALUES ($1, true, false, 'factory', {}, {})
            "#,
            last_policy_sync_at
                .map(|t| format!("'{t}'::timestamptz"))
                .unwrap_or_else(|| "NULL".to_string()),
            next_retry_at_sql,
        );
        sqlx::query(&query).bind(dao_id).execute(pool).await?;
        Ok(())
    }

    #[sqlx::test]
    async fn test_select_due_prioritizes_never_synced_and_skips_backed_off(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        // Never-synced (new treasury) — should come first.
        insert_dirty_dao(&pool, "new.sputnik-dao.near", None, "NULL").await?;
        // Synced long ago, due now — should come after the never-synced one.
        insert_dirty_dao(
            &pool,
            "old.sputnik-dao.near",
            Some("2020-01-01T00:00:00Z"),
            "NULL",
        )
        .await?;
        // Backed off into the future — should be skipped entirely.
        insert_dirty_dao(
            &pool,
            "backing-off.sputnik-dao.near",
            None,
            "NOW() + INTERVAL '1 hour'",
        )
        .await?;

        let due = select_due_dirty_daos(&pool, 50).await?;

        assert_eq!(
            due,
            vec![
                "new.sputnik-dao.near".to_string(),
                "old.sputnik-dao.near".to_string()
            ],
            "never-synced DAO first, backed-off DAO excluded"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_transient_failure_backs_off_and_success_resets(pool: PgPool) -> sqlx::Result<()> {
        let dao_id = "flaky.sputnik-dao.near";
        insert_dirty_dao(&pool, dao_id, None, "NULL").await?;

        record_transient_sync_failure(&pool, dao_id, "network timeout").await;

        let row = sqlx::query!(
            r#"SELECT sync_attempts, is_dirty, sync_failed, next_retry_at FROM daos WHERE dao_id = $1"#,
            dao_id
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(row.sync_attempts, 1, "attempt counter incremented");
        assert!(row.is_dirty, "still dirty (keeps retrying)");
        assert!(
            !row.sync_failed,
            "transient failure does not mark sync_failed"
        );
        assert!(
            row.next_retry_at.is_some(),
            "backoff deferred the next attempt"
        );

        // A backed-off DAO is not due yet.
        assert!(
            select_due_dirty_daos(&pool, 50).await?.is_empty(),
            "backed-off DAO excluded from due set"
        );

        // Simulate a later successful sync clearing the backoff.
        sqlx::query!(
            r#"
            UPDATE daos
            SET is_dirty = false, last_policy_sync_at = NOW(),
                sync_attempts = 0, next_retry_at = NULL
            WHERE dao_id = $1
            "#,
            dao_id
        )
        .execute(&pool)
        .await?;

        let row = sqlx::query!(
            r#"SELECT sync_attempts, next_retry_at, is_dirty FROM daos WHERE dao_id = $1"#,
            dao_id
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(row.sync_attempts, 0, "attempts reset on success");
        assert!(row.next_retry_at.is_none(), "backoff cleared on success");
        assert!(!row.is_dirty, "clean after success");
        Ok(())
    }

    #[sqlx::test]
    async fn test_backoff_grows_and_caps_at_one_hour(pool: PgPool) -> sqlx::Result<()> {
        let dao_id = "persistently-failing.sputnik-dao.near";
        insert_dirty_dao(&pool, dao_id, None, "NULL").await?;

        // Drive many failures; the deferral must never exceed ~1h (3600s).
        for _ in 0..12 {
            record_transient_sync_failure(&pool, dao_id, "still failing").await;
            let secs: f64 = sqlx::query_scalar(
                r#"SELECT EXTRACT(EPOCH FROM (next_retry_at - NOW()))::float8 FROM daos WHERE dao_id = $1"#,
            )
            .bind(dao_id)
            .fetch_one(&pool)
            .await?;
            assert!(secs <= 3601.0, "backoff must cap at 1 hour, got {secs}s");
        }

        let attempts: i32 =
            sqlx::query_scalar(r#"SELECT sync_attempts FROM daos WHERE dao_id = $1"#)
                .bind(dao_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(attempts, 12, "every failure counted");
        // Never escalates to sync_failed: a transient outage must self-heal.
        let sync_failed: bool =
            sqlx::query_scalar(r#"SELECT sync_failed FROM daos WHERE dao_id = $1"#)
                .bind(dao_id)
                .fetch_one(&pool)
                .await?;
        assert!(!sync_failed, "transient failures never become permanent");
        Ok(())
    }
}

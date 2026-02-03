//! DAO policy synchronization service
//!
//! Processes DAOs to extract member information from their policies.
//! Dirty DAOs are processed immediately (every 1 second check).
//! Stale DAOs are processed periodically (daily refresh).

use near_api::{AccountId, Contract, NetworkConfig};
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;

/// Interval between policy sync checks (1 second for quick dirty processing)
const POLICY_SYNC_INTERVAL_SECS: u64 = 1;

/// Max DAOs to process per cycle
const MAX_DAOS_PER_CYCLE: i64 = 50;

/// Period after which non-dirty DAOs should be re-synced (24 hours = daily)
const STALE_THRESHOLD_HOURS: i64 = 24;

/// Run the background DAO policy sync service
///
/// This function runs in a loop, processing dirty DAOs immediately
/// and stale DAOs periodically.
pub async fn run_dao_policy_sync_service(pool: PgPool, network: NetworkConfig) {
    log::info!(
        "Starting DAO policy sync service (interval: {} seconds)",
        POLICY_SYNC_INTERVAL_SECS
    );

    // Initial delay to let server and DAO list sync start
    tokio::time::sleep(Duration::from_secs(15)).await;

    let mut interval = tokio::time::interval(Duration::from_secs(POLICY_SYNC_INTERVAL_SECS));

    loop {
        interval.tick().await;

        // Process dirty DAOs first (high priority)
        match process_dirty_daos(&pool, &network).await {
            Ok(count) if count > 0 => log::info!("Processed {} dirty DAOs", count),
            Ok(_) => {}
            Err(e) => log::error!("Error processing dirty DAOs: {}", e),
        }

        // Process stale DAOs (low priority, periodic refresh)
        // Only run every 60 seconds to avoid overwhelming with stale processing
        static mut STALE_COUNTER: u64 = 0;
        unsafe {
            STALE_COUNTER += 1;
            if STALE_COUNTER >= 60 {
                STALE_COUNTER = 0;
                match process_stale_daos(&pool, &network).await {
                    Ok(count) if count > 0 => log::info!("Refreshed {} stale DAOs", count),
                    Ok(_) => {}
                    Err(e) => log::error!("Error processing stale DAOs: {}", e),
                }
            }
        }
    }
}

/// Process dirty DAOs (high priority)
async fn process_dirty_daos(
    pool: &PgPool,
    network: &NetworkConfig,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let dirty_daos: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT dao_id FROM daos
        WHERE is_dirty = true AND sync_failed = false
        ORDER BY updated_at ASC
        LIMIT $1
        "#,
    )
    .bind(MAX_DAOS_PER_CYCLE)
    .fetch_all(pool)
    .await?;

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
                    log::warn!(
                        "DAO {} has incompatible contract, marking as failed: {}",
                        dao_id,
                        e
                    );
                    mark_dao_sync_failed(pool, &dao_id).await;
                } else {
                    log::warn!("Failed to sync DAO {}: {}", dao_id, e);
                }
            }
        }
        // Small delay between DAOs to avoid rate limiting
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Ok(processed)
}

/// Process stale DAOs (low priority, daily refresh)
async fn process_stale_daos(
    pool: &PgPool,
    network: &NetworkConfig,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let stale_daos: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT dao_id FROM daos
        WHERE is_dirty = false AND sync_failed = false
          AND (last_policy_sync_at IS NULL
               OR last_policy_sync_at < NOW() - INTERVAL '1 hour' * $1)
        ORDER BY last_policy_sync_at ASC NULLS FIRST
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
                    log::warn!(
                        "DAO {} has incompatible contract, marking as failed: {}",
                        dao_id,
                        e
                    );
                    mark_dao_sync_failed(pool, &dao_id).await;
                } else {
                    log::warn!("Failed to refresh DAO {}: {}", dao_id, e);
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
        log::error!("Failed to mark DAO {} as sync_failed: {}", dao_id, e);
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

    // Fetch policy from the DAO contract
    let policy = Contract(account_id.clone())
        .call_function("get_policy", ())
        .read_only::<serde_json::Value>()
        .fetch_from(network)
        .await?
        .data;

    // Extract unique members from roles (no duplicates)
    let members = extract_members_from_policy(&policy);

    log::debug!("DAO {}: extracted {} unique members", dao_id, members.len());

    // Transaction: clear old members and insert new ones
    let mut tx = pool.begin().await?;

    // Delete existing members for this DAO
    sqlx::query!("DELETE FROM dao_members WHERE dao_id = $1", dao_id)
        .execute(&mut *tx)
        .await?;

    // Insert new members using batch insert
    if !members.is_empty() {
        let members_vec: Vec<String> = members.into_iter().collect();
        let dao_ids: Vec<String> = vec![dao_id.to_string(); members_vec.len()];

        sqlx::query!(
            r#"
            INSERT INTO dao_members (dao_id, account_id)
            SELECT unnest($1::text[]), unnest($2::text[])
            ON CONFLICT (dao_id, account_id) DO NOTHING
            "#,
            &dao_ids,
            &members_vec
        )
        .execute(&mut *tx)
        .await?;
    }

    // Mark DAO as clean and update sync timestamp
    sqlx::query!(
        r#"
        UPDATE daos
        SET is_dirty = false, last_policy_sync_at = NOW()
        WHERE dao_id = $1
        "#,
        dao_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

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
}

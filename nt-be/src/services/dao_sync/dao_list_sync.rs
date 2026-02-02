//! DAO list synchronization service
//!
//! Fetches the list of all DAOs from sputnik-dao.near factory contract every 5 minutes
//! and populates the local database. New DAOs are marked as dirty for immediate processing.

use near_api::{Contract, NetworkConfig};
use sqlx::PgPool;
use std::time::Duration;

/// Interval between DAO list sync cycles (5 minutes)
const DAO_LIST_SYNC_INTERVAL_SECS: u64 = 300;

/// Sputnik DAO factory contract
const SPUTNIK_DAO_FACTORY: &str = "sputnik-dao.near";

/// Run the background DAO list sync service
///
/// This function runs in a loop, fetching the complete DAO list from sputnik-dao.near
/// every 5 minutes and upserting into the local database.
pub async fn run_dao_list_sync_service(pool: PgPool, network: NetworkConfig) {
    log::info!(
        "Starting DAO list sync service (interval: {} seconds)",
        DAO_LIST_SYNC_INTERVAL_SECS
    );

    // Initial delay to let server start
    tokio::time::sleep(Duration::from_secs(10)).await;

    let mut interval = tokio::time::interval(Duration::from_secs(DAO_LIST_SYNC_INTERVAL_SECS));

    loop {
        interval.tick().await;

        log::info!("Running DAO list sync cycle...");

        match sync_dao_list(&pool, &network).await {
            Ok(count) => log::info!("DAO list sync complete: {} DAOs synced", count),
            Err(e) => log::error!("DAO list sync failed: {}", e),
        }
    }
}

/// Sync DAO list from sputnik-dao.near factory
///
/// Fetches all DAOs and upserts them into the database.
/// New DAOs are automatically marked as dirty via the default value.
async fn sync_dao_list(
    pool: &PgPool,
    network: &NetworkConfig,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let factory_account: near_api::AccountId = SPUTNIK_DAO_FACTORY.parse()?;

    // Fetch all DAOs from the factory contract (no pagination)
    let all_daos: Vec<String> = Contract(factory_account)
        .call_function("get_dao_list", ())
        .read_only::<Vec<String>>()
        .fetch_from(network)
        .await?
        .data;

    log::info!(
        "Fetched {} DAOs from {}",
        all_daos.len(),
        SPUTNIK_DAO_FACTORY
    );

    if all_daos.is_empty() {
        return Ok(0);
    }

    // Insert new DAOs with dirty=true, update existing ones' last_seen_at
    let result = sqlx::query!(
        r#"
        INSERT INTO daos (dao_id, is_dirty, source)
        SELECT unnest($1::text[]), true, 'factory'
        ON CONFLICT (dao_id) DO UPDATE SET
            updated_at = NOW()
        "#,
        &all_daos
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

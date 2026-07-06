//! DAO list synchronization service
//!
//! Fetches the list of all DAOs from sputnik-dao.near factory contract every 5 minutes
//! and populates the local database. New DAOs are marked as dirty for immediate processing.

use near_api::{Contract, NetworkConfig};
use sqlx::PgPool;

/// Sputnik DAO factory contract
const SPUTNIK_DAO_FACTORY: &str = "sputnik-dao.near";

/// Sync DAO list from sputnik-dao.near factory
///
/// Fetches all DAOs and upserts them into the database.
/// New DAOs are automatically marked as dirty via the default value.
pub async fn sync_dao_list(
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

    tracing::info!(
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

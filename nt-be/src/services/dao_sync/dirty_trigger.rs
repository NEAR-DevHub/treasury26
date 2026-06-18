//! Functions to mark DAOs as dirty when policy changes
//!
//! These functions are called from various parts of the application
//! to trigger immediate re-sync of DAO membership data.

use sqlx::PgPool;
use std::time::Duration;

/// Mark a DAO as dirty (needs re-sync)
///
/// Called when:
/// - A policy-related proposal is voted on
/// - Manual trigger via API
///
/// Returns Ok(true) if DAO was marked dirty, Ok(false) if DAO doesn't exist.
pub async fn mark_dao_dirty(pool: &PgPool, dao_id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query!(
        r#"
        UPDATE daos SET is_dirty = true WHERE dao_id = $1
        "#,
        dao_id
    )
    .execute(pool)
    .await?;

    if result.rows_affected() > 0 {
        tracing::info!("Marked DAO {} as dirty", dao_id);
        Ok(true)
    } else {
        tracing::debug!("DAO {} not found in database", dao_id);
        Ok(false)
    }
}

/// Register a newly created DAO
///
/// Called after successful treasury creation to ensure immediate visibility.
/// If the DAO already exists (e.g., from factory sync), it marks it as dirty.
pub async fn register_new_dao(pool: &PgPool, dao_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        INSERT INTO daos (dao_id, is_dirty, source)
        VALUES ($1, true, 'manual')
        ON CONFLICT (dao_id) DO UPDATE SET
            is_dirty = true,
            updated_at = NOW()
        "#,
        dao_id
    )
    .execute(pool)
    .await?;

    tracing::info!("Registered/marked DAO {} as dirty", dao_id);
    Ok(())
}

/// Register a newly created DAO and wait until sync completes.
///
/// Polls every 500ms, gives up after `timeout`. Returns `Ok(true)` if sync
/// finished in time, `Ok(false)` if timed out.
pub async fn register_new_dao_and_wait(
    pool: &PgPool,
    dao_id: &str,
    timeout: Duration,
) -> Result<bool, sqlx::Error> {
    register_new_dao(pool, dao_id).await?;
    wait_for_sync(pool, dao_id, timeout).await
}

/// Poll until `is_dirty` becomes false for given DAO.
async fn wait_for_sync(
    pool: &PgPool,
    dao_id: &str,
    timeout: Duration,
) -> Result<bool, sqlx::Error> {
    let start = tokio::time::Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;

        let still_dirty: bool =
            sqlx::query_scalar::<_, bool>(r#"SELECT is_dirty FROM daos WHERE dao_id = $1"#)
                .bind(dao_id)
                .fetch_optional(pool)
                .await?
                .unwrap_or(true);

        if !still_dirty {
            return Ok(true);
        }
        if start.elapsed() >= timeout {
            tracing::warn!(
                "Timed out waiting for DAO {} sync after {:?}",
                dao_id,
                timeout
            );
            return Ok(false);
        }
    }
}

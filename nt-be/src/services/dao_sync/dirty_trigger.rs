//! Functions to mark DAOs as dirty when policy changes
//!
//! These functions are called from various parts of the application
//! to trigger immediate re-sync of DAO membership data.

use sqlx::PgPool;

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
        log::info!("Marked DAO {} as dirty", dao_id);
        Ok(true)
    } else {
        log::debug!("DAO {} not found in database", dao_id);
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

    log::info!("Registered/marked DAO {} as dirty", dao_id);
    Ok(())
}

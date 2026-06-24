use serde_json::Value;

use crate::{AppState, utils::cache::Cache, utils::cache::CacheKey};

pub async fn invalidate_warnings_cache(state: &AppState) {
    invalidate_warnings_cache_for(&state.cache).await;
}

pub async fn invalidate_warnings_cache_for(cache: &Cache) {
    let cache_key = CacheKey::new("public-warnings").build();
    cache.short_term.invalidate(&cache_key).await;
}

pub async fn insert_audit_log(
    pool: &sqlx::PgPool,
    warning_id: Option<i32>,
    action: &str,
    changed_by: &str,
    changes: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO warning_audit_log (warning_id, action, changed_by, changes)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(warning_id)
    .bind(action)
    .bind(changed_by)
    .bind(changes)
    .execute(pool)
    .await?;

    Ok(())
}

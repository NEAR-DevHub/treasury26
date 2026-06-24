use serde_json::{Value, json};

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

pub async fn delete_warning_with_audit(
    pool: &sqlx::PgPool,
    id: i32,
    changed_by: &str,
    changes: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM warning_slots WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;

    insert_audit_log(pool, None, "deleted", changed_by, changes).await
}

pub fn audit_delete_changes(
    id: i32,
    slot: Option<String>,
    token: Option<String>,
    network: Option<String>,
    extra: Value,
) -> Value {
    let mut changes = match extra {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    changes.insert("id".to_string(), json!(id));
    if let Some(slot) = slot {
        changes.insert("slot".to_string(), json!(slot));
    }
    if let Some(token) = token {
        changes.insert("token".to_string(), json!(token));
    }
    if let Some(network) = network {
        changes.insert("network".to_string(), json!(network));
    }
    Value::Object(changes)
}

use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{AppState, utils::cache::Cache, utils::cache::CacheKey};

#[derive(Debug, Clone, Copy)]
pub enum AuditAction {
    Created,
    Activated,
    Updated,
    Deleted,
    Scheduled,
}

impl AuditAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Activated => "activated",
            Self::Updated => "updated",
            Self::Deleted => "deleted",
            Self::Scheduled => "scheduled",
        }
    }
}

pub async fn invalidate_warnings_cache(state: &AppState) {
    invalidate_warnings_cache_for(&state.cache).await;
}

pub async fn invalidate_warnings_cache_for(cache: &Cache) {
    let cache_key = CacheKey::new("public-warnings").build();
    cache.short_term.invalidate(&cache_key).await;
}

pub async fn insert_audit_log<'a>(
    executor: impl sqlx::Executor<'a, Database = Postgres>,
    warning_id: Option<i32>,
    action: AuditAction,
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
    .bind(action.as_str())
    .bind(changed_by)
    .bind(changes)
    .execute(executor)
    .await?;

    Ok(())
}

pub async fn delete_warning_with_audit(
    pool: &PgPool,
    id: i32,
    changed_by: &str,
    changes: Value,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    delete_warning_with_audit_in_tx(&mut tx, id, changed_by, changes).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn delete_warning_with_audit_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    id: i32,
    changed_by: &str,
    changes: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM warning_slots WHERE id = $1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    insert_audit_log(&mut **tx, None, AuditAction::Deleted, changed_by, changes).await?;
    Ok(())
}

pub async fn find_conflicting_warning_id<'e, E>(
    executor: E,
    except_id: Option<i32>,
    slot: &Option<String>,
    token: &Option<String>,
    network: &Option<String>,
) -> Result<Option<i32>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query_scalar(
        r#"
        SELECT id
        FROM warning_slots
        WHERE ($1::int IS NULL OR id != $1)
          AND COALESCE(slot, '') = COALESCE($2, '')
          AND COALESCE(token, '') = COALESCE($3, '')
          AND COALESCE(network, '') = COALESCE($4, '')
        LIMIT 1
        "#,
    )
    .bind(except_id)
    .bind(slot)
    .bind(token)
    .bind(network)
    .fetch_optional(executor)
    .await
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

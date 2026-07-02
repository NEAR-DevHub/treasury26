use std::time::Duration;

use apalis_sql::{Config, postgres::PostgresStorage};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::PgPool;

pub fn storage<T>(pool: PgPool, namespace: &'static str, buffer_size: usize) -> PostgresStorage<T>
where
    T: Serialize + DeserializeOwned + Send + Sync + Unpin + 'static,
{
    let config = Config::new(namespace)
        .set_buffer_size(buffer_size)
        .set_poll_interval(Duration::from_millis(100));
    PostgresStorage::new_with_config(pool, config)
}

pub async fn setup(_pool: &PgPool) -> Result<(), sqlx::Error> {
    // Apalis ships its own sqlx migrator, but it records rows in the same
    // `_sqlx_migrations` table as the app. The Apalis schema is managed by
    // app migrations instead so SQLx migration history has one owner.
    Ok(())
}

pub async fn create_inflight_job_key_index(
    pool: &PgPool,
    index_name: &str,
    namespaces: &[&str],
    job_key_field: &str,
) -> Result<(), sqlx::Error> {
    assert_safe_sql_identifier(index_name);
    assert_safe_json_key(job_key_field);
    assert!(!namespaces.is_empty(), "job namespaces must not be empty");

    let namespace_literals = namespaces
        .iter()
        .map(|namespace| format!("'{}'", namespace.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS {index_name}
        ON apalis.jobs (job_type, ((job->>'{job_key_field}')))
        WHERE job_type IN ({namespace_literals})
          AND status IN ('Pending', 'Running')
          AND job ? '{job_key_field}'
        "#
    );

    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

pub async fn active_job_exists(
    pool: &PgPool,
    namespace: &str,
    job_key_field: &str,
    job_key: &str,
) -> Result<bool, sqlx::Error> {
    assert_safe_json_key(job_key_field);

    let sql = format!(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM apalis.jobs
            WHERE job_type = $1
              AND job->>'{job_key_field}' = $2
              AND (
                  status IN ('Pending', 'Running')
                  OR (status = 'Failed' AND attempts < max_attempts)
              )
        )
        "#
    );

    sqlx::query_scalar::<_, bool>(&sql)
        .bind(namespace)
        .bind(job_key)
        .fetch_one(pool)
        .await
}

pub fn is_unique_violation_on(error: &sqlx::Error, constraint_name: &str) -> bool {
    match error {
        sqlx::Error::Database(db_error) => {
            db_error.constraint() == Some(constraint_name)
                || db_error.message().contains(constraint_name)
        }
        _ => false,
    }
}

fn assert_safe_sql_identifier(value: &str) {
    assert!(
        is_safe_name(value),
        "SQL identifier must contain only ASCII letters, digits, and underscores"
    );
}

fn assert_safe_json_key(value: &str) {
    assert!(
        is_safe_name(value),
        "JSON key must contain only ASCII letters, digits, and underscores"
    );
}

fn is_safe_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

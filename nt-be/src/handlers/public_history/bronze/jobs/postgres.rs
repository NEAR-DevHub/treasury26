use sqlx::PgPool;

pub(crate) const PUBLIC_HISTORY_LATEST_NAMESPACE: &str = "public_history_latest";
pub(crate) const PUBLIC_HISTORY_BACKFILL_NAMESPACE: &str = "public_history_backfill";

pub(crate) const PUBLIC_HISTORY_JOB_KEY_FIELD: &str = "job_key";
pub(crate) const PUBLIC_HISTORY_INFLIGHT_INDEX: &str = "idx_public_history_jobs_inflight_key";

pub(crate) async fn setup_public_history_jobs(pool: &PgPool) -> Result<(), sqlx::Error> {
    let namespace_literals = [
        PUBLIC_HISTORY_LATEST_NAMESPACE,
        PUBLIC_HISTORY_BACKFILL_NAMESPACE,
    ]
    .iter()
    .map(|namespace| format!("'{}'", namespace.replace('\'', "''")))
    .collect::<Vec<_>>()
    .join(", ");

    let sql = format!(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS {PUBLIC_HISTORY_INFLIGHT_INDEX}
        ON apalis.jobs (job_type, ((metadata->>'{PUBLIC_HISTORY_JOB_KEY_FIELD}')))
        WHERE job_type IN ({namespace_literals})
          AND status IN ('Pending', 'Queued', 'Running')
          AND metadata ? '{PUBLIC_HISTORY_JOB_KEY_FIELD}'
        "#
    );

    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

pub(crate) async fn active_public_history_job_exists(
    pool: &PgPool,
    namespace: &str,
    job_key: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM apalis.jobs
            WHERE job_type = $1
              AND metadata->>'job_key' = $2
              AND (
                  status IN ('Pending', 'Queued', 'Running')
                  OR (status = 'Failed' AND attempts < max_attempts)
              )
        )
        "#,
    )
    .bind(namespace)
    .bind(job_key)
    .fetch_one(pool)
    .await
}

pub(crate) fn is_unique_violation_on(error: &sqlx::Error, constraint_name: &str) -> bool {
    match error {
        sqlx::Error::Database(db_error) => {
            db_error.constraint() == Some(constraint_name)
                || db_error.message().contains(constraint_name)
        }
        _ => false,
    }
}

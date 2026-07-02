use sqlx::PgPool;

pub(crate) const PUBLIC_HISTORY_LATEST_NAMESPACE: &str = "public_history_latest";
pub(crate) const PUBLIC_HISTORY_BACKFILL_NAMESPACE: &str = "public_history_backfill";

pub(crate) const PUBLIC_HISTORY_JOB_KEY_FIELD: &str = "job_key";
pub(crate) const PUBLIC_HISTORY_INFLIGHT_INDEX: &str = "idx_public_history_jobs_inflight_key";

pub(crate) async fn setup_public_history_jobs(pool: &PgPool) -> Result<(), sqlx::Error> {
    crate::jobs::postgres::setup(pool).await?;
    crate::jobs::postgres::create_inflight_job_key_index(
        pool,
        PUBLIC_HISTORY_INFLIGHT_INDEX,
        &[
            PUBLIC_HISTORY_LATEST_NAMESPACE,
            PUBLIC_HISTORY_BACKFILL_NAMESPACE,
        ],
        PUBLIC_HISTORY_JOB_KEY_FIELD,
    )
    .await
}

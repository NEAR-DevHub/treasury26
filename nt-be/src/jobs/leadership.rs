use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::pool::PoolConnection;
use sqlx::{PgPool, Postgres};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const LOCK_NAME: &str = "trezu-background-jobs-v1";
const LOCK_NAMESPACE: i32 = 0x5452_5A55;
const LOCK_ID: i32 = 1;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const LEADERSHIP_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const RUNTIME_DRAIN_TIMEOUT: Duration = Duration::from_secs(45);
const RETRY_INITIAL: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);
const JITTER_MIN_PERCENT: u64 = 80;

pub type RuntimeFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type RuntimeFactory = Box<dyn FnMut(bool, CancellationToken) -> RuntimeFuture + Send + 'static>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundJobsRole {
    Starting,
    Follower,
    Leader,
    Draining,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundJobsSnapshot {
    pub role: BackgroundJobsRole,
    pub instance_id: Uuid,
    pub generation: Option<i64>,
    pub transitioned_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GlobalBackgroundJobsSnapshot {
    pub instance_id: Uuid,
    pub generation: i64,
    pub acquired_at: DateTime<Utc>,
    pub heartbeat_at: DateTime<Utc>,
    pub released_at: Option<DateTime<Utc>>,
    pub active: bool,
}

#[derive(Debug)]
pub struct BackgroundJobsStatus {
    instance_id: Uuid,
    snapshot: RwLock<BackgroundJobsSnapshot>,
}

impl BackgroundJobsStatus {
    pub fn new() -> Self {
        let instance_id = Uuid::new_v4();
        Self {
            instance_id,
            snapshot: RwLock::new(BackgroundJobsSnapshot {
                role: BackgroundJobsRole::Starting,
                instance_id,
                generation: None,
                transitioned_at: Utc::now(),
                last_error: None,
            }),
        }
    }

    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    pub async fn snapshot(&self) -> BackgroundJobsSnapshot {
        self.snapshot.read().await.clone()
    }

    async fn transition(
        &self,
        role: BackgroundJobsRole,
        generation: Option<i64>,
        error: Option<String>,
    ) {
        let mut snapshot = self.snapshot.write().await;
        let state_changed = snapshot.role != role || snapshot.generation != generation;
        if state_changed {
            snapshot.role = role;
            snapshot.generation = generation;
            snapshot.transitioned_at = Utc::now();
        }
        if let Some(error) = error {
            snapshot.last_error = Some(error.chars().take(512).collect());
            if !state_changed {
                snapshot.transitioned_at = Utc::now();
            }
        }
    }
}

impl Default for BackgroundJobsStatus {
    fn default() -> Self {
        Self::new()
    }
}

struct LeadershipGuard {
    connection: Option<PoolConnection<Postgres>>,
    instance_id: Uuid,
    generation: i64,
}

impl LeadershipGuard {
    async fn heartbeat(&mut self) -> Result<(), sqlx::Error> {
        let result = sqlx::query(
            "UPDATE background_job_leader
             SET heartbeat_at = NOW(), released_at = NULL
             WHERE lock_name = $1 AND instance_id = $2 AND generation = $3",
        )
        .bind(LOCK_NAME)
        .bind(self.instance_id)
        .bind(self.generation)
        .execute(&mut **self.connection.as_mut().expect("leadership connection"))
        .await?;

        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "background job leadership heartbeat row was replaced".to_string(),
            ));
        }
        Ok(())
    }

    fn discard(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.close_on_drop();
        }
    }

    async fn release(mut self) -> Result<(), sqlx::Error> {
        let connection = self.connection.as_mut().expect("leadership connection");
        let result = sqlx::query(
            "UPDATE background_job_leader
             SET heartbeat_at = NOW(), released_at = NOW()
             WHERE lock_name = $1 AND instance_id = $2 AND generation = $3",
        )
        .bind(LOCK_NAME)
        .bind(self.instance_id)
        .bind(self.generation)
        .execute(&mut **connection)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "background job leadership release row was replaced".to_string(),
            ));
        }

        let unlocked: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1, $2)")
            .bind(LOCK_NAMESPACE)
            .bind(LOCK_ID)
            .fetch_one(&mut **connection)
            .await?;
        if !unlocked {
            return Err(sqlx::Error::Protocol(
                "background job leadership lock was not held at release".to_string(),
            ));
        }

        drop(self.connection.take());
        Ok(())
    }
}

impl Drop for LeadershipGuard {
    fn drop(&mut self) {
        self.discard();
    }
}

async fn try_acquire(
    pool: &PgPool,
    instance_id: Uuid,
) -> Result<Option<LeadershipGuard>, sqlx::Error> {
    let mut connection = pool.acquire().await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1, $2)")
        .bind(LOCK_NAMESPACE)
        .bind(LOCK_ID)
        .fetch_one(&mut *connection)
        .await?;
    if !acquired {
        return Ok(None);
    }

    let mut guard = LeadershipGuard {
        connection: Some(connection),
        instance_id,
        generation: 0,
    };
    let generation: i64 = sqlx::query_scalar(
        "INSERT INTO background_job_leader (
             lock_name, instance_id, generation, acquired_at, heartbeat_at, released_at
         ) VALUES ($1, $2, 1, NOW(), NOW(), NULL)
         ON CONFLICT (lock_name) DO UPDATE SET
             instance_id = EXCLUDED.instance_id,
             generation = background_job_leader.generation + 1,
             acquired_at = NOW(),
             heartbeat_at = NOW(),
             released_at = NULL
         RETURNING generation",
    )
    .bind(LOCK_NAME)
    .bind(instance_id)
    .fetch_one(&mut **guard.connection.as_mut().expect("leadership connection"))
    .await?;

    guard.generation = generation;
    Ok(Some(guard))
}

pub async fn global_snapshot(
    pool: &PgPool,
) -> Result<Option<GlobalBackgroundJobsSnapshot>, sqlx::Error> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            i64,
            DateTime<Utc>,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
            bool,
        ),
    >(
        "SELECT instance_id, generation, acquired_at, heartbeat_at, released_at,
                released_at IS NULL
                AND heartbeat_at >= NOW() - INTERVAL '15 seconds' AS active
         FROM background_job_leader
         WHERE lock_name = $1",
    )
    .bind(LOCK_NAME)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(instance_id, generation, acquired_at, heartbeat_at, released_at, active)| {
            GlobalBackgroundJobsSnapshot {
                instance_id,
                generation,
                acquired_at,
                heartbeat_at,
                released_at,
                active,
            }
        },
    ))
}

fn retry_backoff(attempt: usize) -> Duration {
    let multiplier = 1u64.checked_shl(attempt.min(63) as u32).unwrap_or(u64::MAX);
    let base_millis = RETRY_INITIAL
        .as_millis()
        .saturating_mul(u128::from(multiplier))
        .min(RETRY_MAX.as_millis());
    let jitter = rand::random_range(JITTER_MIN_PERCENT..=100);
    let jittered = base_millis.saturating_mul(u128::from(jitter)) / 100;
    Duration::from_millis(jittered.min(u128::from(u64::MAX)) as u64)
}

async fn sleep_or_shutdown(delay: Duration, shutdown: &CancellationToken) -> bool {
    tokio::select! {
        _ = shutdown.cancelled() => true,
        _ = tokio::time::sleep(delay) => false,
    }
}

async fn stop_runtime(runtime: &mut JoinHandle<Result<(), String>>, session: &CancellationToken) {
    session.cancel();
    if tokio::time::timeout(RUNTIME_DRAIN_TIMEOUT, &mut *runtime)
        .await
        .is_err()
    {
        tracing::error!(
            timeout_secs = RUNTIME_DRAIN_TIMEOUT.as_secs(),
            "background job runtime drain timed out; aborting before leadership release"
        );
        runtime.abort();
        let _ = runtime.await;
    }
}

enum SessionExit {
    Shutdown,
    HeartbeatFailed(String),
    RuntimeExited(Result<Result<(), String>, tokio::task::JoinError>),
}

pub fn spawn(
    pool: PgPool,
    status: Arc<BackgroundJobsStatus>,
    shutdown: CancellationToken,
    mut runtime_factory: RuntimeFactory,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut retry_attempt = 0usize;
        let mut runtime_started_once = false;
        let mut takeover_started_at = Instant::now();

        status
            .transition(BackgroundJobsRole::Follower, None, None)
            .await;

        loop {
            if shutdown.is_cancelled() {
                status
                    .transition(BackgroundJobsRole::Draining, None, None)
                    .await;
                return;
            }

            let mut guard = match try_acquire(&pool, status.instance_id()).await {
                Ok(Some(guard)) => guard,
                Ok(None) => {
                    status
                        .transition(BackgroundJobsRole::Follower, None, None)
                        .await;
                    let delay = retry_backoff(retry_attempt);
                    retry_attempt = retry_attempt.saturating_add(1);
                    tracing::info!(
                        retry_delay_ms = delay.as_millis(),
                        "background jobs follower waiting for leadership"
                    );
                    if sleep_or_shutdown(delay, &shutdown).await {
                        status
                            .transition(BackgroundJobsRole::Draining, None, None)
                            .await;
                        return;
                    }
                    continue;
                }
                Err(error) => {
                    let message = error.to_string();
                    status
                        .transition(BackgroundJobsRole::Error, None, Some(message.clone()))
                        .await;
                    let delay = retry_backoff(retry_attempt);
                    retry_attempt = retry_attempt.saturating_add(1);
                    tracing::error!(
                        error = %error,
                        retry_delay_ms = delay.as_millis(),
                        "background job leadership acquisition failed"
                    );
                    if sleep_or_shutdown(delay, &shutdown).await {
                        status
                            .transition(BackgroundJobsRole::Draining, None, None)
                            .await;
                        return;
                    }
                    continue;
                }
            };

            retry_attempt = 0;
            let generation = guard.generation;
            status
                .transition(BackgroundJobsRole::Leader, Some(generation), None)
                .await;
            tracing::info!(
                instance_id = %status.instance_id(),
                generation,
                takeover_ms = takeover_started_at.elapsed().as_millis(),
                "background job leadership acquired"
            );

            let session = CancellationToken::new();
            let run_startup_tasks = !runtime_started_once;
            runtime_started_once = true;
            let mut runtime = tokio::spawn(runtime_factory(run_startup_tasks, session.clone()));
            let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            let exit = loop {
                tokio::select! {
                    _ = shutdown.cancelled() => break SessionExit::Shutdown,
                    runtime_result = &mut runtime => {
                        break SessionExit::RuntimeExited(runtime_result);
                    }
                    _ = heartbeat.tick() => {
                        match tokio::time::timeout(
                            LEADERSHIP_QUERY_TIMEOUT,
                            guard.heartbeat(),
                        )
                        .await
                        {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                break SessionExit::HeartbeatFailed(error.to_string());
                            }
                            Err(_) => {
                                break SessionExit::HeartbeatFailed(format!(
                                    "leadership heartbeat exceeded {}s timeout",
                                    LEADERSHIP_QUERY_TIMEOUT.as_secs()
                                ));
                            }
                        }
                    }
                }
            };

            status
                .transition(BackgroundJobsRole::Draining, Some(generation), None)
                .await;
            let exit_reason = match &exit {
                SessionExit::Shutdown => "shutdown",
                SessionExit::HeartbeatFailed(_) => "heartbeat_failed",
                SessionExit::RuntimeExited(_) => "runtime_exited",
            };
            tracing::info!(
                generation,
                reason = exit_reason,
                "background job workers draining"
            );

            let runtime_already_exited = matches!(exit, SessionExit::RuntimeExited(_));
            if !runtime_already_exited {
                stop_runtime(&mut runtime, &session).await;
            } else {
                session.cancel();
            }

            let connection_lost = matches!(exit, SessionExit::HeartbeatFailed(_));
            let released_cleanly = if connection_lost {
                guard.discard();
                drop(guard);
                false
            } else {
                match tokio::time::timeout(LEADERSHIP_QUERY_TIMEOUT, guard.release()).await {
                    Ok(Ok(())) => true,
                    Ok(Err(error)) => {
                        tracing::error!(
                            error = %error,
                            "failed to release background job leadership; connection closed"
                        );
                        false
                    }
                    Err(_) => {
                        tracing::error!(
                            timeout_secs = LEADERSHIP_QUERY_TIMEOUT.as_secs(),
                            "background job leadership release timed out; connection closed"
                        );
                        false
                    }
                }
            };

            match exit {
                SessionExit::Shutdown => {
                    tracing::info!(
                        generation,
                        released_cleanly,
                        "background job leadership shutdown completed"
                    );
                    return;
                }
                SessionExit::HeartbeatFailed(message) => {
                    status
                        .transition(BackgroundJobsRole::Error, None, Some(message.clone()))
                        .await;
                    tracing::error!(
                        generation,
                        error = %message,
                        "background job leadership heartbeat failed"
                    );
                }
                SessionExit::RuntimeExited(result) => {
                    let message = match result {
                        Ok(Ok(())) => "background job runtime exited unexpectedly".to_string(),
                        Ok(Err(error)) => error,
                        Err(error) => format!("background job runtime task failed: {error}"),
                    };
                    status
                        .transition(BackgroundJobsRole::Error, None, Some(message.clone()))
                        .await;
                    tracing::error!(
                        generation,
                        error = %message,
                        "background job runtime stopped; leadership will be reacquired"
                    );
                }
            }

            takeover_started_at = Instant::now();
            let delay = retry_backoff(retry_attempt);
            retry_attempt = retry_attempt.saturating_add(1);
            if sleep_or_shutdown(delay, &shutdown).await {
                status
                    .transition(BackgroundJobsRole::Draining, None, None)
                    .await;
                return;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serial_test::serial;
    use sqlx::postgres::PgPoolOptions;

    use super::*;

    async fn wait_for_role(
        status: &BackgroundJobsStatus,
        expected: BackgroundJobsRole,
    ) -> BackgroundJobsSnapshot {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = status.snapshot().await;
                if snapshot.role == expected {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("leadership role transition timed out")
    }

    async fn test_pool(max_connections: u32) -> Option<PgPool> {
        dotenvy::dotenv().ok();
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return None;
        };
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(&url)
            .await
            .expect("connect to test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        Some(pool)
    }

    async fn release_lock_probe(pool: &PgPool) -> bool {
        let Some(probe) = try_acquire(pool, Uuid::new_v4())
            .await
            .expect("probe leadership")
        else {
            eprintln!("skipping: another process holds background-job leadership");
            return false;
        };
        probe.release().await.expect("release leadership probe");
        true
    }

    fn tracked_runtime_factory(
        starts: Arc<AtomicUsize>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
    ) -> RuntimeFactory {
        Box::new(move |_run_startup_tasks, shutdown| {
            let starts = starts.clone();
            let active = active.clone();
            let max_active = max_active.clone();
            Box::pin(async move {
                starts.fetch_add(1, Ordering::SeqCst);
                let active_now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(active_now, Ordering::SeqCst);
                shutdown.cancelled().await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
        })
    }

    #[test]
    fn retry_backoff_is_capped_and_jittered_downward() {
        for attempt in 0..10 {
            let delay = retry_backoff(attempt);
            let capped_base =
                Duration::from_secs((2u64.saturating_mul(1 << attempt.min(4))).min(30));
            assert!(delay <= capped_base);
            assert!(delay.as_millis() >= capped_base.as_millis() * 80 / 100);
        }
    }

    #[tokio::test]
    async fn status_tracks_role_generation_and_error() {
        let status = BackgroundJobsStatus::new();
        status
            .transition(BackgroundJobsRole::Leader, Some(7), None)
            .await;
        let leader = status.snapshot().await;
        assert_eq!(leader.role, BackgroundJobsRole::Leader);
        assert_eq!(leader.generation, Some(7));

        status
            .transition(
                BackgroundJobsRole::Error,
                None,
                Some("lost connection".to_string()),
            )
            .await;
        let error = status.snapshot().await;
        assert_eq!(error.role, BackgroundJobsRole::Error);
        assert_eq!(error.last_error.as_deref(), Some("lost connection"));
    }

    #[tokio::test]
    async fn repeated_follower_observation_is_not_a_state_transition() {
        let status = BackgroundJobsStatus::new();
        status
            .transition(BackgroundJobsRole::Follower, None, None)
            .await;
        let first = status.snapshot().await;
        tokio::time::sleep(Duration::from_millis(2)).await;
        status
            .transition(BackgroundJobsRole::Follower, None, None)
            .await;
        let second = status.snapshot().await;

        assert_eq!(first.transitioned_at, second.transitioned_at);
    }

    #[tokio::test]
    async fn shutdown_interrupts_follower_backoff() {
        let shutdown = CancellationToken::new();
        let sleeper_shutdown = shutdown.clone();
        let sleeper = tokio::spawn(async move {
            sleep_or_shutdown(Duration::from_secs(60), &sleeper_shutdown).await
        });

        shutdown.cancel();
        let interrupted = tokio::time::timeout(Duration::from_secs(1), sleeper)
            .await
            .expect("backoff sleep should stop promptly")
            .expect("backoff task should not panic");
        assert!(interrupted);
    }

    #[tokio::test]
    #[serial]
    async fn leadership_reserves_one_pool_slot_and_releases_it() {
        let Some(pool) = test_pool(1).await else {
            return;
        };
        let Some(guard) = try_acquire(&pool, Uuid::new_v4())
            .await
            .expect("acquire leadership")
        else {
            eprintln!("skipping: another process holds background-job leadership");
            return;
        };

        assert!(
            tokio::time::timeout(Duration::from_millis(100), pool.acquire())
                .await
                .is_err(),
            "the leadership session must reserve one pool connection"
        );

        guard.release().await.expect("release leadership");
        let connection = tokio::time::timeout(Duration::from_secs(1), pool.acquire())
            .await
            .expect("released pool slot should become available")
            .expect("acquire released pool slot");
        drop(connection);

        let global = global_snapshot(&pool)
            .await
            .expect("read global leadership")
            .expect("leadership row exists");
        assert!(!global.active);
        assert!(global.released_at.is_some());
    }

    #[tokio::test]
    #[serial]
    async fn only_one_coordinator_runs_and_follower_takes_over() {
        let Some(pool) = test_pool(4).await else {
            return;
        };
        if !release_lock_probe(&pool).await {
            return;
        }

        let starts = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));

        let first_status = Arc::new(BackgroundJobsStatus::new());
        let first_shutdown = CancellationToken::new();
        let first = spawn(
            pool.clone(),
            first_status.clone(),
            first_shutdown.clone(),
            tracked_runtime_factory(starts.clone(), active.clone(), max_active.clone()),
        );
        wait_for_role(&first_status, BackgroundJobsRole::Leader).await;

        let second_status = Arc::new(BackgroundJobsStatus::new());
        let second_shutdown = CancellationToken::new();
        let second = spawn(
            pool.clone(),
            second_status.clone(),
            second_shutdown.clone(),
            tracked_runtime_factory(starts.clone(), active.clone(), max_active.clone()),
        );
        wait_for_role(&second_status, BackgroundJobsRole::Follower).await;
        tokio::time::sleep(Duration::from_millis(250)).await;

        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 1);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);

        first_shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .expect("first coordinator should stop")
            .expect("first coordinator should not panic");

        wait_for_role(&second_status, BackgroundJobsRole::Leader).await;
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(active.load(Ordering::SeqCst), 1);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);

        second_shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .expect("second coordinator should stop")
            .expect("second coordinator should not panic");
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    #[serial]
    async fn runtime_rebuild_does_not_repeat_startup_tasks() {
        let Some(pool) = test_pool(3).await else {
            return;
        };
        if !release_lock_probe(&pool).await {
            return;
        }

        let startup_flags = Arc::new(Mutex::new(Vec::new()));
        let starts = Arc::new(AtomicUsize::new(0));
        let runtime_flags = startup_flags.clone();
        let runtime_starts = starts.clone();
        let shutdown = CancellationToken::new();
        let coordinator = spawn(
            pool,
            Arc::new(BackgroundJobsStatus::new()),
            shutdown.clone(),
            Box::new(move |run_startup_tasks, session_shutdown| {
                runtime_flags
                    .lock()
                    .expect("startup flags lock")
                    .push(run_startup_tasks);
                let run = runtime_starts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if run == 0 {
                        return Err("simulated runtime exit".to_string());
                    }
                    session_shutdown.cancelled().await;
                    Ok(())
                })
            }),
        );

        tokio::time::timeout(Duration::from_secs(10), async {
            while starts.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("runtime should be rebuilt");

        assert_eq!(
            startup_flags.lock().expect("startup flags lock").as_slice(),
            &[true, false]
        );

        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(5), coordinator)
            .await
            .expect("coordinator should stop")
            .expect("coordinator should not panic");
    }

    #[tokio::test]
    #[serial]
    async fn heartbeat_failure_drains_before_reacquisition() {
        let Some(pool) = test_pool(4).await else {
            return;
        };
        if !release_lock_probe(&pool).await {
            return;
        }

        let starts = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let status = Arc::new(BackgroundJobsStatus::new());
        let shutdown = CancellationToken::new();
        let coordinator = spawn(
            pool.clone(),
            status.clone(),
            shutdown.clone(),
            tracked_runtime_factory(starts.clone(), active.clone(), max_active.clone()),
        );

        let first_generation = wait_for_role(&status, BackgroundJobsRole::Leader)
            .await
            .generation
            .expect("leader generation");
        sqlx::query(
            "UPDATE background_job_leader
             SET instance_id = $1
             WHERE lock_name = $2",
        )
        .bind(Uuid::new_v4())
        .bind(LOCK_NAME)
        .execute(&pool)
        .await
        .expect("replace heartbeat ownership row");

        let recovered = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let snapshot = status.snapshot().await;
                if snapshot.role == BackgroundJobsRole::Leader
                    && snapshot
                        .generation
                        .is_some_and(|value| value > first_generation)
                {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("coordinator should reacquire after heartbeat failure");

        assert!(recovered.last_error.is_some());
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(active.load(Ordering::SeqCst), 1);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);

        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(5), coordinator)
            .await
            .expect("coordinator should stop")
            .expect("coordinator should not panic");
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}

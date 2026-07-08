use std::sync::Arc;

use chrono::{DateTime, Utc};
use near_api::{
    AccountId, Contract, NearGas, NearToken, Transaction,
    types::{Action, transaction::actions::FunctionCallAction},
};
use sqlx::PgPool;
use tokio::{sync::Semaphore, task::JoinSet};

use crate::{
    AppState,
    handlers::user::ft_lockups::{
        FtLockupAccountData, fetch_ft_lockup_account_data, fetch_ft_lockup_contract_metadata,
        fetch_ft_lockup_instance_accounts, fetch_ft_lockup_instance_ids,
    },
};

const CLAIM_RETRY_BACKOFF_SECS: i64 = 10 * 60;
const DEFAULT_CLAIM_BATCH_LIMIT: i64 = 100;
const REFRESH_CONCURRENCY: usize = 8;
const CLAIM_CONCURRENCY: usize = 8;
const STORAGE_DEPOSIT_AMOUNT: NearToken = NearToken::from_millinear(125);
const CLAIM_DEPOSIT_AMOUNT: NearToken = NearToken::from_yoctonear(1);
const FT_LOCKUP_GAS: NearGas = NearGas::from_tgas(300);

#[derive(Debug, Clone, Copy, Default)]
pub struct FtLockupRefreshSummary {
    pub instances: usize,
    pub rows_upserted: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FtLockupClaimSummary {
    pub due_rows: usize,
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
}

fn parse_u128_amount(value: &str) -> u128 {
    value.parse::<u128>().unwrap_or(0)
}

fn u64_to_i64_opt(value: Option<u64>) -> Option<i64> {
    value.and_then(|v| i64::try_from(v).ok())
}

fn compute_next_claim_at(
    now: DateTime<Utc>,
    account_data: &FtLockupAccountData,
) -> Option<DateTime<Utc>> {
    let start = u64_to_i64_opt(account_data.start_timestamp)?;
    let interval = u64_to_i64_opt(account_data.session_interval)?;
    if interval <= 0 {
        return None;
    }

    // Interval-only scheduler:
    // next_claim_at is the first boundary strictly after "now".
    let elapsed = now.timestamp().saturating_sub(start);
    let passed_intervals = if elapsed <= 0 {
        0
    } else {
        (elapsed / interval) + 1
    };
    let next_ts = start.saturating_add(passed_intervals.saturating_mul(interval));
    DateTime::<Utc>::from_timestamp(next_ts, 0)
        .or_else(|| DateTime::<Utc>::from_timestamp(now.timestamp(), 0))
}

async fn delete_schedule_row(
    pool: &PgPool,
    dao_account_id: &str,
    instance_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        DELETE FROM ft_lockup_dao_schedules
        WHERE dao_account_id = $1
          AND instance_id = $2
        "#,
        dao_account_id,
        instance_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_schedule_row(
    pool: &PgPool,
    dao_account_id: &str,
    instance_id: &str,
    token_account_id: &str,
    account_data: &FtLockupAccountData,
) -> Result<(), sqlx::Error> {
    let deposited_amount = parse_u128_amount(&account_data.deposited_amount);
    let claimed_amount = parse_u128_amount(&account_data.claimed_amount);
    let unclaimed_amount = parse_u128_amount(&account_data.unclaimed_amount);
    if deposited_amount == 0 || claimed_amount >= deposited_amount {
        delete_schedule_row(pool, dao_account_id, instance_id).await?;
        return Ok(());
    }

    let now = Utc::now();
    // If tokens are already claimable, make this row due right away so the
    // first claimer cycle can execute claim immediately.
    let next_claim_at = if unclaimed_amount > 0 {
        Some(now)
    } else {
        compute_next_claim_at(now, account_data)
    };

    let session_interval_seconds = u64_to_i64_opt(account_data.session_interval);
    let start_timestamp_seconds = u64_to_i64_opt(account_data.start_timestamp);
    sqlx::query!(
        r#"
        INSERT INTO ft_lockup_dao_schedules (
            dao_account_id,
            instance_id,
            token_account_id,
            session_interval_seconds,
            start_timestamp_seconds,
            next_claim_at,
            last_account_sync_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (dao_account_id, instance_id) DO UPDATE SET
            token_account_id = EXCLUDED.token_account_id,
            session_interval_seconds = EXCLUDED.session_interval_seconds,
            start_timestamp_seconds = EXCLUDED.start_timestamp_seconds,
            next_claim_at = EXCLUDED.next_claim_at,
            last_account_sync_at = NOW()
        "#,
        dao_account_id,
        instance_id,
        token_account_id,
        session_interval_seconds,
        start_timestamp_seconds,
        next_claim_at
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[tracing::instrument(level = "debug", skip_all, fields(instance_id = instance_id))]
async fn refresh_instance_rows(
    state: Arc<AppState>,
    instance_id: String,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let accounts = match fetch_ft_lockup_instance_accounts(&state, &instance_id).await {
        Ok(a) => a,
        Err((status, msg)) => {
            tracing::warn!(
                "scheduler skip instance={} list_accounts failed: {} ({})",
                instance_id,
                msg,
                status
            );
            return Ok(0);
        }
    };
    if accounts.is_empty() {
        return Ok(0);
    }

    let metadata = match fetch_ft_lockup_contract_metadata(&state, &instance_id).await {
        Ok(m) => m,
        Err((status, msg)) => {
            tracing::warn!(
                "scheduler skip instance={} metadata failed: {} ({})",
                instance_id,
                msg,
                status
            );
            return Ok(0);
        }
    };

    let mut rows_upserted = 0usize;

    for dao_account_id in accounts {
        let dao_account = match dao_account_id.parse::<AccountId>() {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    "scheduler invalid dao account id={} instance={}: {}",
                    dao_account_id,
                    instance_id,
                    e
                );
                continue;
            }
        };

        let Some(account_data) = (match fetch_ft_lockup_account_data(
            &state,
            &instance_id,
            &dao_account,
        )
        .await
        {
            Ok(account_data) => account_data,
            Err((status, msg)) => {
                tracing::warn!(
                    "scheduler skip account sync instance={} dao={} get_account failed: {} ({})",
                    instance_id,
                    dao_account.as_str(),
                    msg,
                    status
                );
                continue;
            }
        }) else {
            continue;
        };

        upsert_schedule_row(
            &state.db_pool,
            dao_account.as_str(),
            &instance_id,
            &metadata.token_account_id,
            &account_data,
        )
        .await?;

        rows_upserted += 1;
    }

    Ok(rows_upserted)
}

#[tracing::instrument(level = "info", skip_all, fields(job = "ft_lockup_schedule_refresh"))]
pub async fn refresh_ft_lockup_dao_schedules(
    state: &Arc<AppState>,
) -> Result<FtLockupRefreshSummary, Box<dyn std::error::Error + Send + Sync>> {
    let instance_ids = fetch_ft_lockup_instance_ids(state)
        .await
        .map_err(|(_, msg)| msg)?;
    if instance_ids.is_empty() {
        return Ok(FtLockupRefreshSummary::default());
    }

    let semaphore = Arc::new(Semaphore::new(REFRESH_CONCURRENCY));
    let mut join_set = JoinSet::new();

    for instance_id in &instance_ids {
        let state = state.clone();
        let sem = semaphore.clone();
        let instance_id = instance_id.clone();
        join_set.spawn(async move {
            let _permit = sem
                .acquire_owned()
                .await
                .expect("refresh semaphore should not close");
            refresh_instance_rows(state, instance_id).await
        });
    }

    let mut rows_upserted = 0usize;
    while let Some(join_result) = join_set.join_next().await {
        match join_result {
            Ok(Ok(instance_rows_upserted)) => {
                rows_upserted += instance_rows_upserted;
            }
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("refresh task join failed: {}", e).into()),
        }
    }

    Ok(FtLockupRefreshSummary {
        instances: instance_ids.len(),
        rows_upserted,
    })
}

async fn mark_claim_failure(
    pool: &PgPool,
    dao_account_id: &str,
    instance_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        UPDATE ft_lockup_dao_schedules
        SET next_claim_at = NOW() + ($3::double precision * INTERVAL '1 second')
        WHERE dao_account_id = $1
          AND instance_id = $2
        "#,
        dao_account_id,
        instance_id,
        CLAIM_RETRY_BACKOFF_SECS as f64
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[tracing::instrument(
    level = "info",
    skip_all,
    fields(account_id = dao_account_id, asset_contract = tracing::field::Empty, instance_id = instance_id)
)]
async fn register_ft_once(
    state: &Arc<AppState>,
    token_account_id: &str,
    dao_account_id: &str,
    instance_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::Span::current().record("asset_contract", tracing::field::display(token_account_id));

    let token_account: AccountId = token_account_id.parse()?;
    let dao_account: AccountId = dao_account_id.parse()?;

    let already_registered = Contract(token_account.clone())
        .storage_deposit()
        .view_account_storage(dao_account)
        .fetch_from(&state.network)
        .await?
        .data
        .is_some();

    if !already_registered {
        let args = serde_json::to_vec(&serde_json::json!({
            "account_id": dao_account_id,
            "registration_only": true
        }))?;

        Transaction::construct(state.signer_id.clone(), token_account)
            .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: "storage_deposit".to_string(),
                args,
                gas: FT_LOCKUP_GAS,
                deposit: STORAGE_DEPOSIT_AMOUNT,
            })))
            .with_signer(state.signer.clone())
            .send_to(&state.network)
            .await?
            .into_result()?;
    }

    sqlx::query!(
        r#"
        UPDATE ft_lockup_dao_schedules
        SET ft_registered_at = COALESCE(ft_registered_at, NOW()),
            last_account_sync_at = NOW()
        WHERE dao_account_id = $1
          AND instance_id = $2
        "#,
        dao_account_id,
        instance_id
    )
    .execute(&state.db_pool)
    .await?;

    Ok(())
}

#[tracing::instrument(
    level = "info",
    skip_all,
    fields(job = "ft_lockup_claim", batch_limit = tracing::field::Empty, dry_run = dry_run)
)]
pub async fn run_due_ft_lockup_claims(
    state: &Arc<AppState>,
    batch_limit: Option<i64>,
    dry_run: bool,
) -> Result<FtLockupClaimSummary, Box<dyn std::error::Error + Send + Sync>> {
    let limit = batch_limit.unwrap_or(DEFAULT_CLAIM_BATCH_LIMIT).max(1);
    tracing::Span::current().record("batch_limit", limit);

    let due_rows = sqlx::query!(
        r#"
        SELECT dao_account_id, instance_id, token_account_id, ft_registered_at
        FROM ft_lockup_dao_schedules
        WHERE (next_claim_at IS NULL OR next_claim_at <= NOW())
        ORDER BY COALESCE(next_claim_at, NOW()) ASC
        LIMIT $1
        "#,
        limit
    )
    .fetch_all(&state.db_pool)
    .await?;

    let mut summary = FtLockupClaimSummary {
        due_rows: due_rows.len(),
        attempted: due_rows.len(),
        ..FtLockupClaimSummary::default()
    };

    let semaphore = Arc::new(Semaphore::new(CLAIM_CONCURRENCY));
    let mut join_set = JoinSet::new();

    for row in due_rows {
        let state = state.clone();
        let sem = semaphore.clone();
        let dao_account_id = row.dao_account_id;
        let instance_id = row.instance_id;
        let token_account_id = row.token_account_id;
        let ft_registered_at = row.ft_registered_at;

        join_set.spawn(async move {
            let _permit = sem
                .acquire_owned()
                .await
                .expect("claim semaphore should not close");

            if dry_run {
                tracing::info!(
                    "claim dry-run due instance={} dao={}",
                    instance_id,
                    dao_account_id
                );
                return Ok::<bool, Box<dyn std::error::Error + Send + Sync>>(false);
            }

            let instance_account = match instance_id.parse::<AccountId>() {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(
                        "claim invalid instance id instance={} dao={} error={}",
                        instance_id,
                        dao_account_id,
                        e
                    );
                    mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id).await?;
                    return Ok(false);
                }
            };

            if ft_registered_at.is_none()
                && let Err(e) =
                    register_ft_once(&state, &token_account_id, &dao_account_id, &instance_id).await
            {
                tracing::warn!(
                    "claim first registration failed instance={} dao={} token={} error={}",
                    instance_id,
                    dao_account_id,
                    token_account_id,
                    e
                );
                mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id).await?;
                return Ok(false);
            }

            let claim_args = match serde_json::to_vec(&serde_json::json!({
                "account_id": dao_account_id
            })) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(
                        "claim failed to serialize claim args instance={} dao={} error={}",
                        instance_id,
                        dao_account_id,
                        e
                    );
                    mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id).await?;
                    return Ok(false);
                }
            };

            let tx_res = Transaction::construct(state.signer_id.clone(), instance_account)
                .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
                    method_name: "claim".to_string(),
                    args: claim_args,
                    gas: FT_LOCKUP_GAS,
                    deposit: CLAIM_DEPOSIT_AMOUNT,
                })))
                .with_signer(state.signer.clone())
                .send_to(&state.network)
                .await;

            match tx_res {
                Ok(outcome) => match outcome.into_result() {
                    Ok(_) => {
                        let dao_account = match dao_account_id.parse::<AccountId>() {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!(
                                    "claim invalid dao id after claim instance={} dao={} error={}",
                                    instance_id,
                                    dao_account_id,
                                    e
                                );
                                mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id)
                                    .await?;
                                return Ok(false);
                            }
                        };

                        match fetch_ft_lockup_account_data(&state, &instance_id, &dao_account).await
                        {
                            Ok(Some(account_data)) => {
                                upsert_schedule_row(
                                    &state.db_pool,
                                    &dao_account_id,
                                    &instance_id,
                                    &token_account_id,
                                    &account_data,
                                )
                                .await?;
                            }
                            Ok(None) => {
                                delete_schedule_row(&state.db_pool, &dao_account_id, &instance_id)
                                    .await?;
                            }
                            Err((_, msg)) => {
                                tracing::warn!(
                                    "claim post-claim refresh failed instance={} dao={} error={}",
                                    instance_id,
                                    dao_account_id,
                                    msg
                                );
                                mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id)
                                    .await?;
                                return Ok(false);
                            }
                        }

                        tracing::info!(
                            "claim success instance={} dao={}",
                            instance_id,
                            dao_account_id
                        );
                        Ok(true)
                    }
                    Err(e) => {
                        mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id).await?;
                        tracing::warn!(
                            "claim failed instance={} dao={} error={}",
                            instance_id,
                            dao_account_id,
                            e
                        );
                        Ok(false)
                    }
                },
                Err(e) => {
                    mark_claim_failure(&state.db_pool, &dao_account_id, &instance_id).await?;
                    tracing::warn!(
                        "claim failed instance={} dao={} error={}",
                        instance_id,
                        dao_account_id,
                        e
                    );
                    Ok(false)
                }
            }
        });
    }

    while let Some(join_result) = join_set.join_next().await {
        match join_result {
            Ok(Ok(true)) => {
                summary.succeeded += 1;
            }
            Ok(Ok(false)) => {
                if !dry_run {
                    summary.failed += 1;
                }
            }
            Ok(Err(e)) => {
                summary.failed += 1;
                tracing::warn!("claim task failed with error: {}", e);
            }
            Err(e) => {
                summary.failed += 1;
                tracing::warn!("claim task join failed: {}", e);
            }
        }
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_next_claim_at_uses_interval_boundaries() {
        let now = DateTime::parse_from_rfc3339("2026-03-30T00:00:00Z")
            .expect("timestamp should parse")
            .with_timezone(&Utc);
        let data = FtLockupAccountData {
            deposited_amount: "100".to_string(),
            claimed_amount: "10".to_string(),
            unclaimed_amount: "0".to_string(),
            start_timestamp: Some(1000),
            session_interval: Some(100),
            session_num: Some(10),
            last_claim_session: Some(2),
            release_per_session: None,
        };
        let next_claim_at = compute_next_claim_at(now, &data).expect("next claim should exist");
        let now_ts = now.timestamp();
        assert!(
            next_claim_at.timestamp() > now_ts,
            "next claim time should be in the future"
        );
        assert_eq!((next_claim_at.timestamp() - 1000) % 100, 0);
    }

    #[test]
    fn first_cycle_marks_due_when_unclaimed_exists() {
        let data = FtLockupAccountData {
            deposited_amount: "100".to_string(),
            claimed_amount: "0".to_string(),
            unclaimed_amount: "10".to_string(),
            start_timestamp: Some(1000),
            session_interval: Some(100),
            session_num: Some(10),
            last_claim_session: Some(0),
            release_per_session: None,
        };

        let now = Utc::now();
        let unclaimed_amount = parse_u128_amount(&data.unclaimed_amount);
        let next_claim_at = if unclaimed_amount > 0 {
            Some(now)
        } else {
            compute_next_claim_at(now, &data)
        }
        .expect("next claim should be set");

        assert!(
            next_claim_at.timestamp() <= now.timestamp(),
            "rows with unclaimed amount should be due immediately"
        );
    }
}

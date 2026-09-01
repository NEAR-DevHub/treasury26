//! Functions for monitored account registration and refresh.
//!
//! These helpers are shared by API routes and internal handlers.

use near_account_id::{AccountId, AccountIdRef};
use sqlx::PgPool;
use sqlx::types::chrono::{DateTime, Utc};

use crate::config::{PlanType, get_initial_credits};
use crate::utils::datetime::next_month_start_utc;
use crate::utils::env::EnvVars;

/// Error text shared by every handler that rejects an unmanaged treasury.
pub const NOT_MANAGED_TREASURY_MESSAGE: &str = "Treasury is not managed by this app";

/// Whether a registration may create a `monitored_accounts` row or only refresh one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationMode {
    /// Create the row when missing (treasury creation; Trezu default).
    RegisterOrRefresh,
    /// Only refresh an existing row; unknown accounts are rejected with `NotManaged`.
    RefreshOnly,
}

impl RegistrationMode {
    /// Mode for user-initiated registrations (treasury open, Telegram connect,
    /// settings). Under `MANAGED_TREASURIES_ONLY` these never create rows, so
    /// only treasuries created through the app are ever tracked.
    pub fn for_user_action(env: &EnvVars) -> Self {
        if env.managed_treasuries_only {
            Self::RefreshOnly
        } else {
            Self::RegisterOrRefresh
        }
    }
}

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct MonitoredAccount {
    #[sqlx(try_from = "String")]
    pub account_id: AccountId,
    pub enabled: bool,
    pub is_confidential_account: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub plan_type: PlanType,
    pub credits_reset_at: DateTime<Utc>,
    pub dirty_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    pub maintenance_block_floor: Option<i64>,
}

pub struct RegisterMonitoredAccountResult {
    pub account: MonitoredAccount,
    pub is_new_registration: bool,
}

#[derive(Debug)]
pub enum RegisterMonitoredAccountError {
    NotSputnikDao,
    /// `RefreshOnly` registration for an account without a `monitored_accounts` row.
    NotManaged,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for RegisterMonitoredAccountError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// Mirror a non-sputnik account into the Goldsky pipeline's dynamic lookup
/// table (`streamling.tracked_accounts`) so its outcomes are indexed.
/// Sputnik DAOs are covered by the pipeline's static filters and skipped.
/// Best-effort: a failure is logged but never blocks registration — the
/// NearBlocks backfill still covers the data.
async fn sync_tracked_account(goldsky_pool: Option<&PgPool>, account_id: &AccountIdRef) {
    if account_id.as_str().ends_with(".sputnik-dao.near") {
        return;
    }
    let Some(goldsky_pool) = goldsky_pool else {
        return;
    };
    let result = sqlx::query(
        r#"
        INSERT INTO streamling.tracked_accounts (value, updated_at)
        VALUES ($1, NOW())
        ON CONFLICT (value) DO UPDATE SET updated_at = NOW()
        "#,
    )
    .bind(account_id.as_str())
    .execute(goldsky_pool)
    .await;

    if let Err(e) = result {
        tracing::warn!(
            account_id = account_id.as_str(),
            error = %e,
            "failed to sync account into goldsky tracked_accounts"
        );
    }
}

/// Whether `dao_id` is tracked in `monitored_accounts` (i.e. managed by this app).
pub async fn is_managed_treasury(pool: &PgPool, dao_id: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM monitored_accounts WHERE account_id = $1)",
    )
    .bind(dao_id)
    .fetch_one(pool)
    .await
}

/// Register a monitored account or refresh an existing one.
///
/// - Existing account: updates `dirty_at` and marks DAO as dirty.
/// - New account: creates with default Plus plan credits, unless `mode` is
///   `RefreshOnly`, in which case `NotManaged` is returned and nothing is written.
/// - Non-sputnik accounts are mirrored into the Goldsky `tracked_accounts`
///   lookup table so the pipeline indexes their outcomes.
pub async fn register_or_refresh_monitored_account(
    pool: &PgPool,
    goldsky_pool: Option<&PgPool>,
    account_id: &AccountIdRef,
    is_confidential: bool,
    mode: RegistrationMode,
) -> Result<RegisterMonitoredAccountResult, RegisterMonitoredAccountError> {
    let existing = sqlx::query_scalar!(
        r#"
        SELECT 1 AS "one!"
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        account_id.as_str()
    )
    .fetch_optional(pool)
    .await?;

    if existing.is_none() {
        if mode == RegistrationMode::RefreshOnly {
            return Err(RegisterMonitoredAccountError::NotManaged);
        }
        if !account_id.as_str().ends_with(".sputnik-dao.near") {
            return Err(RegisterMonitoredAccountError::NotSputnikDao);
        }
    }

    if existing.is_some() {
        let account = sqlx::query_as::<_, MonitoredAccount>(
            r#"
            UPDATE monitored_accounts
            SET dirty_at = NOW(), updated_at = NOW()
            WHERE account_id = $1
            RETURNING account_id, enabled, last_synced_at, created_at, updated_at, is_confidential_account,
                      export_credits, batch_payment_credits, plan_type, credits_reset_at, dirty_at
            "#,
        )
        .bind(account_id.as_str())
        .fetch_one(pool)
        .await?;

        sqlx::query!(
            r#"
            UPDATE daos
            SET is_dirty = true
            WHERE dao_id = $1
            "#,
            account_id.as_str()
        )
        .execute(pool)
        .await?;

        sync_tracked_account(goldsky_pool, account_id).await;

        return Ok(RegisterMonitoredAccountResult {
            account,
            is_new_registration: false,
        });
    }

    let (export_credits, batch_payment_credits, gas_covered_transactions) =
        get_initial_credits(PlanType::Plus);
    let credits_reset_at = next_month_start_utc(Utc::now());

    let account = sqlx::query_as::<_, MonitoredAccount>(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, export_credits, batch_payment_credits, gas_covered_transactions, plan_type, credits_reset_at, dirty_at, is_confidential_account)
        VALUES ($1, true, $2, $3, $4, 'plus', $5, NOW(), $6)
        RETURNING account_id, enabled, last_synced_at, created_at, updated_at,
                  export_credits, batch_payment_credits, plan_type, credits_reset_at, dirty_at, is_confidential_account
        "#,
    )
    .bind(account_id.as_str())
    .bind(export_credits)
    .bind(batch_payment_credits)
    .bind(gas_covered_transactions)
    .bind(credits_reset_at)
    .bind(is_confidential)
    .fetch_one(pool)
    .await?;

    sync_tracked_account(goldsky_pool, account_id).await;

    Ok(RegisterMonitoredAccountResult {
        account,
        is_new_registration: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::load_test_env;

    const DAO: &str = "registration-mode-test.sputnik-dao.near";

    async fn row_count(pool: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM monitored_accounts")
            .fetch_one(pool)
            .await
            .expect("count monitored accounts")
    }

    #[test]
    fn for_user_action_follows_managed_flag() {
        load_test_env();
        let mut env = EnvVars::default();
        assert_eq!(
            RegistrationMode::for_user_action(&env),
            RegistrationMode::RegisterOrRefresh
        );
        env.managed_treasuries_only = true;
        assert_eq!(
            RegistrationMode::for_user_action(&env),
            RegistrationMode::RefreshOnly
        );
    }

    #[sqlx::test]
    async fn refresh_only_rejects_unknown_account_without_writing(pool: PgPool) {
        let dao: AccountId = DAO.parse().unwrap();
        let before = row_count(&pool).await;

        let err = register_or_refresh_monitored_account(
            &pool,
            None,
            &dao,
            false,
            RegistrationMode::RefreshOnly,
        )
        .await
        .err()
        .expect("unknown account must be rejected in RefreshOnly mode");

        assert!(matches!(err, RegisterMonitoredAccountError::NotManaged));
        assert_eq!(row_count(&pool).await, before);
        assert!(!is_managed_treasury(&pool, DAO).await.unwrap());
    }

    #[sqlx::test]
    async fn refresh_only_refreshes_existing_account(pool: PgPool) {
        let dao: AccountId = DAO.parse().unwrap();
        let created = register_or_refresh_monitored_account(
            &pool,
            None,
            &dao,
            false,
            RegistrationMode::RegisterOrRefresh,
        )
        .await
        .expect("default mode creates the row");
        assert!(created.is_new_registration);
        assert!(is_managed_treasury(&pool, DAO).await.unwrap());

        let refreshed = register_or_refresh_monitored_account(
            &pool,
            None,
            &dao,
            false,
            RegistrationMode::RefreshOnly,
        )
        .await
        .expect("existing row refreshes in RefreshOnly mode");
        assert!(!refreshed.is_new_registration);
        assert!(refreshed.account.dirty_at.is_some());
        assert_eq!(row_count(&pool).await, 1);
    }

    #[sqlx::test]
    async fn register_or_refresh_still_rejects_non_sputnik_accounts(pool: PgPool) {
        let account: AccountId = "not-a-dao.near".parse().unwrap();
        let err = register_or_refresh_monitored_account(
            &pool,
            None,
            &account,
            false,
            RegistrationMode::RegisterOrRefresh,
        )
        .await
        .err()
        .expect("non-sputnik account must be rejected");
        assert!(matches!(err, RegisterMonitoredAccountError::NotSputnikDao));
        assert_eq!(row_count(&pool).await, 0);
    }
}

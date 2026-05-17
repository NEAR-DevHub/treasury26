//! Functions for monitored account registration and refresh.
//!
//! These helpers are shared by API routes and internal handlers.

use near_account_id::{AccountId, AccountIdRef};
use sqlx::PgPool;
use sqlx::types::chrono::{DateTime, Utc};

use crate::config::{PlanType, get_initial_credits};
use crate::utils::datetime::next_month_start_utc;

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
    Db(sqlx::Error),
}

impl From<sqlx::Error> for RegisterMonitoredAccountError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// Register a monitored account or refresh an existing one.
///
/// - Existing account: updates `dirty_at` and marks DAO as dirty.
/// - New account: creates with default Plus plan credits.
pub async fn register_or_refresh_monitored_account(
    pool: &PgPool,
    account_id: &AccountIdRef,
    is_confidential: bool,
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

    if existing.is_none() && !account_id.as_str().ends_with(".sputnik-dao.near") {
        return Err(RegisterMonitoredAccountError::NotSputnikDao);
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

    Ok(RegisterMonitoredAccountResult {
        account,
        is_new_registration: true,
    })
}

//! Background job to reset monthly plan credits.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::config::{PlanType, get_monthly_reset_credits};
use crate::utils::datetime::{duration_until_next_utc_midnight, next_month_start_utc};

/// Reset monthly credits for accounts whose reset time is due.
///
/// Returns number of accounts updated.
pub async fn reset_due_monthly_plan_credits(pool: &PgPool) -> Result<u64, sqlx::Error> {
    reset_due_monthly_plan_credits_at(pool, Utc::now()).await
}

async fn reset_due_monthly_plan_credits_at(
    pool: &PgPool,
    now: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let today_utc = now.date_naive();
    let next_reset_at = next_month_start_utc(now);
    let mut tx = pool.begin().await?;

    let due_accounts = sqlx::query!(
        r#"
        SELECT account_id,
               plan_type::text as "plan_type!",
               export_credits,
               batch_payment_credits,
               gas_covered_transactions
        FROM monitored_accounts
        WHERE (credits_reset_at AT TIME ZONE 'UTC')::date <= $1
        "#,
        today_utc
    )
    .fetch_all(&mut *tx)
    .await?;

    if due_accounts.is_empty() {
        tx.commit().await?;
        return Ok(0);
    }

    let mut updated_count = 0u64;

    for account in due_accounts {
        let plan_type = match account.plan_type.as_str() {
            "free" => PlanType::Free,
            "plus" => PlanType::Plus,
            "pro" => PlanType::Pro,
            "enterprise" => PlanType::Enterprise,
            _ => {
                log::error!(
                    "Skipping reset for {} due to unknown plan_type {}",
                    account.account_id,
                    account.plan_type
                );
                continue;
            }
        };
        let (monthly_export, monthly_batch, monthly_gas) = get_monthly_reset_credits(plan_type);

        let export_credits = monthly_export.unwrap_or(account.export_credits);
        let batch_payment_credits = monthly_batch.unwrap_or(account.batch_payment_credits);
        let gas_covered_transactions = monthly_gas.unwrap_or(account.gas_covered_transactions);

        let update_result = sqlx::query!(
            r#"
            UPDATE monitored_accounts
            SET export_credits = $2,
                batch_payment_credits = $3,
                gas_covered_transactions = $4,
                credits_reset_at = $5,
                updated_at = NOW()
            WHERE account_id = $1
            "#,
            account.account_id,
            export_credits,
            batch_payment_credits,
            gas_covered_transactions,
            next_reset_at
        )
        .execute(&mut *tx)
        .await?;

        updated_count += update_result.rows_affected();
    }

    tx.commit().await?;
    Ok(updated_count)
}

/// Run background service that resets credits at startup and then at every UTC midnight.
pub async fn run_monthly_plan_reset_service(pool: PgPool) {
    log::info!("Starting monthly plan reset service (startup + UTC midnight schedule)");

    // Run once on startup.
    match reset_due_monthly_plan_credits(&pool).await {
        Ok(updated) if updated > 0 => {
            log::info!(
                "Startup reset: monthly plan credits reset for {} account(s)",
                updated
            );
        }
        Ok(_) => {}
        Err(e) => {
            log::error!("Startup reset failed: {}", e);
        }
    }

    loop {
        let now = Utc::now();
        let sleep_for = duration_until_next_utc_midnight(now);
        let wake_at = now + chrono::Duration::from_std(sleep_for).unwrap_or_default();

        log::info!(
            "Next monthly plan reset check scheduled at {} UTC",
            wake_at.format("%Y-%m-%d %H:%M:%S")
        );

        tokio::time::sleep(sleep_for).await;

        match reset_due_monthly_plan_credits(&pool).await {
            Ok(updated) if updated > 0 => {
                log::info!(
                    "Midnight reset: monthly plan credits reset for {} account(s)",
                    updated
                );
            }
            Ok(_) => {}
            Err(e) => {
                log::error!("Midnight reset failed: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    #[sqlx::test]
    async fn test_reset_due_monthly_plan_credits(pool: PgPool) -> sqlx::Result<()> {
        sqlx::query!(
            r#"
            INSERT INTO monitored_accounts (
                account_id,
                enabled,
                export_credits,
                batch_payment_credits,
                gas_covered_transactions,
                plan_type,
                credits_reset_at
            )
            VALUES
                ('plus-reset.sputnik-dao.near', true, 1, 2, 3, 'plus', NOW() - INTERVAL '2 days'),
                ('free-reset.sputnik-dao.near', true, 0, 0, 0, 'free', NOW() - INTERVAL '1 day'),
                (
                    'plus-reset-today.sputnik-dao.near',
                    true,
                    0,
                    0,
                    0,
                    'plus',
                    (DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + INTERVAL '23 hours 59 minutes'
                )
            "#,
        )
        .execute(&pool)
        .await?;

        let updated = reset_due_monthly_plan_credits(&pool).await?;
        assert_eq!(updated, 3, "Expected three accounts to be reset");

        let plus = sqlx::query!(
            r#"
            SELECT export_credits, batch_payment_credits, gas_covered_transactions
            FROM monitored_accounts
            WHERE account_id = 'plus-reset.sputnik-dao.near'
            "#,
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(plus.export_credits, 5);
        assert_eq!(plus.batch_payment_credits, 10);
        assert_eq!(plus.gas_covered_transactions, 1000);

        let plus_due_today = sqlx::query!(
            r#"
            SELECT export_credits, batch_payment_credits, gas_covered_transactions
            FROM monitored_accounts
            WHERE account_id = 'plus-reset-today.sputnik-dao.near'
            "#,
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(plus_due_today.export_credits, 5);
        assert_eq!(plus_due_today.batch_payment_credits, 10);
        assert_eq!(plus_due_today.gas_covered_transactions, 1000);

        let free = sqlx::query!(
            r#"
            SELECT export_credits, batch_payment_credits, gas_covered_transactions
            FROM monitored_accounts
            WHERE account_id = 'free-reset.sputnik-dao.near'
            "#,
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(
            free.export_credits, 0,
            "Free trial exports should not reset monthly"
        );
        assert_eq!(
            free.batch_payment_credits, 0,
            "Free trial batch credits should not reset monthly"
        );
        assert_eq!(
            free.gas_covered_transactions, 10,
            "Sponsored tx quota should reset monthly"
        );

        let next_reset_plus: DateTime<Utc> = sqlx::query_scalar!(
            r#"
            SELECT credits_reset_at
            FROM monitored_accounts
            WHERE account_id = 'plus-reset.sputnik-dao.near'
            "#,
        )
        .fetch_one(&pool)
        .await?;
        assert!(
            next_reset_plus > Utc::now(),
            "credits_reset_at should move to next month"
        );

        Ok(())
    }

    #[sqlx::test]
    async fn test_reset_due_monthly_plan_credits_for_same_day_afternoon_reset(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        sqlx::query!(
            r#"
            INSERT INTO monitored_accounts (
                account_id,
                enabled,
                export_credits,
                batch_payment_credits,
                gas_covered_transactions,
                plan_type,
                credits_reset_at
            )
            VALUES (
                'plus-afternoon-reset.sputnik-dao.near',
                true,
                0,
                0,
                0,
                'plus',
                '2026-06-01T15:30:00Z'::timestamptz
            )
            "#,
        )
        .execute(&pool)
        .await?;

        let now =
            DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z").expect("timestamp should parse");
        let now = now.with_timezone(&Utc);

        let updated = reset_due_monthly_plan_credits_at(&pool, now).await?;
        assert_eq!(
            updated, 1,
            "Account should reset at start of day even if reset_at is 15:30"
        );

        let account = sqlx::query!(
            r#"
            SELECT export_credits, batch_payment_credits, gas_covered_transactions, credits_reset_at
            FROM monitored_accounts
            WHERE account_id = 'plus-afternoon-reset.sputnik-dao.near'
            "#,
        )
        .fetch_one(&pool)
        .await?;

        assert_eq!(account.export_credits, 5);
        assert_eq!(account.batch_payment_credits, 10);
        assert_eq!(account.gas_covered_transactions, 1000);
        assert_eq!(
            account.credits_reset_at.to_rfc3339(),
            "2026-07-01T00:00:00+00:00"
        );

        Ok(())
    }
}

//! Backfill `monitored_accounts.is_testing` from env-based rules.
//!
//! Run with:
//!   cargo run --example mark_testing_daos

use std::collections::HashSet;

use nt_be::{services::should_mark_testing, utils::env::EnvVars};
use sqlx::PgPool;

#[derive(Default)]
struct BackfillStats {
    explicit_marked: u64,
    explicit_missing: u64,
    policy_marked: u64,
    already_marked: u64,
    skipped: u64,
}

async fn mark_explicit_daos(
    pool: &PgPool,
    explicit_ids: &HashSet<String>,
    stats: &mut BackfillStats,
) -> Result<(), sqlx::Error> {
    for dao_id in explicit_ids {
        let result = sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET is_testing = true,
                updated_at = NOW()
            WHERE account_id = $1
              AND is_testing = false
            "#,
        )
        .bind(dao_id)
        .execute(pool)
        .await?;

        if result.rows_affected() > 0 {
            stats.explicit_marked += 1;
            continue;
        }

        let exists = sqlx::query_scalar::<_, i32>(
            r#"
            SELECT 1
            FROM monitored_accounts
            WHERE account_id = $1
            LIMIT 1
            "#,
        )
        .bind(dao_id)
        .fetch_optional(pool)
        .await?
        .is_some();

        if exists {
            stats.already_marked += 1;
        } else {
            stats.explicit_missing += 1;
            println!("[missing] explicit DAO not tracked: {}", dao_id);
        }
    }

    Ok(())
}

async fn backfill_from_policy_members(
    pool: &PgPool,
    explicit_ids: &HashSet<String>,
    testing_near_account_ids: &HashSet<String>,
    stats: &mut BackfillStats,
) -> Result<(), sqlx::Error> {
    let tracked_rows = sqlx::query_as::<_, (String, bool)>(
        r#"
        SELECT account_id, is_testing
        FROM monitored_accounts
        ORDER BY account_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    for (dao_id, is_testing) in tracked_rows {
        if is_testing {
            stats.already_marked += 1;
            continue;
        }

        let members: HashSet<String> = sqlx::query_scalar::<_, String>(
            r#"
            SELECT account_id
            FROM dao_members
            WHERE dao_id = $1
              AND is_policy_member = true
            "#,
        )
        .bind(&dao_id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();

        let should_mark =
            should_mark_testing(&dao_id, &members, explicit_ids, testing_near_account_ids);

        if should_mark {
            let result = sqlx::query(
                r#"
                UPDATE monitored_accounts
                SET is_testing = true,
                    updated_at = NOW()
                WHERE account_id = $1
                  AND is_testing = false
                "#,
            )
            .bind(&dao_id)
            .execute(pool)
            .await?;

            if result.rows_affected() > 0 {
                stats.policy_marked += 1;
            } else {
                stats.already_marked += 1;
            }
        } else {
            stats.skipped += 1;
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_filename("../.env").ok();
    dotenvy::from_filename(".env").ok();

    let env = EnvVars::default();
    let pool = PgPool::connect(&env.database_url).await?;

    let mut stats = BackfillStats::default();

    mark_explicit_daos(&pool, &env.testing_sputnik_dao_ids, &mut stats).await?;
    backfill_from_policy_members(
        &pool,
        &env.testing_sputnik_dao_ids,
        &env.testing_near_account_ids,
        &mut stats,
    )
    .await?;

    println!("Backfill complete.");
    println!("  explicit_marked: {}", stats.explicit_marked);
    println!("  explicit_missing: {}", stats.explicit_missing);
    println!("  policy_marked: {}", stats.policy_marked);
    println!("  already_marked: {}", stats.already_marked);
    println!("  skipped: {}", stats.skipped);

    Ok(())
}

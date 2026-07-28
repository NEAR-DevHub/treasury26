//! Database-level enforcement on the public gold ledger: every row belongs
//! to a registered treasury, keys are idempotent, and a row must carry at
//! least one asset leg.

use sqlx::PgPool;

const PUBLIC_DAO: &str = "public-dao.sputnik-dao.near";

async fn seed_account(pool: &PgPool) {
    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
        VALUES ($1, true, false)
        "#,
    )
    .bind(PUBLIC_DAO)
    .execute(pool)
    .await
    .expect("seed monitored account");
}

async fn insert_row(pool: &PgPool, dao_id: &str, key: &str, with_leg: bool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gold_treasury_ledger_events (
            gold_event_key, dao_id, source_kind,
            history_visible, transaction_type, status, event_time,
            token_in, amount_in
        )
        VALUES (
            $2, $1, 'public_silver_leg',
            TRUE, 'deposit', 'success', NOW(),
            CASE WHEN $3 THEN 'near' END, CASE WHEN $3 THEN 1 END
        )
        "#,
    )
    .bind(dao_id)
    .bind(key)
    .bind(with_leg)
    .execute(pool)
    .await
    .map(|_| ())
}

#[sqlx::test(migrations = "./migrations")]
async fn ledger_rows_are_structurally_constrained(pool: PgPool) {
    seed_account(&pool).await;

    insert_row(&pool, PUBLIC_DAO, "row-1", true)
        .await
        .expect("valid row inserts");

    // Idempotency key is unique.
    insert_row(&pool, PUBLIC_DAO, "row-1", true)
        .await
        .expect_err("duplicate gold_event_key must be rejected");

    // A row without any asset leg is meaningless.
    insert_row(&pool, PUBLIC_DAO, "row-2", false)
        .await
        .expect_err("row without a leg must be rejected");

    // Rows belong to registered treasuries only.
    insert_row(&pool, "unregistered.sputnik-dao.near", "row-3", true)
        .await
        .expect_err("unregistered DAO must be rejected by the FK");
}

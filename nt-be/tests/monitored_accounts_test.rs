mod common;

use chrono::{DateTime, Datelike, Months, Utc};
use common::TestServer;

/// Dedicated to this test: registration semantics are register-or-refresh
/// (an existing disabled row stays disabled), so the account must not exist
/// before the call for the new-registration assertions to hold.
const CRUD_TEST_ACCOUNT: &str = "monitored-accounts-crud-test.sputnik-dao.near";

#[tokio::test]
async fn test_monitored_accounts_crud() {
    common::load_test_env();

    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .expect("connect to test database");
    sqlx::query("DELETE FROM monitored_accounts WHERE account_id = $1")
        .bind(CRUD_TEST_ACCOUNT)
        .execute(&pool)
        .await
        .expect("remove leftover crud test account");

    // Start the actual server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Test 1: Add a monitored account
    // Note: AddAccountRequest uses camelCase deserialization
    let add_payload = serde_json::json!({
        "accountId": CRUD_TEST_ACCOUNT
    });

    let response = client
        .post(server.url("/api/monitored-accounts"))
        .json(&add_payload)
        .send()
        .await
        .expect("Failed to add account");

    assert_eq!(response.status(), 200, "Add account should succeed");
    // AddAccountResponse uses camelCase serialization
    let added: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    assert_eq!(added["accountId"], CRUD_TEST_ACCOUNT);
    assert_eq!(added["enabled"], true);
    assert!(added["createdAt"].is_string());
    assert!(added["updatedAt"].is_string());
    let credits_reset_at = DateTime::parse_from_rfc3339(
        added["creditsResetAt"]
            .as_str()
            .expect("creditsResetAt should be a string"),
    )
    .expect("creditsResetAt should be a valid RFC3339 datetime")
    .with_timezone(&Utc);

    let now = Utc::now();
    let expected_reset_at = DateTime::<Utc>::from_naive_utc_and_offset(
        now.date_naive()
            .with_day(1)
            .expect("day 1 should always be valid")
            .and_hms_opt(0, 0, 0)
            .expect("00:00:00 should always be valid")
            .checked_add_months(Months::new(1))
            .expect("adding one month should always be valid"),
        Utc,
    );
    assert_eq!(
        credits_reset_at, expected_reset_at,
        "New account should have credits_reset_at at next UTC month start"
    );

    // Leave no enabled fake account behind for the pipeline schedulers.
    sqlx::query("DELETE FROM monitored_accounts WHERE account_id = $1")
        .bind(CRUD_TEST_ACCOUNT)
        .execute(&pool)
        .await
        .expect("clean up crud test account");
}

mod common;

use common::TestServer;

#[tokio::test]
async fn test_monitored_accounts_crud() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Start the actual server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Test 1: Add a monitored account
    let add_payload = serde_json::json!({
        "account_id": "test-account.near",
        "enabled": true
    });

    let response = client
        .post(server.url("/api/monitored-accounts"))
        .json(&add_payload)
        .send()
        .await
        .expect("Failed to add account");

    assert_eq!(response.status(), 200, "Add account should succeed");
    let added: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    assert_eq!(added["account_id"], "test-account.near");
    assert_eq!(added["enabled"], true);
    assert!(added["created_at"].is_string());
    assert!(added["updated_at"].is_string());

    // Test 2: List all monitored accounts
    let response = client
        .get(server.url("/api/monitored-accounts"))
        .send()
        .await
        .expect("Failed to list accounts");

    assert_eq!(response.status(), 200);
    let accounts: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    assert!(accounts.is_array());
    let accounts_array = accounts.as_array().unwrap();
    assert!(accounts_array.len() >= 1, "Should have at least one account");
    
    let found = accounts_array.iter().any(|acc| acc["account_id"] == "test-account.near");
    assert!(found, "Should find test-account.near in list");

    // Test 3: List only enabled accounts
    let response = client
        .get(server.url("/api/monitored-accounts?enabled=true"))
        .send()
        .await
        .expect("Failed to list enabled accounts");

    assert_eq!(response.status(), 200);
    let enabled_accounts: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    let enabled_array = enabled_accounts.as_array().unwrap();
    
    // All accounts in this list should be enabled
    for account in enabled_array {
        assert_eq!(account["enabled"], true);
    }

    // Test 4: Update the monitored account (disable it)
    let update_payload = serde_json::json!({
        "enabled": false
    });

    let response = client
        .patch(server.url("/api/monitored-accounts/test-account.near"))
        .json(&update_payload)
        .send()
        .await
        .expect("Failed to update account");

    assert_eq!(response.status(), 200, "Update should succeed");
    let updated: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    assert_eq!(updated["account_id"], "test-account.near");
    assert_eq!(updated["enabled"], false, "Account should be disabled");

    // Test 5: Verify account is disabled in list
    let response = client
        .get(server.url("/api/monitored-accounts?enabled=false"))
        .send()
        .await
        .expect("Failed to list disabled accounts");

    assert_eq!(response.status(), 200);
    let disabled_accounts: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    let disabled_array = disabled_accounts.as_array().unwrap();
    
    let found_disabled = disabled_array.iter().any(|acc| acc["account_id"] == "test-account.near");
    assert!(found_disabled, "Should find test-account.near in disabled list");

    // Test 6: Delete the monitored account
    let response = client
        .delete(server.url("/api/monitored-accounts/test-account.near"))
        .send()
        .await
        .expect("Failed to delete account");

    assert_eq!(response.status(), 204, "Delete should return 204 No Content");

    // Test 7: Verify account is deleted
    let response = client
        .get(server.url("/api/monitored-accounts"))
        .send()
        .await
        .expect("Failed to list accounts after delete");

    assert_eq!(response.status(), 200);
    let accounts_after: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    let accounts_after_array = accounts_after.as_array().unwrap();
    
    let still_found = accounts_after_array.iter().any(|acc| acc["account_id"] == "test-account.near");
    assert!(!still_found, "Account should be deleted");

    // Test 8: Try to update non-existent account (should fail)
    let response = client
        .patch(server.url("/api/monitored-accounts/non-existent.near"))
        .json(&update_payload)
        .send()
        .await
        .expect("Failed to send update request");

    assert_eq!(response.status(), 404, "Updating non-existent account should return 404");

    // Test 9: Try to delete non-existent account (should fail)
    let response = client
        .delete(server.url("/api/monitored-accounts/non-existent.near"))
        .send()
        .await
        .expect("Failed to send delete request");

    assert_eq!(response.status(), 404, "Deleting non-existent account should return 404");

    println!("✓ All monitored accounts CRUD operations validated");
}

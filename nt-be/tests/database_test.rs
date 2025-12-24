mod common;

use common::TestServer;

#[tokio::test]
async fn test_health_endpoint() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Start the actual server
    let server = TestServer::start().await;

    // Make request to health endpoint
    let client = reqwest::Client::new();
    let response = client
        .get(server.url("/api/health"))
        .send()
        .await
        .expect("Failed to send request");

    // Assert response status
    assert_eq!(response.status(), 200);

    // Parse response body
    let json: serde_json::Value = response.json().await.expect("Failed to parse JSON");

    // Verify response structure
    assert!(json.get("status").is_some());
    assert!(json.get("timestamp").is_some());
    assert!(json.get("database").is_some());

    // Check status value
    assert_eq!(json["status"], "healthy");

    // Verify database section
    let database = &json["database"];
    assert!(database.get("connected").is_some());
    assert!(database.get("pool_size").is_some());
    assert!(database.get("idle_connections").is_some());

    // Check that database is actually connected
    assert_eq!(database["connected"], true);
    assert!(database["pool_size"].as_u64().unwrap() > 0);
}

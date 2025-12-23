use std::process::{Command, Child};
use std::time::Duration;
use tokio::time::sleep;

struct TestServer {
    process: Child,
    port: u16,
}

impl TestServer {
    async fn start() -> Self {
        // Start the server in the background
        let process = Command::new("cargo")
            .args(&["run"])
            .env("PORT", "3001")
            .env("RUST_LOG", "info")
            .spawn()
            .expect("Failed to start server");
        
        let port = 3001;
        
        // Wait for server to be ready (longer timeout for first-time compilation)
        let client = reqwest::Client::new();
        for attempt in 0..60 {
            if attempt % 10 == 0 && attempt > 0 {
                println!("Still waiting for server... (attempt {}/60)", attempt);
            }
            sleep(Duration::from_millis(500)).await;
            if let Ok(response) = client.get(format!("http://localhost:{}/api/health", port)).send().await {
                if response.status().is_success() {
                    println!("Server ready after {} attempts", attempt + 1);
                    return TestServer { process, port };
                }
            }
        }
        
        panic!("Server failed to start within timeout");
    }
    
    fn url(&self, path: &str) -> String {
        format!("http://localhost:{}{}", self.port, path)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.process.kill();
    }
}

#[tokio::test]
async fn test_health_endpoint_with_server() {
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
    
    // Assert response
    assert_eq!(response.status(), 200);
    
    // Parse response body
    let json: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    
    // Check that database is connected
    assert_eq!(json["status"], "healthy");
    assert_eq!(json["database"]["connected"], true);
    assert!(json["database"]["pool_size"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn test_health_endpoint_response_structure() {
    dotenvy::dotenv().ok();
    
    let server = TestServer::start().await;
    
    let client = reqwest::Client::new();
    let response = client
        .get(server.url("/api/health"))
        .send()
        .await
        .expect("Failed to send request");
    
    let json: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    
    // Verify response structure
    assert!(json.get("status").is_some());
    assert!(json.get("timestamp").is_some());
    assert!(json.get("database").is_some());
    
    let database = &json["database"];
    assert!(database.get("connected").is_some());
    assert!(database.get("pool_size").is_some());
    assert!(database.get("idle_connections").is_some());
}

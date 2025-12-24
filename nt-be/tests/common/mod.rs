use std::process::{Child, Command};
use std::time::Duration;
use tokio::time::sleep;

pub struct TestServer {
    process: Child,
    port: u16,
}

impl TestServer {
    pub async fn start() -> Self {
        // Start the server in the background
        let process = Command::new("cargo")
            .args(&["run", "--bin", "nf-be"])
            .env("PORT", "3001")
            .env("RUST_LOG", "info")
            .spawn()
            .expect("Failed to start server");

        let port = 3001;

        // Wait for server to be ready
        let client = reqwest::Client::new();
        for attempt in 0..60 {
            if attempt % 10 == 0 && attempt > 0 {
                println!("Still waiting for server... (attempt {}/60)", attempt);
            }
            sleep(Duration::from_millis(500)).await;
            if let Ok(response) = client
                .get(format!("http://localhost:{}/api/health", port))
                .send()
                .await
            {
                if response.status().is_success() {
                    println!("Server ready after {} attempts", attempt + 1);
                    return TestServer { process, port };
                }
            }
        }

        panic!("Server failed to start within timeout");
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://localhost:{}{}", self.port, path)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.process.kill();
    }
}

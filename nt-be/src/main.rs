use axum::Router;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    // Initialize logging
    if std::env::var("RUST_LOG").is_err() {
        unsafe {
            std::env::set_var("RUST_LOG", "info");
        }
    }
    env_logger::init();

    // Initialize application state
    let state = Arc::new(
        nt_be::init_app_state()
            .await
            .expect("Failed to initialize application state"),
    );

    // Spawn background monitoring task
    if !state.env_vars.disable_balance_monitoring {
        let state_clone = state.clone();
        tokio::spawn(async move {
            use near_api::Chain;
            use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

            // Get monitoring interval from env (required - no default)
            // If set to 0, monitoring is disabled (useful for tests)
            let interval_minutes: u64 = std::env::var("MONITOR_INTERVAL_MINUTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5); // Default to 5 minutes if not set

            if interval_minutes == 0 {
                log::info!("Background monitoring disabled (MONITOR_INTERVAL_MINUTES=0)");
                return;
            }

            let interval = Duration::from_secs(interval_minutes * 60);

            log::info!(
                "Starting background monitoring service (interval: {} minutes)",
                interval_minutes
            );

            // Wait a bit before first run to let server fully start
            tokio::time::sleep(Duration::from_secs(10)).await;

            // Use tokio::time::interval for more accurate timing
            let mut interval_timer = tokio::time::interval(interval);
            interval_timer.tick().await; // First tick completes immediately

            loop {
                log::info!("Running monitoring cycle...");

                // Get current block height from the network
                let up_to_block = match Chain::block().fetch_from(&state_clone.network).await {
                    Ok(block) => block.header.height as i64,
                    Err(e) => {
                        log::error!("Failed to get current block height: {}", e);
                        log::info!("Retrying in {} minutes", interval_minutes);
                        interval_timer.tick().await;
                        continue;
                    }
                };

                log::info!("Processing up to block {}", up_to_block);

                match run_monitor_cycle(
                    &state_clone.db_pool,
                    &state_clone.archival_network,
                    up_to_block,
                )
                .await
                {
                    Ok(()) => {
                        log::info!("Monitoring cycle completed successfully");
                    }
                    Err(e) => {
                        log::error!("Monitoring cycle failed: {}", e);
                    }
                }

                log::info!("Next monitoring cycle in {} minutes", interval_minutes);
                interval_timer.tick().await;
            }
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(nt_be::routes::create_routes(state))
        .layer(cors);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    println!("Server running on {}", addr);

    axum::serve(listener, app).await.unwrap();
}

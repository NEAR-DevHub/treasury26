use axum::{
    Router,
    http::{HeaderValue, Method, header},
};
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};

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
        nt_be::AppState::new()
            .await
            .expect("Failed to initialize application state"),
    );

    // Spawn background monitoring task
    if !state.env_vars.disable_balance_monitoring {
        let state_clone = state.clone();
        tokio::spawn(async move {
            use near_api::Chain;
            use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

            let interval_seconds = state_clone.env_vars.monitor_interval_seconds;

            if interval_seconds == 0 {
                log::info!("Background monitoring disabled (MONITOR_INTERVAL_SECONDS=0)");
                return;
            }

            let interval = Duration::from_secs(interval_seconds);

            log::info!(
                "Starting background monitoring service (interval: {} seconds)",
                interval_seconds
            );

            // Wait a bit before first run to let server fully start
            tokio::time::sleep(Duration::from_secs(10)).await;

            // Use tokio::time::interval for more accurate timing
            let mut interval_timer = tokio::time::interval(interval);

            loop {
                interval_timer.tick().await;

                log::info!("Running monitoring cycle...");

                // Get current block height from the network
                let up_to_block = match Chain::block().fetch_from(&state_clone.network).await {
                    Ok(block) => block.header.height as i64,
                    Err(e) => {
                        log::error!("Failed to get current block height: {}", e);
                        log::info!("Retrying in {} seconds", interval_seconds);
                        continue;
                    }
                };

                log::info!("Processing up to block {}", up_to_block);

                match run_monitor_cycle(
                    &state_clone.db_pool,
                    &state_clone.archival_network,
                    up_to_block,
                    state_clone.transfer_hint_service.as_ref(),
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

                log::info!("Next monitoring cycle in {} seconds", interval_seconds);
            }
        });
    }

    // Spawn background price sync service
    {
        let pool = state.db_pool.clone();
        let http_client = state.http_client.clone();
        let base_url = state.env_vars.defillama_api_base_url.clone();
        tokio::spawn(async move {
            let provider = nt_be::services::DeFiLlamaClient::with_base_url(http_client, base_url);
            nt_be::services::run_price_sync_service(pool, provider).await;
        });
    }

    // Spawn bulk payment payout worker
    {
        let state_clone = state.clone();
        tokio::spawn(async move {
            log::info!("Starting bulk payment payout worker (5 second poll interval)");

            // Wait a bit before first run to let server fully start
            tokio::time::sleep(Duration::from_secs(15)).await;

            let mut interval_timer = tokio::time::interval(Duration::from_secs(5));

            loop {
                interval_timer.tick().await;

                // Query the bulk payment contract for pending lists
                match nt_be::handlers::bulkpayment::worker::query_and_process_pending_lists(
                    &state_clone,
                )
                .await
                {
                    Ok(processed) => {
                        if processed > 0 {
                            log::info!("Processed {} payment batches", processed);
                        }
                    }
                    Err(e) => {
                        log::error!("Payout worker error: {}", e);
                    }
                }
            }
        });
    }

    // Spawn DAO list sync service (fetches DAOs from sputnik-dao.near every 5 minutes)
    {
        let pool = state.db_pool.clone();
        let network = state.network.clone();
        tokio::spawn(async move {
            nt_be::services::run_dao_list_sync_service(pool, network).await;
        });
    }

    // Spawn DAO policy sync service (processes dirty/stale DAOs to extract members)
    {
        let pool = state.db_pool.clone();
        let network = state.network.clone();
        tokio::spawn(async move {
            nt_be::services::run_dao_policy_sync_service(pool, network).await;
        });
    }

    // Configure CORS - must specify exact origins, methods, and headers when using credentials
    let origins: Vec<HeaderValue> = state
        .env_vars
        .cors_allowed_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::ORIGIN,
            header::COOKIE,
        ])
        .allow_credentials(true);

    let app = Router::new()
        .merge(nt_be::routes::create_routes(state))
        .layer(cors);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    println!("Server running on {}", addr);

    axum::serve(listener, app).await.unwrap();
}

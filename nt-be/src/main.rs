use axum::{
    Router,
    http::{HeaderValue, Method, header},
};
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(4 * 1024 * 1024) // 8 MB stack per worker thread
        .build()
        .unwrap()
        .block_on(async_main());
}

async fn async_main() {
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

    // Spawn account maintenance worker (processes dirty accounts every 5 minutes)
    // Replaces the previous main monitor (30s, all accounts) and dirty monitor (5s poll).
    // Goldsky enrichment worker is now the primary event source for ongoing monitoring.
    if !state.env_vars.disable_balance_monitoring {
        let state_clone = state.clone();
        tokio::spawn(async move {
            use near_api::Chain;
            use nt_be::handlers::balance_changes::account_monitor::run_maintenance_cycle;

            let interval_secs = std::env::var("MAINTENANCE_INTERVAL_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(60); // default 60 seconds
            let initial_delay_secs = std::env::var("MAINTENANCE_INITIAL_DELAY_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30u64);
            let interval = Duration::from_secs(interval_secs);

            log::info!(
                "Starting account maintenance worker ({}s interval, {}s initial delay)",
                interval_secs,
                initial_delay_secs
            );

            // Wait for server to fully start
            tokio::time::sleep(Duration::from_secs(initial_delay_secs)).await;

            let mut interval_timer = tokio::time::interval(interval);

            loop {
                interval_timer.tick().await;

                // Get current block height from the network
                let up_to_block = match Chain::block().fetch_from(&state_clone.network).await {
                    Ok(block) => block.header.height as i64,
                    Err(e) => {
                        log::error!("[maintenance] Failed to get current block height: {}", e);
                        continue;
                    }
                };

                match run_maintenance_cycle(&state_clone, up_to_block).await {
                    Ok(()) => {}
                    Err(e) => {
                        log::error!("[maintenance] Cycle failed: {}", e);
                    }
                }
            }
        });
    }

    // Spawn confidential treasury balance-polling worker (every 5 minutes by default).
    // Owns the "incoming" side (deposits + solver swap fulfillments) for confidential
    // DAOs. Outgoing legs are produced by the Goldsky enrichment worker.
    if !state.env_vars.disable_balance_monitoring {
        let state_clone = state.clone();
        tokio::spawn(async move {
            use nt_be::handlers::balance_changes::confidential_monitor::run_confidential_poll_cycle;

            let interval_secs = std::env::var("CONFIDENTIAL_POLL_INTERVAL_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300u64); // 5 minutes
            let initial_delay = std::env::var("CONFIDENTIAL_POLL_INITIAL_DELAY_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(45u64);

            log::info!(
                "Starting confidential poll worker ({}s interval, {}s initial delay)",
                interval_secs,
                initial_delay
            );

            tokio::time::sleep(Duration::from_secs(initial_delay)).await;
            let mut timer = tokio::time::interval(Duration::from_secs(interval_secs));
            loop {
                timer.tick().await;
                if let Err(e) = run_confidential_poll_cycle(&state_clone).await {
                    log::error!("[confidential-poll] cycle failed: {}", e);
                }
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

    // TODO: Re-enable once we have a DefiLlama API key or higher rate limit
    // Spawn usd_value backfill service
    // {
    //     let pool = state.db_pool.clone();
    //     let http_client = state.http_client.clone();
    //     let base_url = state.env_vars.defillama_api_base_url.clone();
    //     tokio::spawn(async move {
    //         let client = nt_be::services::DeFiLlamaClient::with_base_url(http_client, base_url);
    //         nt_be::services::run_usd_value_backfill_service(pool, client).await;
    //     });
    // }

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

    // Spawn Goldsky enrichment worker (reads from Goldsky sink DB, writes to app DB)
    if let Some(goldsky_pool) = &state.goldsky_pool {
        let goldsky_pool = goldsky_pool.clone();
        let app_pool = state.db_pool.clone();
        let network = state.archival_network.clone();
        let intents_api_key = state.env_vars.intents_explorer_api_key.clone();
        let intents_api_url = state.env_vars.intents_explorer_api_url.clone();
        tokio::spawn(async move {
            use nt_be::handlers::balance_changes::goldsky_enrichment::run_enrichment_cycle;

            const BATCH_SIZE: usize = 100;
            let enrichment_initial_delay = std::env::var("ENRICHMENT_INITIAL_DELAY_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10u64);
            let enrichment_interval = std::env::var("ENRICHMENT_INTERVAL_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(15u64);
            log::info!(
                "Starting Goldsky enrichment worker ({}s interval, {}s initial delay)",
                enrichment_interval,
                enrichment_initial_delay
            );

            // Wait for server to fully start
            tokio::time::sleep(Duration::from_secs(enrichment_initial_delay)).await;

            loop {
                let should_sleep = {
                    match run_enrichment_cycle(
                        &goldsky_pool,
                        &app_pool,
                        &network,
                        intents_api_key.as_deref(),
                        &intents_api_url,
                    )
                    .await
                    {
                        Ok(processed) => {
                            if processed > 0 {
                                log::info!(
                                    "[goldsky-enrichment] Processed {} outcomes this cycle",
                                    processed
                                );
                            }
                            // If batch was full, there's likely more data — skip the sleep
                            processed < BATCH_SIZE
                        }
                        Err(e) => {
                            log::error!("[goldsky-enrichment] Enrichment cycle failed: {}", e);
                            true
                        }
                    }
                };
                if should_sleep {
                    tokio::time::sleep(Duration::from_secs(enrichment_interval)).await;
                }
            }
        });
    } else {
        log::info!("Goldsky enrichment worker disabled (GOLDSKY_DATABASE_URL not set)");
    }

    // Spawn notification worker (event detection + Telegram dispatch)
    nt_be::handlers::notifications::run_notification_loop(
        state.clone(),
        state.telegram_client.clone(),
        state.env_vars.frontend_base_url.clone(),
    );

    // Spawn sponsor balance monitor (low-balance ops alerts)
    nt_be::services::run_sponsor_balance_monitor_loop(state.clone(), state.telegram_client.clone());

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

    // Spawn subscription monthly credit reset service
    {
        let pool = state.db_pool.clone();
        tokio::spawn(async move {
            nt_be::handlers::subscription::run_monthly_plan_reset_service(pool).await;
        });
    }

    // Spawn public dashboard daily refresh service
    if !state.env_vars.disable_stats_generation {
        let state_clone = state.clone();
        tokio::spawn(async move {
            nt_be::services::run_public_dashboard_refresh_service(state_clone).await;
        });
    }

    // Spawn FT lockup DAO schedule refresh service (every 6 hours).
    if !state.env_vars.disable_ft_lockup_scheduler {
        let state_clone = state.clone();
        tokio::spawn(async move {
            nt_be::services::run_ft_lockup_schedule_refresh_service(state_clone).await;
        });
    } else {
        log::info!("FT lockup scheduler disabled (DISABLE_FT_LOCKUP_SCHEDULER=true)");
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

    let open_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::ACCEPT]);

    let app = Router::new()
        .merge(nt_be::routes::create_routes(state.clone()).layer(cors))
        .merge(
            Router::new()
                .route(
                    "/api/user/create",
                    axum::routing::post(nt_be::handlers::user::create::create_user_account),
                )
                .with_state(state)
                .layer(open_cors),
        );

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    println!("Server running on {}", addr);

    axum::serve(listener, app).await.unwrap();
}

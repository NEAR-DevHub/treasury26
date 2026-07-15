use axum::{
    Router,
    body::Body,
    http::Request,
    http::{HeaderValue, Method, header},
};
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use std::sync::Arc;
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

    let _observability_guard = nt_be::observability::init_observability();

    // Initialize application state
    let state = Arc::new(
        nt_be::AppState::new()
            .await
            .expect("Failed to initialize application state"),
    );

    // All background jobs run as apalis workers: cron schedules piped into
    // per-job Postgres queues (see src/jobs/). The returned registry backs
    // the apalis-board web UI, mounted below on the main HTTP service.
    let (job_queues, jobs_monitor) = nt_be::jobs::spawn_all(state.clone()).await;
    let board = nt_be::jobs::board_router(&job_queues, state.clone());

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
        )
        // apalis-board (jobs UI + API) on the same listener, behind Basic
        // Auth. It answers only paths no other route matched; its API guard
        // keeps unknown public `/api/*` a plain 404.
        .fallback_service(board)
        .layer(SentryHttpLayer::new().enable_transaction())
        .layer(NewSentryLayer::<Request<Body>>::new_from_top());

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    tracing::info!(addr = %addr, "server running");

    // The jobs monitor installs tokio SIGINT/SIGTERM handlers, which replace
    // the OS default "terminate on signal" for the whole process — so the
    // HTTP server must observe the same signal itself, or Ctrl-C stops the
    // jobs but the process lives forever.
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = nt_be::jobs::shutdown_signal().await;
            tracing::info!("shutdown signal received; stopping http server");
            // Graceful shutdown waits for open connections to close, and the
            // apalis-board dashboard holds an SSE stream open indefinitely —
            // so cap the wait, and honour a second Ctrl-C as "exit now".
            tokio::spawn(async {
                tokio::select! {
                    _ = nt_be::jobs::shutdown_signal() => {
                        tracing::warn!("second shutdown signal; forcing exit");
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                        tracing::warn!("graceful shutdown exceeded 60s; forcing exit");
                    }
                }
                std::process::exit(0);
            });
        })
        .await
        .unwrap();

    // Server is down; give the jobs monitor a bounded window to finish
    // draining in-flight tasks before the runtime (and its tasks) drop.
    match tokio::time::timeout(std::time::Duration::from_secs(30), jobs_monitor).await {
        Ok(_) => tracing::info!("jobs monitor drained; exiting"),
        Err(_) => tracing::warn!("jobs monitor did not drain within 30s; exiting anyway"),
    }
}

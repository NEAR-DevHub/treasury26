use axum::{
    Router,
    body::Body,
    http::Request,
    http::{HeaderValue, Method, header},
};
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::{DefaultOnFailure, TraceLayer};

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

    // Every instance serves prices from the in-memory token snapshot; the
    // ingest cron that writes the underlying table runs only on the jobs
    // leader, so each process refreshes its own snapshot.
    state.token_price_service.spawn_snapshot_refresher();

    let shutdown = CancellationToken::new();
    let signal_shutdown = shutdown.clone();
    tokio::spawn(async move {
        let _ = nt_be::jobs::shutdown_signal().await;
        signal_shutdown.cancel();
    });

    // All background jobs run as apalis workers: cron schedules piped into
    // per-job Postgres queues (see src/jobs/). The returned registry backs
    // the apalis-board web UI, mounted below on the main HTTP service.
    let (job_queues, jobs_leadership) =
        nt_be::jobs::spawn_all(state.clone(), shutdown.clone()).await;
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

    // The Trezu Wallet connector script polls these reads from arbitrary dapp
    // origins, so they are served without credentials to any origin.
    let open_get_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::ACCEPT]);

    let app = Router::new()
        .merge(nt_be::routes::create_routes(state.clone()).layer(cors))
        .merge(nt_be::routes::create_wallet_adapter_routes(state.clone()).layer(open_get_cors))
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
        // tower-http's standard request tracing. Its default
        // `ServerErrorsAsFailures` classifier logs 5xx responses via
        // `on_failure` at ERROR — which the sentry-tracing layer turns into a
        // Sentry event — while 4xx are not failures, so client errors don't
        // alarm. The span (INFO) also gives every handler log line request
        // context (method/path/request_id). This replaces a hand-rolled
        // middleware with the ecosystem-standard layer.
        //
        // Innermost of these three so it runs inside the per-request Sentry hub
        // bound by `NewSentryLayer`: the 5xx event is then captured with the
        // request's scope/context.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request<Body>| {
                    tracing::info_span!(
                        "http_request",
                        method = %request.method(),
                        path = %request.uri().path(),
                        request_id = %uuid::Uuid::new_v4(),
                    )
                })
                .on_failure(DefaultOnFailure::new().level(tracing::Level::ERROR)),
        )
        .layer(SentryHttpLayer::new().enable_transaction())
        .layer(NewSentryLayer::<Request<Body>>::new_from_top());

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    tracing::info!(addr = %addr, "server running");

    // The shared signal watcher installs tokio SIGINT/SIGTERM handlers, which
    // replace the OS default "terminate on signal" for the whole process —
    // so the HTTP server and every background worker observe the same token.
    let http_shutdown = shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            http_shutdown.cancelled().await;
            tracing::info!("shutdown signal received; stopping http server");
            // Graceful shutdown waits for open connections to close, and the
            // apalis-board dashboard holds an SSE stream open indefinitely —
            // so cap the wait, and honour a second Ctrl-C as "exit now".
            tokio::spawn(async {
                tokio::select! {
                    _ = nt_be::jobs::shutdown_signal() => {
                        tracing::warn!("second shutdown signal; forcing exit");
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(80)) => {
                        tracing::warn!("graceful shutdown exceeded 80s; forcing exit");
                    }
                }
                std::process::exit(0);
            });
        })
        .await
        .unwrap();

    // Server is down; give leadership enough time to drain all workers and
    // release its session lock before Render's 90-second hard limit.
    match tokio::time::timeout(std::time::Duration::from_secs(50), jobs_leadership).await {
        Ok(_) => tracing::info!("background jobs drained; exiting"),
        Err(_) => tracing::warn!("background jobs did not drain within 50s; exiting anyway"),
    }
}

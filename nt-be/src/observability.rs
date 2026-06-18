use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Initialize backend logging through tracing.
///
/// This intentionally mirrors the previous logger behavior: when RUST_LOG is
/// not set, use `info`.
pub fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let subscriber = tracing_subscriber::registry().with(env_filter).with(
        fmt::layer()
            .with_target(true)
            .with_thread_ids(false)
            .with_thread_names(false),
    );

    let _ = subscriber.try_init();
}

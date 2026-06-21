//! One chokepoint for fire-and-forget work whose failure must not affect the relay
//! response (usage accounting, metrics, confidential auto-submit).
//!
//! `tokio::spawn` already isolates panics; this wrapper just labels the task so its
//! lifecycle is traceable and the intent ("this is non-critical") is explicit at the
//! call site.

use std::future::Future;

/// Spawn `fut` detached, tagged with `label` for tracing.
pub fn spawn<F>(label: &'static str, fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        tracing::debug!("relay background task '{label}' started");
        fut.await;
        tracing::debug!("relay background task '{label}' finished");
    });
}

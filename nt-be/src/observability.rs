use apalis_board::axum::sse::{TracingBroadcaster, TracingSubscriber};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tracing::Level;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Shared log broadcaster feeding the apalis-board dashboard's live-log SSE
/// pane. Created once: the tracing layer below writes every event to it, and
/// `jobs::board_router` serves it as the `/api/v1/events` extension. Cheap
/// when no dashboard client is connected (the broadcaster fans out to zero
/// receivers).
pub static LOG_BROADCASTER: Lazy<Arc<Mutex<TracingBroadcaster>>> =
    Lazy::new(TracingBroadcaster::create);

const REDACTED: &str = "[REDACTED]";
const MAX_SANITIZED_TEXT_LEN: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LogFormat {
    Pretty,
    Json,
}

static JWT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b")
        .expect("JWT redaction regex should compile")
});

static SENSITIVE_KV_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?ix)
        (\b(?:accessToken|access_token|refreshToken|refresh_token|token|jwt|secret|apiKey|api_key|authorization)\b
        \s*[:=]\s*)
        (?:String\(".*?"\)|"[^"]*"|'[^']*'|[^\s,}\]]+)
        "#,
    )
    .expect("sensitive key-value redaction regex should compile")
});

/// Keeps Sentry initialized for the lifetime of the process.
#[must_use]
pub struct ObservabilityGuard {
    _sentry: Option<sentry::ClientInitGuard>,
}

/// Initialize tracing and optional Sentry error reporting.
///
/// Sentry is enabled only when `SENTRY_DSN` is set to a non-empty valid DSN.
pub fn init_observability() -> ObservabilityGuard {
    let sentry_guard = init_sentry();
    init_tracing_subscriber(sentry_guard.is_some());
    ObservabilityGuard {
        _sentry: sentry_guard,
    }
}

/// Initialize backend logging through tracing.
///
/// This intentionally mirrors the previous logger behavior: when RUST_LOG is
/// not set, use `info`. Tests can call this repeatedly without panicking.
pub fn init_tracing() {
    init_tracing_subscriber(false);
}

fn init_tracing_subscriber(enable_sentry: bool) {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let log_format = log_format_from_env_value(std::env::var("LOG_FORMAT").ok().as_deref());

    // `Option<Layer>` is itself a `Layer` whose `None` variant is a no-op, so a
    // single registry build covers both the Sentry-on and Sentry-off cases. The
    // layer is generic over the subscriber type, so it is constructed inside each
    // format arm where the concrete registry type is known.
    match log_format {
        LogFormat::Json => {
            let fmt_layer = fmt::layer()
                .json()
                .flatten_event(true)
                .with_current_span(true)
                .with_target(true)
                .with_thread_ids(false)
                .with_thread_names(false);
            let sentry_layer = enable_sentry
                .then(|| sentry::integrations::tracing::layer().event_filter(sentry_event_filter));
            let _ = tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .with(sentry_layer)
                .with(TracingSubscriber::new(&LOG_BROADCASTER).layer())
                .try_init();
        }
        LogFormat::Pretty => {
            let fmt_layer = fmt::layer()
                .with_target(true)
                .with_thread_ids(false)
                .with_thread_names(false);
            let sentry_layer = enable_sentry
                .then(|| sentry::integrations::tracing::layer().event_filter(sentry_event_filter));
            let _ = tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .with(sentry_layer)
                .with(TracingSubscriber::new(&LOG_BROADCASTER).layer())
                .try_init();
        }
    }
}

fn sentry_event_filter(
    metadata: &tracing::Metadata<'_>,
) -> sentry::integrations::tracing::EventFilter {
    match *metadata.level() {
        Level::ERROR => sentry::integrations::tracing::EventFilter::Event,
        Level::WARN | Level::INFO | Level::DEBUG => {
            sentry::integrations::tracing::EventFilter::Breadcrumb
        }
        Level::TRACE => sentry::integrations::tracing::EventFilter::Ignore,
    }
}

fn log_format_from_env_value(raw: Option<&str>) -> LogFormat {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.eq_ignore_ascii_case("json") => LogFormat::Json,
        Some(value) if value.eq_ignore_ascii_case("pretty") => LogFormat::Pretty,
        _ => LogFormat::Pretty,
    }
}

fn init_sentry() -> Option<sentry::ClientInitGuard> {
    let dsn = sentry_dsn_from_env_value(std::env::var("SENTRY_DSN").ok().as_deref())?;
    let dsn = match dsn.parse() {
        Ok(dsn) => dsn,
        Err(e) => {
            eprintln!("Invalid SENTRY_DSN; Sentry disabled: {e}");
            return None;
        }
    };

    Some(sentry::init(sentry::ClientOptions {
        dsn: Some(dsn),
        environment: non_empty_env("SENTRY_ENVIRONMENT").map(Into::into),
        release: Some(
            non_empty_env("SENTRY_RELEASE")
                .unwrap_or_else(|| format!("nt-be@{}", env!("CARGO_PKG_VERSION")))
                .into(),
        ),
        sample_rate: parse_sample_rate(std::env::var("SENTRY_SAMPLE_RATE").ok().as_deref(), 1.0),
        traces_sample_rate: parse_sample_rate(
            std::env::var("SENTRY_TRACES_SAMPLE_RATE").ok().as_deref(),
            0.0,
        ),
        send_default_pii: false,
        before_send: Some(Arc::new(|mut event| {
            redact_sentry_request_headers(&mut event);
            Some(event)
        })),
        ..Default::default()
    }))
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn sentry_dsn_from_env_value(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_sample_rate(raw: Option<&str>, default: f32) -> f32 {
    raw.and_then(|value| value.parse::<f32>().ok())
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(default)
}

fn redact_sentry_request_headers(event: &mut sentry::protocol::Event<'static>) {
    let Some(request) = event.request.as_mut() else {
        return;
    };

    let sensitive_keys: Vec<_> = request
        .headers
        .keys()
        .filter(|key| is_sensitive_header(key.as_str()))
        .cloned()
        .collect();

    for key in sensitive_keys {
        request.headers.insert(key, REDACTED.to_string());
    }
}

fn is_sensitive_header(key: &str) -> bool {
    matches!(
        normalize_key(key).as_str(),
        "authorization" | "cookie" | "setcookie" | "xapikey" | "xtelegrambotapisecrettoken"
    )
}

fn is_sensitive_json_key(key: &str) -> bool {
    matches!(
        normalize_key(key).as_str(),
        "accesstoken" | "refreshtoken" | "token" | "jwt" | "secret" | "apikey" | "authorization"
    )
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|ch| *ch != '_' && *ch != '-' && *ch != '.')
        .flat_map(char::to_lowercase)
        .collect()
}

/// Return a clone of `value` with sensitive fields redacted.
pub fn sanitize_sensitive_json_value(value: &Value) -> Value {
    let mut sanitized = value.clone();
    redact_json_value(&mut sanitized);
    sanitized
}

fn redact_json_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_sensitive_json_key(key) {
                    *child = Value::String(REDACTED.to_string());
                } else {
                    redact_json_value(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_json_value(item);
            }
        }
        Value::String(text) => {
            *text = sanitize_sensitive_text(text);
        }
        _ => {}
    }
}

/// Redact token-like values and truncate upstream response text before logging
/// or returning it to callers.
pub fn sanitize_sensitive_text(input: &str) -> String {
    let mut output = if let Ok(mut value) = serde_json::from_str::<Value>(input) {
        redact_json_value(&mut value);
        value.to_string()
    } else {
        input.to_string()
    };

    output = SENSITIVE_KV_RE
        .replace_all(&output, |captures: &regex::Captures<'_>| {
            format!("{}{}", &captures[1], REDACTED)
        })
        .to_string();
    output = JWT_RE.replace_all(&output, REDACTED).to_string();

    truncate_sanitized_text(output)
}

fn truncate_sanitized_text(mut text: String) -> String {
    if text.len() <= MAX_SANITIZED_TEXT_LEN {
        return text;
    }

    let mut end = MAX_SANITIZED_TEXT_LEN;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("...[truncated]");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The apalis-board layer must forward events emitted inside an apalis
    /// `task` span to the broadcaster — that's what the dashboard's `/events`
    /// SSE endpoint streams. It filters to `span.is_some()`, so only
    /// task-span logs reach the pane; this pins that the wiring produces them.
    #[tokio::test]
    async fn board_layer_streams_task_span_logs() {
        use futures::StreamExt;

        let broadcaster = TracingBroadcaster::create();
        let mut client = broadcaster.lock().unwrap().new_client();
        let subscriber = tracing_subscriber::registry()
            .with(EnvFilter::new("info"))
            .with(TracingSubscriber::new(&broadcaster).layer());

        tracing::subscriber::with_default(subscriber, || {
            // Mirrors the span apalis' TraceLayer opens per task.
            let span = tracing::info_span!("task", task_id = "t-1", attempt = 0_i64);
            span.in_scope(|| tracing::info!("inside a task"));
            // A log outside any task span (general app log).
            tracing::info!("outside any span");
        });

        let mut with_span = 0;
        let mut without_span = 0;
        while let Ok(Some(Ok(entry))) =
            tokio::time::timeout(std::time::Duration::from_millis(500), client.next()).await
        {
            if entry.span.is_some() {
                with_span += 1;
            } else {
                without_span += 1;
            }
        }
        // The task-span log is captured (the SSE endpoint keeps it); the
        // spanless one is captured too but would be dropped by the endpoint's
        // `span.is_some()` filter — the board only shows task logs by design.
        assert_eq!(with_span, 1, "task-span log must reach the broadcaster");
        assert_eq!(without_span, 1);
    }

    #[test]
    fn sentry_dsn_from_env_value_requires_non_empty_value() {
        assert_eq!(sentry_dsn_from_env_value(None), None);
        assert_eq!(sentry_dsn_from_env_value(Some("")), None);
        assert_eq!(sentry_dsn_from_env_value(Some("   ")), None);
        assert_eq!(
            sentry_dsn_from_env_value(Some(" https://public@example.com/1 ")).as_deref(),
            Some("https://public@example.com/1")
        );
    }

    #[test]
    fn sample_rate_parsing_falls_back_for_invalid_values() {
        assert_eq!(parse_sample_rate(None, 0.25), 0.25);
        assert_eq!(parse_sample_rate(Some("bad"), 0.25), 0.25);
        assert_eq!(parse_sample_rate(Some("-0.1"), 0.25), 0.25);
        assert_eq!(parse_sample_rate(Some("1.1"), 0.25), 0.25);
        assert_eq!(parse_sample_rate(Some("0.5"), 0.25), 0.5);
    }

    #[test]
    fn log_format_parsing_defaults_to_pretty() {
        assert_eq!(log_format_from_env_value(None), LogFormat::Pretty);
        assert_eq!(log_format_from_env_value(Some("")), LogFormat::Pretty);
        assert_eq!(
            log_format_from_env_value(Some("unknown")),
            LogFormat::Pretty
        );
        assert_eq!(log_format_from_env_value(Some("pretty")), LogFormat::Pretty);
        assert_eq!(log_format_from_env_value(Some("json")), LogFormat::Json);
        assert_eq!(log_format_from_env_value(Some(" JSON ")), LogFormat::Json);
    }

    #[test]
    fn redacts_sensitive_json_fields() {
        let value = serde_json::json!({
            "accessToken": "access.jwt.value",
            "refreshToken": "refresh.jwt.value",
            "nested": {
                "apiKey": "key",
                "tokenId": "nep141:wrap.near"
            }
        });

        let sanitized = sanitize_sensitive_json_value(&value);

        assert_eq!(sanitized["accessToken"], REDACTED);
        assert_eq!(sanitized["refreshToken"], REDACTED);
        assert_eq!(sanitized["nested"]["apiKey"], REDACTED);
        assert_eq!(sanitized["nested"]["tokenId"], "nep141:wrap.near");
    }

    #[test]
    fn redacts_jwt_shaped_text_and_debug_key_values() {
        let input = r#"accessToken": String("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkYW8ifQ.signaturevalue1234567890"), "expiresIn": Number(900)"#;
        let sanitized = sanitize_sensitive_text(input);

        assert!(!sanitized.contains("eyJhbGci"));
        assert!(sanitized.contains(REDACTED));
        assert!(sanitized.contains("expiresIn"));
    }
}

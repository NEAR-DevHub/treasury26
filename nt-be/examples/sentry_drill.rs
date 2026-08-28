//! Alerting drill: fire one event per error code through the real
//! observability pipeline (sentry-tracing layer -> scrub -> fingerprint) so
//! Sentry -> Discord alert rules can be verified end to end.
//!
//! Usage:
//!   SENTRY_DSN=... SENTRY_ENVIRONMENT=production RUST_LOG=info \
//!     cargo run --example sentry_drill
//!
//! Expected in Discord (per docs/RUNBOOKS.md rules):
//!   - every p0 and p1 event, immediately
//!   - PROPOSAL_EXECUTION_FAILED (3 events -> frequency rule)
//!   - BULK_PAYOUT_FAILED (5 events -> frequency rule)
//! Expected in Sentry ONLY (never Discord):
//!   - all other p2 events, the untagged error, and no event at all for warn!

use std::{thread::sleep, time::Duration};

fn pace() {
    sleep(Duration::from_millis(200));
}

fn main() {
    let _guard = nt_be::observability::init_observability();

    // A warn must become a breadcrumb, never its own Sentry event.
    tracing::warn!("[DRILL] warn-level noise; must NOT create a Sentry event");

    // ---- p0 ----
    tracing::error!(
        tags.error_code = "CONF_INTENT_SUBMIT_FAILED",
        tags.alert_priority = "p0",
        dao = "drill.sputnik-dao.near",
        "[DRILL] 1Click rejected the signed intent; row now failed, nothing retries it"
    );
    pace();
    tracing::error!(
        tags.error_code = "CONF_INTENT_SIG_PARSE_FAILED",
        tags.alert_priority = "p0",
        dao = "drill.sputnik-dao.near",
        "[DRILL] MPC signature present but unparseable; intent stuck pending"
    );
    pace();
    tracing::error!(
        tags.error_code = "CONF_INTENT_MARK_FAILED_LOST",
        tags.alert_priority = "p0",
        dao = "drill.sputnik-dao.near",
        "[DRILL] submit failed AND failed-status write lost; row looks pending forever"
    );
    pace();
    tracing::error!(
        tags.error_code = "FLEET_STALLED",
        tags.alert_priority = "p0",
        "[DRILL] most job queues stale or DB unreachable; process would self-restart"
    );
    pace();

    // ---- p1 ----
    tracing::error!(
        tags.error_code = "RELAY_SUBMIT_FAILED",
        tags.alert_priority = "p1",
        "[DRILL] sponsor-signed submission 5xx; proposal creation/votes blocked"
    );
    pace();
    // Fired twice with different DAOs: both must land in ONE Sentry issue
    // (grouping check) and page once.
    tracing::error!(
        tags.error_code = "EXCHANGE_TERMINAL_FAILED",
        tags.alert_priority = "p1",
        dao = "drill-a.sputnik-dao.near",
        proposal_id = 101_i64,
        "[DRILL] exchange ended REFUNDED (grouping check A)"
    );
    pace();
    tracing::error!(
        tags.error_code = "EXCHANGE_TERMINAL_FAILED",
        tags.alert_priority = "p1",
        dao = "drill-b.sputnik-dao.near",
        proposal_id = 202_i64,
        "[DRILL] exchange ended INCOMPLETE_DEPOSIT (grouping check B)"
    );
    pace();
    tracing::error!(
        tags.error_code = "PAYMENT_TERMINAL_FAILED",
        tags.alert_priority = "p1",
        dao = "drill.sputnik-dao.near",
        proposal_id = 303_i64,
        "[DRILL] cross-chain payment ended FAILED"
    );
    pace();
    tracing::error!(
        tags.error_code = "VERIFICATION_GATE_FAILED",
        tags.alert_priority = "p1",
        dao = "drill.sputnik-dao.near",
        "[DRILL] ledger failed on-chain verification; chart unavailable/stale"
    );
    pace();
    tracing::error!(
        tags.error_code = "TREASURY_CREATE_GAVE_UP",
        tags.alert_priority = "p1",
        "[DRILL] creation sweeper exhausted retries; treasury half-created"
    );
    pace();
    tracing::error!(
        tags.error_code = "ALERT_TELEGRAM_SEND_FAILED",
        tags.alert_priority = "p1",
        "[DRILL] legacy direct-Telegram path failing"
    );
    pace();
    tracing::error!(
        tags.error_code = "CONFIG_INVALID_CORS_ORIGIN",
        tags.alert_priority = "p1",
        "[DRILL] allowed origin failed to parse at boot"
    );
    pace();

    // ---- p2 (Sentry inbox only, EXCEPT the two frequency rules) ----
    for i in 1..=3 {
        tracing::error!(
            tags.error_code = "PROPOSAL_EXECUTION_FAILED",
            tags.alert_priority = "p2",
            attempt = i,
            "[DRILL] proposal execution failed (frequency rule: >=3/1h should page)"
        );
        pace();
    }
    for i in 1..=5 {
        tracing::error!(
            tags.error_code = "BULK_PAYOUT_FAILED",
            tags.alert_priority = "p2",
            attempt = i,
            "[DRILL] bulk payout attempt failed (frequency rule: >=5/30min should page)"
        );
        pace();
    }
    tracing::error!(
        tags.error_code = "JOB_STALE",
        tags.alert_priority = "p2",
        queue = "drill-queue",
        "[DRILL] one queue not progressing"
    );
    pace();
    tracing::error!(
        tags.error_code = "VERIFICATION_HEAD_DRIFT",
        tags.alert_priority = "p2",
        dao = "drill.sputnik-dao.near",
        "[DRILL] head drift within gate tolerance"
    );
    pace();
    tracing::error!(
        tags.error_code = "BULK_PAYOUT_STATE_WRITE_FAILED",
        tags.alert_priority = "p2",
        "[DRILL] payout state write failed"
    );
    pace();
    tracing::error!(
        tags.error_code = "DEPOSIT_ADDRESS_FAILED",
        tags.alert_priority = "p2",
        "[DRILL] deposit address fetch failed"
    );
    pace();
    tracing::error!(
        tags.error_code = "RELAY_SPEND_RECORD_FAILED",
        tags.alert_priority = "p2",
        "[DRILL] relay spend record write failed"
    );
    pace();

    // ---- noise / scrub checks ----
    // Untagged error: Sentry inbox only, must NOT reach Discord.
    // Also the scrub check: the JWT and token below must show as [REDACTED].
    tracing::error!(
        "[DRILL] untagged error; scrub check token=super-secret-value jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkcmlsbCJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1Njc4OTA must be [REDACTED]"
    );

    // Let the async transport flush before exit (guard drop also flushes).
    sleep(Duration::from_secs(3));
    println!("drill complete: 23 error events sent (20 issues expected after grouping)");
}

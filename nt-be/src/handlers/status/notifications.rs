//! Telegram message construction for the warnings / status system.
//!
//! All ops-channel alerts — manual admin add/update/delete, automatic status
//! fallbacks, recoveries, scheduled expiries, and health-check failures — are
//! built here and rendered through the single [`OpsMessage`] template so every
//! message follows the same layout and ordering:
//!
//! ```text
//! {emoji} {title}
//!
//! Trigger: Manual/Automatic · …
//! Health check: … · …         (optional)
//! Status: …                    (optional)
//! Scope: …                     (optional)
//! …extra meta…                 (optional)
//!
//! {section label}              (optional)
//! • {slot} — {placement}
//!   {heading}
//!   {body}
//!   Response: … · Severity: …
//! 🗓 Schedule: …               (optional)
//!
//! {footer}                     (optional)
//! ```
//!
//! Sending is delegated to [`crate::utils::telegram::TelegramClient`]; this
//! module only produces the text.

use chrono::{DateTime, Utc};

use crate::{
    AppState,
    handlers::status::fallbacks::{
        AutoFallbackRecovery, FallbackTarget, RecoveredSlotInfo, RecoveryTrigger, fallback_config,
        supports_fallback_button,
    },
    handlers::warnings::{db::AuditAction, templates::parse_warning_copy},
};

// ─── Shared label / escaping helpers ─────────────────────────────────────────

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn service_label(service: &str) -> &'static str {
    match service {
        "backend" => "Backend API",
        "exchange" => "Exchange quotes",
        "near-intents" => "NEAR Intents",
        "near-protocol" => "NEAR Protocol status",
        "near-rpc" => "NEAR RPC",
        _ => "Unknown service",
    }
}

fn health_check_name(service: &str) -> &'static str {
    match service {
        "backend" => "backend.database",
        "exchange" => "exchange.quote",
        "near-protocol" => "near-protocol.status-page",
        "near-rpc" => "near-rpc.status",
        _ => "unknown",
    }
}

fn slot_label(slot: &str) -> String {
    match slot {
        "app" => "App".to_string(),
        "exchange" => "Exchange".to_string(),
        "deposit" => "Deposits".to_string(),
        "payments" => "Payments".to_string(),
        "data.balances" => "Balances".to_string(),
        other => other.to_string(),
    }
}

fn placement_for_slot(slot: &str) -> &'static str {
    match slot {
        "app" => "sidebar banner across the entire platform",
        "exchange" => "banner above the form",
        "deposit" => "banner above the form",
        "payments" => "banner above the form",
        _ => "banner above the form",
    }
}

fn axis_label(value: &str) -> String {
    match value {
        "notice" => "Notice".to_string(),
        "paused" => "Paused".to_string(),
        "low" => "Low".to_string(),
        "high" => "High".to_string(),
        "critical" => "Critical".to_string(),
        other => other.to_string(),
    }
}

fn format_event_datetime(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M UTC").to_string()
}

fn warning_scope_label(token: Option<&str>, network: Option<&str>) -> Option<String> {
    let normalize = |v: Option<&str>| v.map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
    match (normalize(token), normalize(network)) {
        (Some(t), Some(n)) => Some(format!("{t} on {n}")),
        (Some(t), None) => Some(t),
        (None, Some(n)) => Some(n),
        (None, None) => None,
    }
}

// ─── Public data types ───────────────────────────────────────────────────────

/// What happened to a warning, for the Telegram lifecycle alert.
#[derive(Debug, Clone, Copy)]
pub enum WarningEventAction {
    /// Created or activated and visible to users now.
    Published,
    /// Created/updated with a future show-from (not yet visible).
    Scheduled,
    /// Edited in place (still active).
    Updated,
    /// Deleted / cleared (manually or automatically).
    Removed,
}

/// Who or what triggered a warning change. Shared by every message type so the
/// "Manual vs Automatic" line is always rendered the same way.
#[derive(Debug, Clone)]
pub enum MessageTrigger {
    /// A person acting in the admin panel or via the Telegram bot.
    Manual {
        by: String,
        /// Optional channel detail, e.g. "Post to app".
        via: Option<String>,
    },
    /// The system (status monitor / scheduler), with an optional reason.
    Automatic { reason: Option<String> },
}

impl MessageTrigger {
    pub fn manual(by: impl Into<String>) -> Self {
        Self::Manual {
            by: by.into(),
            via: None,
        }
    }

    pub fn automatic(reason: impl Into<String>) -> Self {
        Self::Automatic {
            reason: Some(reason.into()),
        }
    }

    fn render(&self) -> String {
        match self {
            Self::Manual { by, via: None } => {
                format!("Trigger: <b>Manual</b> · by {}", escape_html(by))
            }
            Self::Manual { by, via: Some(via) } => format!(
                "Trigger: <b>Manual</b> · {} · by {}",
                escape_html(via),
                escape_html(by)
            ),
            Self::Automatic { reason: None } => "Trigger: <b>Automatic</b>".to_string(),
            Self::Automatic {
                reason: Some(reason),
            } => format!("Trigger: <b>Automatic</b> · {}", escape_html(reason)),
        }
    }
}

/// User-facing content of one affected warning slot.
#[derive(Debug, Clone)]
pub struct WarningPreview {
    pub slot: String,
    pub heading: String,
    pub body: String,
    pub response: String,
    pub severity: String,
}

impl WarningPreview {
    pub fn from_message(
        slot: Option<&str>,
        response: &str,
        severity: &str,
        user_message: Option<&str>,
    ) -> Self {
        let (heading, body) = parse_warning_copy(user_message.unwrap_or_default());
        Self {
            slot: slot.unwrap_or("app").to_string(),
            heading,
            body,
            response: response.to_string(),
            severity: severity.to_string(),
        }
    }

    pub fn from_target(target: &FallbackTarget) -> Self {
        let message = target.message();
        let (heading, body) = parse_warning_copy(&message);
        Self {
            slot: target.slot.to_string(),
            heading,
            body,
            response: target.response.to_string(),
            severity: target.severity.to_string(),
        }
    }

    pub fn from_recovered_slot(slot: &RecoveredSlotInfo) -> Self {
        Self {
            slot: slot.slot.clone(),
            heading: slot.message_heading.clone(),
            body: slot.message_body.clone(),
            response: slot.response.clone(),
            severity: slot.severity.clone(),
        }
    }

    fn render_lines(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "• {} — {}",
            escape_html(&slot_label(&self.slot)),
            escape_html(placement_for_slot(&self.slot))
        )];
        if !self.heading.is_empty() {
            lines.push(format!("  <b>{}</b>", escape_html(&self.heading)));
        }
        if !self.body.is_empty() {
            lines.push(format!("  {}", escape_html(&self.body)));
        }
        lines.push(format!(
            "  Response: {} · Severity: {}",
            axis_label(&self.response),
            axis_label(&self.severity)
        ));
        lines
    }
}

#[derive(Debug, Clone, Default)]
pub struct WarningSchedule {
    pub show_from: Option<DateTime<Utc>>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
}

impl WarningSchedule {
    pub fn is_empty(&self) -> bool {
        self.show_from.is_none() && self.starts_at.is_none() && self.ends_at.is_none()
    }

    fn render_line(&self) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(show_from) = self.show_from {
            parts.push(format!("Shows {}", format_event_datetime(show_from)));
        }
        if let Some(starts_at) = self.starts_at {
            parts.push(format!("Starts {}", format_event_datetime(starts_at)));
        }
        if let Some(ends_at) = self.ends_at {
            parts.push(format!("Ends {}", format_event_datetime(ends_at)));
        }
        if parts.is_empty() {
            None
        } else {
            Some(format!("🗓 Schedule: {}", parts.join(" · ")))
        }
    }
}

/// A warning create / update / remove event for the ops channel.
pub struct WarningEvent {
    pub action: WarningEventAction,
    pub source: MessageTrigger,
    pub preview: WarningPreview,
    pub token: Option<String>,
    pub network: Option<String>,
    pub schedule: WarningSchedule,
}

/// Map a stored audit action to the lifecycle action shown in Telegram.
pub fn event_action_from_audit(action: AuditAction) -> WarningEventAction {
    match action {
        AuditAction::Created | AuditAction::Activated => WarningEventAction::Published,
        AuditAction::Scheduled => WarningEventAction::Scheduled,
        AuditAction::Updated => WarningEventAction::Updated,
        AuditAction::Deleted => WarningEventAction::Removed,
    }
}

// ─── The single message template ─────────────────────────────────────────────

/// Canonical ops-channel message. Every builder fills this in and calls
/// [`OpsMessage::render`], guaranteeing one consistent layout/order.
struct OpsMessage {
    emoji: &'static str,
    title: String,
    trigger: Option<MessageTrigger>,
    /// Renders a "Health check: <label> · <code>" meta line.
    health_check_service: Option<String>,
    /// Renders a "Status: <b>…</b>" meta line.
    status: Option<String>,
    /// Renders a "Scope: …" meta line (pre-built, plain text).
    scope: Option<String>,
    /// Additional pre-formatted (HTML-safe) meta lines, appended after the
    /// structured meta above.
    extra_meta: Vec<String>,
    /// Bold label introducing the preview blocks, e.g. "Users will see:".
    section_label: Option<String>,
    previews: Vec<WarningPreview>,
    schedule: Option<WarningSchedule>,
    /// Pre-formatted (HTML-safe) closing line(s).
    footer: Option<String>,
}

impl OpsMessage {
    fn render(&self) -> String {
        let mut lines = vec![format!(
            "{} <b>{}</b>",
            self.emoji,
            escape_html(&self.title)
        )];

        let mut meta: Vec<String> = Vec::new();
        if let Some(trigger) = &self.trigger {
            meta.push(trigger.render());
        }
        if let Some(service) = &self.health_check_service {
            meta.push(format!(
                "Health check: <b>{}</b> · <code>{}</code>",
                escape_html(service_label(service)),
                health_check_name(service)
            ));
        }
        if let Some(status) = &self.status {
            meta.push(format!("Status: <b>{}</b>", escape_html(status)));
        }
        if let Some(scope) = &self.scope {
            meta.push(format!("Scope: {}", escape_html(scope)));
        }
        meta.extend(self.extra_meta.iter().cloned());

        if !meta.is_empty() {
            lines.push(String::new());
            lines.extend(meta);
        }

        if let Some(label) = &self.section_label {
            lines.push(String::new());
            lines.push(format!("<b>{}</b>", escape_html(label)));
        }

        for (idx, preview) in self.previews.iter().enumerate() {
            if idx > 0 {
                lines.push(String::new());
            }
            lines.extend(preview.render_lines());
        }

        if let Some(schedule_line) = self
            .schedule
            .as_ref()
            .and_then(WarningSchedule::render_line)
        {
            lines.push(schedule_line);
        }

        if let Some(footer) = &self.footer {
            lines.push(String::new());
            lines.push(footer.clone());
        }

        lines.join("\n")
    }
}

// ─── Message builders ────────────────────────────────────────────────────────

/// Telegram HTML summary for any warning create / update / remove event
/// (manual admin actions and automatic monitor removals).
pub fn format_warning_event_message(event: &WarningEvent) -> String {
    let (title, section) = match event.action {
        WarningEventAction::Published => ("Warning published", "Users will see:"),
        WarningEventAction::Scheduled => ("Warning scheduled", "Users will see:"),
        WarningEventAction::Updated => ("Warning updated", "Current message:"),
        WarningEventAction::Removed => ("Warning removed", "Users no longer see:"),
    };

    let emoji = match event.action {
        WarningEventAction::Published => "📢",
        WarningEventAction::Scheduled => "🗓",
        WarningEventAction::Updated => "✏️",
        // A person deleting a warning reads clearer as a trash action; an
        // automatic clear (health check recovered / schedule ended) stays ✅.
        WarningEventAction::Removed => match event.source {
            MessageTrigger::Manual { .. } => "🗑",
            MessageTrigger::Automatic { .. } => "✅",
        },
    };

    OpsMessage {
        emoji,
        title: title.to_string(),
        trigger: Some(event.source.clone()),
        health_check_service: None,
        status: None,
        scope: warning_scope_label(event.token.as_deref(), event.network.as_deref()),
        extra_meta: Vec::new(),
        section_label: Some(section.to_string()),
        previews: vec![event.preview.clone()],
        schedule: (!event.schedule.is_empty()).then(|| event.schedule.clone()),
        footer: None,
    }
    .render()
}

/// Rich Telegram HTML summary after activating (or re-confirming) a fallback warning.
pub fn format_activation_message(
    service: &str,
    activated_by: &str,
    already_active: bool,
) -> String {
    let Some(config) = fallback_config(service) else {
        return format!(
            "✅ Action recorded for <b>{}</b> by {}.",
            escape_html(service),
            escape_html(activated_by)
        );
    };

    let (emoji, title, section) = if already_active {
        ("⚠️", "Warning already live", "Users are already seeing:")
    } else {
        ("📢", "Posted to app", "Users will see:")
    };

    OpsMessage {
        emoji,
        title: title.to_string(),
        trigger: Some(MessageTrigger::Manual {
            by: activated_by.to_string(),
            via: Some("Post to app".to_string()),
        }),
        health_check_service: Some(service.to_string()),
        status: None,
        scope: None,
        extra_meta: Vec::new(),
        section_label: Some(section.to_string()),
        previews: config
            .targets
            .iter()
            .map(WarningPreview::from_target)
            .collect(),
        schedule: None,
        footer: Some(format!(
            "Auto-clears when <b>{}</b> recovers.",
            escape_html(service_label(service))
        )),
    }
    .render()
}

/// Rich Telegram HTML summary after an auto-linked warning is cleared on recovery.
pub fn format_recovery_message(recovery: &AutoFallbackRecovery) -> String {
    let (title, health_check_service, extra_meta) = match &recovery.trigger {
        RecoveryTrigger::Service { service } => {
            ("User warning removed", Some(service.clone()), Vec::new())
        }
        RecoveryTrigger::StaleCleanup { slot } => (
            "Stuck warning cleared",
            None,
            vec![format!(
                "All related health checks are healthy again for <b>{}</b>.",
                escape_html(&slot_label(slot))
            )],
        ),
    };

    OpsMessage {
        emoji: "✅",
        title: title.to_string(),
        trigger: Some(MessageTrigger::Automatic { reason: None }),
        health_check_service,
        status: None,
        scope: None,
        extra_meta,
        section_label: Some("Users no longer see:".to_string()),
        previews: recovery
            .slots
            .iter()
            .map(WarningPreview::from_recovered_slot)
            .collect(),
        schedule: None,
        footer: Some("Removed from the UI automatically.".to_string()),
    }
    .render()
}

/// Collapsed preview of what "Post to app" would publish (for the initial ops alert).
pub fn format_fallback_preview_summary(service: &str) -> Option<String> {
    let config = fallback_config(service)?;
    let mut lines = vec!["<b>Post to app would publish:</b>".to_string()];

    for target in config.targets {
        let message = target.message();
        let (heading, _) = parse_warning_copy(&message);
        lines.push(format!(
            "• {} — {}",
            escape_html(&slot_label(target.slot)),
            escape_html(&heading)
        ));
    }

    Some(lines.join("\n"))
}

/// Initial ops alert when an Oh Dear health check starts failing.
pub fn format_health_check_alert(
    service: &str,
    check_name: &str,
    status: &str,
    message: &str,
) -> String {
    let action = if supports_fallback_button(service) {
        "Use <b>Post to app</b> or <b>Open admin</b>. Tap <b>View check</b> for the full Oh Dear response."
    } else {
        "Create the warning in admin. Tap <b>View check</b> for the full Oh Dear response."
    };

    let footer = match format_fallback_preview_summary(service) {
        Some(preview) => format!("{action}\n\n{preview}"),
        None => action.to_string(),
    };

    OpsMessage {
        emoji: "⚠️",
        title: format!("Health check failed: {}", service_label(service)),
        trigger: None,
        health_check_service: None,
        status: Some(status.to_string()),
        scope: None,
        extra_meta: vec![
            format!("Check: <code>{}</code>", escape_html(check_name)),
            escape_html(message),
        ],
        section_label: None,
        previews: Vec::new(),
        schedule: None,
        footer: Some(footer),
    }
    .render()
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/// Send a warning lifecycle alert to the ops channel. Best-effort: failures are
/// logged, never propagated (a Telegram outage must not fail an admin action).
pub async fn notify_warning_event(state: &AppState, event: WarningEvent) {
    let text = format_warning_event_message(&event);
    if let Err(e) = state.telegram_client.send_ops_alert_html(&text).await {
        tracing::warn!("[warnings] Failed to send warning lifecycle alert: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::status::fallbacks::AutoFallbackRecovery;

    #[test]
    fn warning_event_manual_publish_with_scope_and_schedule() {
        let event = WarningEvent {
            action: WarningEventAction::Published,
            source: MessageTrigger::manual("megha"),
            preview: WarningPreview::from_message(
                Some("payments"),
                "paused",
                "critical",
                Some("### Payments paused\nWe're investigating."),
            ),
            token: Some("usdc".to_string()),
            network: Some("base".to_string()),
            schedule: WarningSchedule {
                show_from: None,
                starts_at: None,
                ends_at: "2026-07-01T10:00:00Z".parse().ok(),
            },
        };

        let message = format_warning_event_message(&event);
        assert!(message.contains("📢 <b>Warning published</b>"));
        assert!(message.contains("Trigger: <b>Manual</b> · by megha"));
        assert!(message.contains("Scope: USDC on BASE"));
        assert!(message.contains("<b>Users will see:</b>"));
        assert!(message.contains("<b>Payments paused</b>"));
        assert!(message.contains("Response: Paused · Severity: Critical"));
        assert!(message.contains("🗓 Schedule: Ends 2026-07-01 10:00 UTC"));
    }

    #[test]
    fn warning_event_automatic_removed_escapes_actor() {
        let event = WarningEvent {
            action: WarningEventAction::Removed,
            source: MessageTrigger::automatic("scheduled end time reached"),
            preview: WarningPreview::from_message(Some("exchange"), "notice", "low", None),
            token: None,
            network: None,
            schedule: WarningSchedule::default(),
        };

        let message = format_warning_event_message(&event);
        assert!(message.contains("✅ <b>Warning removed</b>"));
        assert!(message.contains("Trigger: <b>Automatic</b> · scheduled end time reached"));
        assert!(message.contains("<b>Users no longer see:</b>"));
        assert!(!message.contains("Scope:"));
        assert!(!message.contains("🗓 Schedule:"));
    }

    #[test]
    fn warning_event_manual_removed_uses_trash_emoji() {
        let event = WarningEvent {
            action: WarningEventAction::Removed,
            source: MessageTrigger::manual("megha"),
            preview: WarningPreview::from_message(Some("exchange"), "notice", "low", None),
            token: None,
            network: None,
            schedule: WarningSchedule::default(),
        };

        let message = format_warning_event_message(&event);
        assert!(message.contains("🗑 <b>Warning removed</b>"));
        assert!(!message.contains("✅"));
        assert!(message.contains("Trigger: <b>Manual</b> · by megha"));
    }

    #[test]
    fn activation_message_includes_full_preview() {
        let message = format_activation_message("exchange", "Megha_Goel", false);
        assert!(message.contains("📢 <b>Posted to app</b>"));
        assert!(message.contains("Trigger: <b>Manual</b> · Post to app · by Megha_Goel"));
        assert!(message.contains("Exchange quotes"));
        assert!(message.contains("exchange.quote"));
        assert!(message.contains("Exchange is temporarily paused"));
        assert!(message.contains("Response: Paused"));
        assert!(message.contains("Severity: High"));
        assert!(!message.contains("Deposits are paused"));
        assert!(message.contains("Auto-clears when <b>Exchange quotes</b> recovers."));
    }

    #[test]
    fn activation_message_already_active_variant() {
        let message = format_activation_message("backend", "ops", true);
        assert!(message.contains("Warning already live"));
        assert!(message.contains("Users are already seeing"));
        assert!(message.contains("temporary issue"));
    }

    #[test]
    fn recovery_message_includes_full_copy() {
        let recovery = AutoFallbackRecovery {
            trigger: RecoveryTrigger::Service {
                service: "near-rpc".to_string(),
            },
            slots: vec![RecoveredSlotInfo {
                slot: "app".to_string(),
                message_heading: "Transactions are paused".to_string(),
                message_body: "We're working on it — your funds are safe.".to_string(),
                response: "paused".to_string(),
                severity: "high".to_string(),
            }],
        };

        let message = format_recovery_message(&recovery);
        assert!(message.contains("✅ <b>User warning removed</b>"));
        assert!(message.contains("Trigger: <b>Automatic</b>"));
        assert!(message.contains("NEAR RPC"));
        assert!(message.contains("near-rpc.status"));
        assert!(message.contains("Transactions are paused"));
        assert!(message.contains("Response: Paused"));
        assert!(message.contains("Removed from the UI automatically"));
    }

    #[test]
    fn health_check_alert_has_consistent_header() {
        let message = format_health_check_alert(
            "backend",
            "backend.database",
            "failed",
            "Connection refused",
        );
        assert!(message.contains("⚠️ <b>Health check failed: Backend API</b>"));
        assert!(message.contains("Status: <b>failed</b>"));
        assert!(message.contains("Check: <code>backend.database</code>"));
        assert!(message.contains("Connection refused"));
        assert!(message.contains("Post to app would publish:"));
    }
}

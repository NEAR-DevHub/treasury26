use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;

use crate::{
    AppState,
    handlers::warnings::{db, templates},
};

pub const SHOW_FALLBACK_CALLBACK_PREFIX: &str = "show_fallback:";

#[derive(Debug, Clone, Copy)]
pub struct FallbackTarget {
    pub slot: &'static str,
    pub severity: &'static str,
    pub scenario: &'static str,
}

impl FallbackTarget {
    pub fn message(&self) -> String {
        templates::generate_messages(
            self.severity,
            Some(self.slot),
            None,
            None,
            Some(self.scenario),
        )
        .unwrap_or_else(|| "We're looking into a service issue. Your funds are safe.".to_string())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FallbackConfig {
    pub targets: &'static [FallbackTarget],
}

const APP_TIER3_DOWN_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "app",
        severity: "critical",
        scenario: "tier3_down",
    }],
};

const EXCHANGE_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[
        FallbackTarget {
            slot: "exchange",
            severity: "critical",
            scenario: "swaps_paused",
        },
        FallbackTarget {
            slot: "deposit",
            severity: "critical",
            scenario: "deposits_paused",
        },
        FallbackTarget {
            slot: "payments",
            severity: "critical",
            scenario: "payments_paused",
        },
    ],
};

const NEAR_RPC_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "app",
        severity: "critical",
        scenario: "tier2_tx_paused",
    }],
};

const FALLBACK_CONFIGS: &[(&str, FallbackConfig)] = &[
    ("backend", APP_TIER3_DOWN_FALLBACK),
    ("exchange", EXCHANGE_FALLBACK),
    ("near-protocol", APP_TIER3_DOWN_FALLBACK),
    ("near-rpc", NEAR_RPC_FALLBACK),
];

pub fn fallback_config(service: &str) -> Option<&'static FallbackConfig> {
    FALLBACK_CONFIGS
        .iter()
        .find(|(name, _)| *name == service)
        .map(|(_, config)| config)
}

/// Whether the Telegram ops alert should include a one-click "Show fallback" button.
/// NEAR Intents incidents are always handled manually in admin (often linked to status posts).
pub fn supports_fallback_button(service: &str) -> bool {
    fallback_config(service).is_some()
}

pub fn parse_show_fallback_callback(data: &str) -> Option<&str> {
    data.strip_prefix(SHOW_FALLBACK_CALLBACK_PREFIX)
        .filter(|service| supports_fallback_button(service))
}

const ALL_FALLBACK_SLOTS: &[&str] = &["app", "exchange", "deposit", "payments"];

fn is_service_linked_fallback(linked_service: Option<&str>, linked_post_id: Option<&str>) -> bool {
    linked_post_id.is_none()
        && linked_service.is_some_and(|service| fallback_config(service).is_some())
}

async fn slot_has_open_incidents(
    pool: &PgPool,
    slot: &str,
    excluding_service: Option<&str>,
) -> Result<bool, sqlx::Error> {
    for (service, config) in FALLBACK_CONFIGS {
        if excluding_service == Some(service) {
            continue;
        }
        if !config.targets.iter().any(|target| target.slot == slot) {
            continue;
        }

        let still_open = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM status_incidents
                WHERE service = $1 AND recovered_at IS NULL
            )
            "#,
        )
        .bind(service)
        .fetch_one(pool)
        .await?;

        if still_open {
            return Ok(true);
        }
    }

    Ok(false)
}

async fn other_services_need_slot(
    pool: &PgPool,
    slot: &str,
    excluding_service: &str,
) -> Result<bool, sqlx::Error> {
    slot_has_open_incidents(pool, slot, Some(excluding_service)).await
}

#[derive(Debug, Clone)]
pub struct RecoveredSlotInfo {
    pub slot: String,
    pub message_heading: String,
}

#[derive(Debug, Clone)]
pub enum RecoveryTrigger {
    Service { service: String },
    StaleCleanup { slot: String },
}

#[derive(Debug, Clone)]
pub struct AutoFallbackRecovery {
    pub trigger: RecoveryTrigger,
    pub slots: Vec<RecoveredSlotInfo>,
}

async fn delete_linked_slot_warning(
    state: &AppState,
    existing: &WarningSlotRow,
    recovered_service: &str,
    source: &str,
) -> Result<RecoveredSlotInfo, String> {
    let slot = existing
        .slot
        .as_deref()
        .ok_or_else(|| "warning slot row missing slot".to_string())?;

    let message_heading = existing
        .user_message
        .as_deref()
        .map(warning_heading)
        .unwrap_or_default();

    let changes = db::audit_delete_changes(
        existing.id,
        existing.slot.clone(),
        existing.token.clone(),
        existing.network.clone(),
        json!({
            "service": recovered_service,
            "linked_service": existing.linked_service,
            "linked_post_id": existing.linked_post_id,
            "source": source,
        }),
    );

    db::delete_warning_with_audit(&state.db_pool, existing.id, "system", changes)
        .await
        .map_err(|e| format!("failed to delete warning slot: {e}"))?;

    Ok(RecoveredSlotInfo {
        slot: slot.to_string(),
        message_heading,
    })
}

async fn delete_auto_fallback_slot(
    state: &AppState,
    slot: &str,
    recovered_service: &str,
    source: &str,
) -> Result<Option<RecoveredSlotInfo>, String> {
    if slot_has_open_incidents(&state.db_pool, slot, None)
        .await
        .map_err(|e| format!("failed to check open incidents for slot {slot}: {e}"))?
    {
        return Ok(None);
    }

    let Some(existing) = load_unscoped_slot(&state.db_pool, slot)
        .await
        .map_err(|e| format!("failed to load warning slot: {e}"))?
    else {
        return Ok(None);
    };

    if !existing.is_active {
        return Ok(None);
    }

    if !is_service_linked_fallback(
        existing.linked_service.as_deref(),
        existing.linked_post_id.as_deref(),
    ) {
        return Ok(None);
    }

    Ok(Some(
        delete_linked_slot_warning(state, &existing, recovered_service, source).await?,
    ))
}

#[derive(Debug, sqlx::FromRow)]
struct WarningSlotRow {
    id: i32,
    slot: Option<String>,
    token: Option<String>,
    network: Option<String>,
    is_active: bool,
    severity: String,
    user_message: Option<String>,
    linked_service: Option<String>,
    linked_post_id: Option<String>,
}

async fn load_unscoped_slot(
    pool: &PgPool,
    slot: &str,
) -> Result<Option<WarningSlotRow>, sqlx::Error> {
    sqlx::query_as::<_, WarningSlotRow>(
        r#"
        SELECT id, slot, token, network, is_active, severity, user_message, linked_service, linked_post_id
        FROM warning_slots
        WHERE slot = $1 AND token IS NULL AND network IS NULL
        "#,
    )
    .bind(slot)
    .fetch_optional(pool)
    .await
}

async fn load_linked_warnings_for_service(
    pool: &PgPool,
    service: &str,
) -> Result<Vec<WarningSlotRow>, sqlx::Error> {
    sqlx::query_as::<_, WarningSlotRow>(
        r#"
        SELECT id, slot, token, network, is_active, severity, user_message, linked_service, linked_post_id
        FROM warning_slots
        WHERE linked_service = $1
          AND linked_post_id IS NULL
          AND is_active = true
          AND token IS NULL
          AND network IS NULL
        "#,
    )
    .bind(service)
    .fetch_all(pool)
    .await
}

async fn ensure_unscoped_slot(
    pool: &PgPool,
    target: &FallbackTarget,
    service: &str,
    activated_by: &str,
) -> Result<WarningSlotRow, String> {
    let user_message = target.message();

    if let Some(existing) = load_unscoped_slot(pool, target.slot)
        .await
        .map_err(|e| format!("failed to load warning slot: {e}"))?
    {
        return activate_existing_slot(
            pool,
            existing,
            target,
            service,
            &user_message,
            activated_by,
        )
        .await;
    }

    sqlx::query_as::<_, WarningSlotRow>(
        r#"
        INSERT INTO warning_slots (
            slot, is_active, severity, user_message, scenario,
            linked_service, linked_post_id, updated_by
        )
        VALUES ($1, true, $2, $3, $4, $5, NULL, $6)
        RETURNING id, slot, token, network, is_active, severity, user_message, linked_service, linked_post_id
        "#,
    )
    .bind(target.slot)
    .bind(target.severity)
    .bind(&user_message)
    .bind(target.scenario)
    .bind(service)
    .bind(activated_by)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("failed to create warning slot: {e}"))
}

async fn activate_existing_slot(
    pool: &PgPool,
    existing: WarningSlotRow,
    target: &FallbackTarget,
    service: &str,
    user_message: &str,
    activated_by: &str,
) -> Result<WarningSlotRow, String> {
    if existing.is_active
        && existing.linked_service.as_deref() == Some(service)
        && existing.linked_post_id.is_none()
    {
        return Ok(existing);
    }

    sqlx::query_as::<_, WarningSlotRow>(
        r#"
        UPDATE warning_slots
        SET
            is_active = true,
            severity = $2,
            user_message = $3,
            scenario = $4,
            linked_service = $5,
            linked_post_id = NULL,
            updated_by = $6,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, slot, token, network, is_active, severity, user_message, linked_service, linked_post_id
        "#,
    )
    .bind(existing.id)
    .bind(target.severity)
    .bind(user_message)
    .bind(target.scenario)
    .bind(service)
    .bind(activated_by)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("failed to activate warning slot: {e}"))
}

/// Activate the fallback warning slot(s) for a service.
pub async fn activate_fallback(
    state: &AppState,
    service: &str,
    activated_by: &str,
) -> Result<Option<i32>, String> {
    let config = fallback_config(service)
        .ok_or_else(|| format!("no fallback config for service: {service}"))?;
    let mut first_warning_id = None;
    let mut already_active = true;

    for target in config.targets {
        let existing = load_unscoped_slot(&state.db_pool, target.slot)
            .await
            .map_err(|e| format!("failed to load warning slot: {e}"))?;

        let was_already_active = existing.as_ref().is_some_and(|row| {
            row.is_active
                && row.linked_service.as_deref() == Some(service)
                && row.linked_post_id.is_none()
        });
        if !was_already_active {
            already_active = false;
        }

        let updated = ensure_unscoped_slot(&state.db_pool, target, service, activated_by).await?;

        if first_warning_id.is_none() {
            first_warning_id = Some(updated.id);
        }

        db::insert_audit_log(
            &state.db_pool,
            Some(updated.id),
            "activated",
            activated_by,
            json!({
                "slot": target.slot,
                "is_active": true,
                "severity": updated.severity,
                "user_message": updated.user_message,
                "linked_service": updated.linked_service,
                "linked_post_id": updated.linked_post_id,
                "service": service,
                "source": "status_fallback",
            }),
        )
        .await
        .map_err(|e| format!("failed to write audit log: {e}"))?;
    }

    if already_active {
        return Ok(None);
    }

    if let Some(warning_id) = first_warning_id {
        sqlx::query(
            r#"
            UPDATE status_incidents
            SET fallback_activated_at = NOW(), warning_slot_id = $2
            WHERE service = $1 AND recovered_at IS NULL
            "#,
        )
        .bind(service)
        .bind(warning_id)
        .execute(&state.db_pool)
        .await
        .map_err(|e| format!("failed to update status incident: {e}"))?;
    }

    db::invalidate_warnings_cache(state).await;

    Ok(first_warning_id)
}

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

fn warning_heading(message: &str) -> String {
    let trimmed = message.trim();
    if let Some(rest) = trimmed.strip_prefix("### ") {
        return rest.lines().next().unwrap_or(rest).trim().to_string();
    }
    trimmed.lines().next().unwrap_or(trimmed).trim().to_string()
}

fn behavior_summary(config: &FallbackConfig) -> &'static str {
    if config.targets.len() > 1 {
        return "Critical · blocks create actions on affected pages";
    }

    let target = &config.targets[0];
    match (target.slot, target.scenario) {
        ("app", "tier3_down") => "Critical · Trezu temporarily down (app banner)",
        ("app", "tier2_tx_paused") => "Critical · transactions paused (app banner)",
        ("app", "tier1_backend") => "Warning · some data may not load",
        ("exchange", _) | ("deposit", _) | ("payments", _) => {
            "Critical · blocks create actions on this page"
        }
        ("data.balances", _) => "Warning · balance data may be unavailable",
        _ => "Active user warning",
    }
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

    let header = if already_active {
        "⚠️ <b>Warning already live</b>"
    } else {
        "✅ <b>User warning activated</b>"
    };

    let users_label = if already_active {
        "Users are already seeing:"
    } else {
        "Users will see:"
    };

    let mut lines = vec![
        header.to_string(),
        String::new(),
        format!(
            "Health check: <b>{}</b> · <code>{}</code>",
            escape_html(service_label(service)),
            health_check_name(service)
        ),
        format!("By: {}", escape_html(activated_by)),
        String::new(),
        format!("<b>{users_label}</b>"),
    ];

    for target in config.targets {
        let heading = warning_heading(&target.message());
        lines.push(format!(
            "• {} — {}",
            escape_html(&slot_label(target.slot)),
            escape_html(&heading)
        ));
    }

    lines.push(String::new());
    lines.push(behavior_summary(config).to_string());
    lines.push(format!(
        "Auto-clears when <b>{}</b> recovers.",
        escape_html(service_label(service))
    ));

    lines.join("\n")
}

/// Rich Telegram HTML summary after an auto-linked warning is cleared on recovery.
pub fn format_recovery_message(recovery: &AutoFallbackRecovery) -> String {
    let (header, trigger_line) = match &recovery.trigger {
        RecoveryTrigger::Service { service } => (
            "✅ <b>User warning removed</b>",
            format!(
                "Health check recovered: <b>{}</b> · <code>{}</code>",
                escape_html(service_label(service)),
                health_check_name(service)
            ),
        ),
        RecoveryTrigger::StaleCleanup { slot } => (
            "✅ <b>Stuck warning cleared</b>",
            format!(
                "All related health checks are healthy again for <b>{}</b>.",
                escape_html(&slot_label(slot))
            ),
        ),
    };

    let mut lines = vec![
        header.to_string(),
        String::new(),
        trigger_line,
        String::new(),
        "<b>Users no longer see:</b>".to_string(),
    ];

    for slot in &recovery.slots {
        if slot.message_heading.is_empty() {
            lines.push(format!("• {}", escape_html(&slot_label(&slot.slot))));
        } else {
            lines.push(format!(
                "• {} — {}",
                escape_html(&slot_label(&slot.slot)),
                escape_html(&slot.message_heading)
            ));
        }
    }

    lines.push(String::new());
    lines.push("Removed from the UI automatically.".to_string());

    lines.join("\n")
}

/// Delete service-linked fallback warnings after recovery.
pub async fn delete_fallback(
    state: &AppState,
    service: &str,
) -> Result<Option<AutoFallbackRecovery>, String> {
    if fallback_config(service).is_none() {
        return Ok(None);
    }

    let linked = load_linked_warnings_for_service(&state.db_pool, service)
        .await
        .map_err(|e| format!("failed to load linked warnings for {service}: {e}"))?;

    let mut recovered_slots = Vec::new();

    for warning in linked {
        let Some(slot) = warning.slot.as_deref() else {
            continue;
        };

        if other_services_need_slot(&state.db_pool, slot, service)
            .await
            .map_err(|e| format!("failed to check shared fallback slot: {e}"))?
        {
            continue;
        }

        recovered_slots
            .push(delete_linked_slot_warning(state, &warning, service, "status_recovery").await?);
    }

    if recovered_slots.is_empty() {
        return Ok(None);
    }

    db::invalidate_warnings_cache(state).await;

    Ok(Some(AutoFallbackRecovery {
        trigger: RecoveryTrigger::Service {
            service: service.to_string(),
        },
        slots: recovered_slots,
    }))
}

/// Clear service-linked fallback warnings that outlived their incidents (e.g. shared slots).
pub async fn cleanup_stale_auto_fallbacks(
    state: &AppState,
) -> Result<Vec<AutoFallbackRecovery>, String> {
    let mut recoveries = Vec::new();

    for slot in ALL_FALLBACK_SLOTS {
        if slot_has_open_incidents(&state.db_pool, slot, None)
            .await
            .map_err(|e| format!("failed to check open incidents for slot {slot}: {e}"))?
        {
            continue;
        }

        let Some(recovered) =
            delete_auto_fallback_slot(state, slot, "system", "stale_auto_fallback_cleanup").await?
        else {
            continue;
        };

        recoveries.push(AutoFallbackRecovery {
            trigger: RecoveryTrigger::StaleCleanup {
                slot: slot.to_string(),
            },
            slots: vec![recovered],
        });
    }

    if !recoveries.is_empty() {
        db::invalidate_warnings_cache(state).await;
    }

    Ok(recoveries)
}

pub fn backend_base_url() -> String {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    std::env::var("BACKEND_BASE_URL").unwrap_or_else(|_| format!("http://127.0.0.1:{port}"))
}

pub fn admin_page_url() -> String {
    backend_base_url() + "/internal/warnings"
}

pub fn oh_dear_status_url(service: &str) -> String {
    format!("{}/api/oh-dear/status/{}", backend_base_url(), service)
}

#[derive(Debug, sqlx::FromRow)]
pub struct StatusIncident {
    pub id: i32,
    pub service: String,
    pub check_name: String,
    pub status: String,
    pub first_failed_at: DateTime<Utc>,
    pub last_failed_at: DateTime<Utc>,
    pub recovered_at: Option<DateTime<Utc>>,
    pub telegram_message_id: Option<i32>,
    pub fallback_activated_at: Option<DateTime<Utc>>,
    pub warning_slot_id: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_config_maps_known_services() {
        let backend = fallback_config("backend").expect("backend config");
        assert_eq!(backend.targets[0].slot, "app");
        assert_eq!(backend.targets[0].scenario, "tier3_down");
        assert!(backend.targets[0].message().contains("temporarily down"));

        let exchange = fallback_config("exchange").expect("exchange config");
        assert_eq!(exchange.targets.len(), 3);
        assert_eq!(exchange.targets[0].slot, "exchange");
        assert!(exchange.targets[0].message().contains("Swaps are paused"));

        let near_rpc = fallback_config("near-rpc").expect("near-rpc config");
        assert_eq!(near_rpc.targets[0].slot, "app");
        assert_eq!(near_rpc.targets[0].scenario, "tier2_tx_paused");
        assert!(
            near_rpc.targets[0]
                .message()
                .contains("Transactions are paused")
        );

        let near_protocol = fallback_config("near-protocol").expect("near-protocol config");
        assert_eq!(near_protocol.targets[0].scenario, "tier3_down");
    }

    #[test]
    fn near_intents_has_no_auto_fallback() {
        assert!(fallback_config("near-intents").is_none());
        assert!(!supports_fallback_button("near-intents"));
        assert!(parse_show_fallback_callback("show_fallback:near-intents").is_none());
    }

    #[test]
    fn fallback_config_returns_none_for_unknown_service() {
        assert!(fallback_config("unknown").is_none());
    }

    #[test]
    fn parse_show_fallback_callback_accepts_valid_data() {
        assert_eq!(
            parse_show_fallback_callback("show_fallback:backend"),
            Some("backend")
        );
        assert_eq!(
            parse_show_fallback_callback("show_fallback:near-rpc"),
            Some("near-rpc")
        );
    }

    #[test]
    fn format_activation_message_includes_slot_headings() {
        let message = format_activation_message("exchange", "Megha_Goel", false);
        assert!(message.contains("User warning activated"));
        assert!(message.contains("Exchange quotes"));
        assert!(message.contains("exchange.quote"));
        assert!(message.contains("Exchange — Swaps are paused"));
        assert!(message.contains("Deposits — Deposits are paused"));
        assert!(message.contains("Payments — Payments are paused"));
        assert!(message.contains("Megha_Goel"));
    }

    #[test]
    fn format_activation_message_already_active_variant() {
        let message = format_activation_message("backend", "ops", true);
        assert!(message.contains("Warning already live"));
        assert!(message.contains("Users are already seeing"));
        assert!(message.contains("Trezu is temporarily down"));
    }

    #[test]
    fn format_recovery_message_includes_removed_slots() {
        let recovery = AutoFallbackRecovery {
            trigger: RecoveryTrigger::Service {
                service: "near-rpc".to_string(),
            },
            slots: vec![RecoveredSlotInfo {
                slot: "app".to_string(),
                message_heading: "Transactions are paused".to_string(),
            }],
        };

        let message = format_recovery_message(&recovery);
        assert!(message.contains("User warning removed"));
        assert!(message.contains("NEAR RPC"));
        assert!(message.contains("near-rpc.status"));
        assert!(message.contains("App — Transactions are paused"));
        assert!(message.contains("Removed from the UI automatically"));
    }
}

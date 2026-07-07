use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;

use crate::{
    AppState,
    handlers::warnings::{
        db::{self, AuditAction},
        templates::{self, parse_warning_copy},
    },
};

pub const POST_TO_APP_CALLBACK_PREFIX: &str = "post_to_app:";

#[derive(Debug, Clone, Copy)]
pub struct FallbackTarget {
    pub slot: &'static str,
    pub response: &'static str,
    pub severity: &'static str,
    pub situation: &'static str,
}

impl FallbackTarget {
    pub fn message(&self) -> String {
        templates::generate_messages(
            self.response,
            self.severity,
            Some(self.slot),
            None,
            None,
            Some(self.situation),
        )
        .unwrap_or_else(|| "We're looking into a service issue. Your funds are safe.".to_string())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FallbackConfig {
    pub targets: &'static [FallbackTarget],
}

const BACKEND_DOWN_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "app",
        response: "notice",
        severity: "high",
        situation: "backend_down",
    }],
};

const EXCHANGE_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "exchange",
        response: "paused",
        severity: "high",
        situation: "features_paused",
    }],
};

const BRIDGE_RPC_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[
        FallbackTarget {
            slot: "exchange",
            response: "paused",
            severity: "high",
            situation: "features_paused",
        },
        FallbackTarget {
            slot: "deposit",
            response: "paused",
            severity: "high",
            situation: "features_paused",
        },
        FallbackTarget {
            slot: "payments",
            response: "paused",
            severity: "high",
            situation: "features_paused",
        },
    ],
};

const NEAR_RPC_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "app",
        response: "paused",
        severity: "high",
        situation: "transactions_halted",
    }],
};

const FASTNEAR_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "data.balances",
        response: "notice",
        severity: "high",
        situation: "balance_unavailable",
    }],
};

const GOLDSKY_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "data.activity",
        response: "notice",
        severity: "high",
        situation: "history_not_loading",
    }],
};

const INTENTS_EXPLORER_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "data.activity",
        response: "notice",
        severity: "high",
        situation: "history_not_loading",
    }],
};

const WHOLE_APP_DOWN_FALLBACK: FallbackConfig = FallbackConfig {
    targets: &[FallbackTarget {
        slot: "app",
        response: "notice",
        severity: "high",
        situation: "whole_app_down",
    }],
};

const FALLBACK_CONFIGS: &[(&str, FallbackConfig)] = &[
    ("backend", BACKEND_DOWN_FALLBACK),
    ("bridge-rpc", BRIDGE_RPC_FALLBACK),
    ("exchange", EXCHANGE_FALLBACK),
    ("near-protocol", WHOLE_APP_DOWN_FALLBACK),
    ("near-rpc", NEAR_RPC_FALLBACK),
    ("fastnear", FASTNEAR_FALLBACK),
    ("goldsky", GOLDSKY_FALLBACK),
    ("intents-explorer", INTENTS_EXPLORER_FALLBACK),
];

pub fn fallback_config(service: &str) -> Option<&'static FallbackConfig> {
    FALLBACK_CONFIGS
        .iter()
        .find(|(name, _)| *name == service)
        .map(|(_, config)| config)
}

/// Whether the Telegram ops alert should include a one-click "Post to app" button.
/// NEAR Intents incidents are always handled manually in admin (often linked to status posts).
pub fn supports_fallback_button(service: &str) -> bool {
    fallback_config(service).is_some()
}

pub fn parse_post_to_app_callback(data: &str) -> Option<&str> {
    data.strip_prefix(POST_TO_APP_CALLBACK_PREFIX)
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
    pub message_body: String,
    pub response: String,
    pub severity: String,
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

    let user_message = existing.user_message.as_deref().unwrap_or_default();
    let (message_heading, message_body) = parse_warning_copy(user_message);

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
        message_body,
        response: existing.response.clone(),
        severity: existing.severity.clone(),
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
    response: String,
    severity: String,
    user_message: Option<String>,
    linked_service: Option<String>,
    linked_post_id: Option<String>,
}

async fn load_unscoped_slot<'c, E: sqlx::PgExecutor<'c>>(
    executor: E,
    slot: &str,
) -> Result<Option<WarningSlotRow>, sqlx::Error> {
    sqlx::query_as::<_, WarningSlotRow>(
        r#"
        SELECT id, slot, token, network, is_active, response, severity, user_message, linked_service, linked_post_id
        FROM warning_slots
        WHERE slot = $1 AND token IS NULL AND network IS NULL
        "#,
    )
    .bind(slot)
    .fetch_optional(executor)
    .await
}

async fn load_linked_warnings_for_service(
    pool: &PgPool,
    service: &str,
) -> Result<Vec<WarningSlotRow>, sqlx::Error> {
    sqlx::query_as::<_, WarningSlotRow>(
        r#"
        SELECT id, slot, token, network, is_active, response, severity, user_message, linked_service, linked_post_id
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

async fn ensure_unscoped_slot_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    target: &FallbackTarget,
    service: &str,
    activated_by: &str,
) -> Result<WarningSlotRow, String> {
    let user_message = target.message();

    if let Some(existing) = load_unscoped_slot(&mut **tx, target.slot)
        .await
        .map_err(|e| format!("failed to load warning slot: {e}"))?
    {
        return activate_existing_slot_in_tx(
            tx,
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
            slot, is_active, response, severity, user_message, situation,
            linked_service, linked_post_id, updated_by
        )
        VALUES ($1, true, $2, $3, $4, $5, $6, NULL, $7)
        RETURNING id, slot, token, network, is_active, response, severity, user_message, linked_service, linked_post_id
        "#,
    )
    .bind(target.slot)
    .bind(target.response)
    .bind(target.severity)
    .bind(&user_message)
    .bind(target.situation)
    .bind(service)
    .bind(activated_by)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| format!("failed to create warning slot: {e}"))
}

async fn activate_existing_slot_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
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
            response = $2,
            severity = $3,
            user_message = $4,
            situation = $5,
            linked_service = $6,
            linked_post_id = NULL,
            updated_by = $7,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, slot, token, network, is_active, response, severity, user_message, linked_service, linked_post_id
        "#,
    )
    .bind(existing.id)
    .bind(target.response)
    .bind(target.severity)
    .bind(user_message)
    .bind(target.situation)
    .bind(service)
    .bind(activated_by)
    .fetch_one(&mut **tx)
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

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|e| format!("failed to start fallback transaction: {e}"))?;

    for target in config.targets {
        let existing = load_unscoped_slot(&mut *tx, target.slot)
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

        let updated = ensure_unscoped_slot_in_tx(&mut tx, target, service, activated_by).await?;

        if first_warning_id.is_none() {
            first_warning_id = Some(updated.id);
        }

        db::insert_audit_log(
            &mut *tx,
            Some(updated.id),
            AuditAction::Activated,
            activated_by,
            json!({
                "slot": target.slot,
                "is_active": true,
                "response": updated.response,
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
        tx.rollback().await.ok();
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
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("failed to update status incident: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("failed to commit fallback activation: {e}"))?;

    db::invalidate_warnings_cache(state).await;

    Ok(first_warning_id)
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
        assert_eq!(backend.targets[0].situation, "backend_down");
        assert_eq!(backend.targets[0].response, "notice");
        assert!(backend.targets[0].message().contains("temporary issue"));

        let exchange = fallback_config("exchange").expect("exchange config");
        assert_eq!(exchange.targets.len(), 1);
        assert_eq!(exchange.targets[0].slot, "exchange");
        assert!(
            exchange.targets[0]
                .message()
                .contains("Exchange is temporarily paused")
        );

        let near_rpc = fallback_config("near-rpc").expect("near-rpc config");
        assert_eq!(near_rpc.targets[0].slot, "app");
        assert_eq!(near_rpc.targets[0].situation, "transactions_halted");
        assert!(
            near_rpc.targets[0]
                .message()
                .contains("Transactions are paused")
        );

        let near_protocol = fallback_config("near-protocol").expect("near-protocol config");
        assert_eq!(near_protocol.targets[0].situation, "whole_app_down");
    }

    #[test]
    fn near_intents_has_no_auto_fallback() {
        assert!(fallback_config("near-intents").is_none());
        assert!(!supports_fallback_button("near-intents"));
        assert!(parse_post_to_app_callback("post_to_app:near-intents").is_none());
    }

    #[test]
    fn fallback_config_returns_none_for_unknown_service() {
        assert!(fallback_config("unknown").is_none());
    }

    #[test]
    fn parse_post_to_app_callback_accepts_valid_data() {
        assert_eq!(
            parse_post_to_app_callback("post_to_app:backend"),
            Some("backend")
        );
        assert_eq!(
            parse_post_to_app_callback("post_to_app:near-rpc"),
            Some("near-rpc")
        );
    }
}

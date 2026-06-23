use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;

use crate::{
    AppState,
    handlers::warnings::templates,
    utils::cache::{Cache, CacheKey},
};

pub const SHOW_FALLBACK_CALLBACK_PREFIX: &str = "show_fallback:";

#[derive(Debug, Clone, Copy)]
pub struct FallbackConfig {
    pub slot: &'static str,
    pub severity: &'static str,
    pub scenario: &'static str,
}

impl FallbackConfig {
    /// Resolve the user-facing message from the shared template system.
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

const FALLBACK_CONFIGS: &[(&str, FallbackConfig)] = &[
    (
        "backend",
        FallbackConfig {
            slot: "app",
            severity: "warning",
            scenario: "tier1_backend",
        },
    ),
    (
        "exchange",
        FallbackConfig {
            slot: "exchange",
            severity: "critical",
            scenario: "swaps_paused",
        },
    ),
    (
        "near-intents",
        FallbackConfig {
            slot: "exchange",
            severity: "critical",
            scenario: "swaps_paused",
        },
    ),
    (
        "near-protocol",
        FallbackConfig {
            slot: "app",
            severity: "warning",
            scenario: "tier1_backend",
        },
    ),
    (
        "near-rpc",
        FallbackConfig {
            slot: "data.balances",
            severity: "warning",
            scenario: "balance_unavailable",
        },
    ),
];

pub fn fallback_config(service: &str) -> Option<&'static FallbackConfig> {
    FALLBACK_CONFIGS
        .iter()
        .find(|(name, _)| *name == service)
        .map(|(_, config)| config)
}

pub fn parse_show_fallback_callback(data: &str) -> Option<&str> {
    data.strip_prefix(SHOW_FALLBACK_CALLBACK_PREFIX)
        .filter(|service| fallback_config(service).is_some())
}

fn internal_note_for(service: &str) -> String {
    format!("auto-fallback:{service}")
}

async fn invalidate_warnings_cache(cache: &Cache) {
    let cache_key = CacheKey::new("public-warnings").build();
    cache.short_term.invalidate(&cache_key).await;
}

async fn insert_audit_log(
    pool: &PgPool,
    warning_id: Option<i32>,
    action: &str,
    changed_by: &str,
    changes: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO warning_audit_log (warning_id, action, changed_by, changes)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(warning_id)
    .bind(action)
    .bind(changed_by)
    .bind(changes)
    .execute(pool)
    .await?;

    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct WarningSlotRow {
    id: i32,
    is_active: bool,
    severity: String,
    user_message: Option<String>,
    internal_note: Option<String>,
}

/// Activate the fallback warning slot for a service.
pub async fn activate_fallback(
    state: &AppState,
    service: &str,
    activated_by: &str,
) -> Result<Option<i32>, String> {
    let config = fallback_config(service)
        .ok_or_else(|| format!("no fallback config for service: {service}"))?;
    let note = internal_note_for(service);

    let existing = sqlx::query_as::<_, WarningSlotRow>(
        r#"
        SELECT id, is_active, severity, user_message, internal_note
        FROM warning_slots
        WHERE slot = $1 AND token IS NULL AND network IS NULL
        "#,
    )
    .bind(config.slot)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| format!("failed to load warning slot: {e}"))?;

    let Some(existing) = existing else {
        return Err(format!("warning slot not found: {}", config.slot));
    };

    if existing.is_active && existing.internal_note.as_deref() == Some(note.as_str()) {
        return Ok(Some(existing.id));
    }

    let user_message = config.message();

    let updated = sqlx::query_as::<_, WarningSlotRow>(
        r#"
        UPDATE warning_slots
        SET
            is_active = true,
            severity = $2,
            user_message = $3,
            scenario = $4,
            internal_note = $5,
            updated_by = $6,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, is_active, severity, user_message, internal_note
        "#,
    )
    .bind(existing.id)
    .bind(config.severity)
    .bind(&user_message)
    .bind(config.scenario)
    .bind(&note)
    .bind(activated_by)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| format!("failed to activate warning slot: {e}"))?;

    insert_audit_log(
        &state.db_pool,
        Some(updated.id),
        "activated",
        activated_by,
        json!({
            "slot": config.slot,
            "is_active": true,
            "severity": updated.severity,
            "user_message": updated.user_message,
            "internal_note": updated.internal_note,
            "service": service,
            "source": "status_fallback",
        }),
    )
    .await
    .map_err(|e| format!("failed to write audit log: {e}"))?;

    sqlx::query(
        r#"
        UPDATE status_incidents
        SET fallback_activated_at = NOW(), warning_slot_id = $2
        WHERE service = $1 AND recovered_at IS NULL
        "#,
    )
    .bind(service)
    .bind(updated.id)
    .execute(&state.db_pool)
    .await
    .map_err(|e| format!("failed to update status incident: {e}"))?;

    invalidate_warnings_cache(&state.cache).await;

    Ok(Some(updated.id))
}

/// Deactivate auto-fallback warnings for a service after recovery.
pub async fn deactivate_fallback(state: &AppState, service: &str) -> Result<bool, String> {
    let note = internal_note_for(service);

    let existing = sqlx::query_as::<_, WarningSlotRow>(
        r#"
        SELECT id, is_active, severity, user_message, internal_note
        FROM warning_slots
        WHERE internal_note = $1 AND is_active = true
        "#,
    )
    .bind(&note)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| format!("failed to load auto-fallback warning: {e}"))?;

    let Some(existing) = existing else {
        return Ok(false);
    };

    sqlx::query(
        r#"
        UPDATE warning_slots
        SET is_active = false, updated_by = 'system', updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(existing.id)
    .execute(&state.db_pool)
    .await
    .map_err(|e| format!("failed to deactivate warning slot: {e}"))?;

    insert_audit_log(
        &state.db_pool,
        Some(existing.id),
        "deactivated",
        "system",
        json!({
            "slot": fallback_config(service).map(|c| c.slot),
            "is_active": false,
            "service": service,
            "source": "status_recovery",
        }),
    )
    .await
    .map_err(|e| format!("failed to write audit log: {e}"))?;

    invalidate_warnings_cache(&state.cache).await;

    Ok(true)
}

pub fn admin_page_url() -> String {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    std::env::var("BACKEND_BASE_URL").unwrap_or_else(|_| format!("http://127.0.0.1:{port}"))
        + "/internal/warnings"
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
        assert_eq!(backend.slot, "app");
        assert_eq!(backend.severity, "warning");
        assert!(!backend.message().is_empty());

        let exchange = fallback_config("exchange").expect("exchange config");
        assert_eq!(exchange.slot, "exchange");
        assert_eq!(
            exchange.message(),
            "Swaps are paused while price quotes recover."
        );

        let near_rpc = fallback_config("near-rpc").expect("near-rpc config");
        assert_eq!(near_rpc.slot, "data.balances");
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
    fn parse_show_fallback_callback_rejects_invalid_data() {
        assert!(parse_show_fallback_callback("show_fallback:unknown").is_none());
        assert!(parse_show_fallback_callback("other:backend").is_none());
        assert!(parse_show_fallback_callback("show_fallback:").is_none());
    }
}

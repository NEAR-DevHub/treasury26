use std::sync::Arc;

use serde_json::json;

use crate::{
    AppState,
    handlers::status::{
        config::{ALERT_AFTER_FAILURES, RECOVER_AFTER_SUCCESSES},
        fallbacks::{
            self, POST_TO_APP_CALLBACK_PREFIX, StatusIncident, admin_page_url, oh_dear_status_url,
        },
        notifications,
        oh_dear::{self, OhDearStatus, SUPPORTED_SERVICES},
    },
    handlers::warnings::db,
};

const INCIDENT_COLUMNS: &str = r#"
    id, service, check_name, status, first_failed_at, last_failed_at,
    recovered_at, telegram_message_id, fallback_activated_at, warning_slot_id,
    consecutive_failures, consecutive_successes
"#;

fn incident_status(status: &OhDearStatus) -> &'static str {
    match status {
        OhDearStatus::Warning => "warning",
        OhDearStatus::Failed | OhDearStatus::Crashed => "failed",
        OhDearStatus::Ok | OhDearStatus::Skipped => "ok",
    }
}

async fn load_active_incident(
    pool: &sqlx::PgPool,
    service: &str,
    check_name: &str,
) -> Result<Option<StatusIncident>, sqlx::Error> {
    sqlx::query_as::<_, StatusIncident>(&format!(
        r#"
        SELECT {INCIDENT_COLUMNS}
        FROM status_incidents
        WHERE service = $1 AND check_name = $2 AND recovered_at IS NULL
        "#
    ))
    .bind(service)
    .bind(check_name)
    .fetch_optional(pool)
    .await
}

async fn open_incident(
    pool: &sqlx::PgPool,
    service: &str,
    check_name: &str,
    status: &str,
) -> Result<StatusIncident, sqlx::Error> {
    sqlx::query_as::<_, StatusIncident>(&format!(
        r#"
        INSERT INTO status_incidents (
            service, check_name, status, consecutive_failures, consecutive_successes
        )
        VALUES ($1, $2, $3, 1, 0)
        ON CONFLICT (service, check_name) DO UPDATE SET
            status = EXCLUDED.status,
            first_failed_at = CASE
                WHEN status_incidents.recovered_at IS NOT NULL THEN NOW()
                ELSE status_incidents.first_failed_at
            END,
            last_failed_at = NOW(),
            recovered_at = NULL,
            telegram_message_id = CASE
                WHEN status_incidents.recovered_at IS NOT NULL THEN NULL
                ELSE status_incidents.telegram_message_id
            END,
            fallback_activated_at = CASE
                WHEN status_incidents.recovered_at IS NOT NULL THEN NULL
                ELSE status_incidents.fallback_activated_at
            END,
            warning_slot_id = CASE
                WHEN status_incidents.recovered_at IS NOT NULL THEN NULL
                ELSE status_incidents.warning_slot_id
            END,
            consecutive_failures = CASE
                WHEN status_incidents.recovered_at IS NOT NULL THEN 1
                ELSE status_incidents.consecutive_failures + 1
            END,
            consecutive_successes = 0
        RETURNING {INCIDENT_COLUMNS}
        "#
    ))
    .bind(service)
    .bind(check_name)
    .bind(status)
    .fetch_one(pool)
    .await
}

async fn touch_incident_failure(
    pool: &sqlx::PgPool,
    incident_id: i32,
    status: &str,
) -> Result<StatusIncident, sqlx::Error> {
    sqlx::query_as::<_, StatusIncident>(&format!(
        r#"
        UPDATE status_incidents
        SET status = $2,
            last_failed_at = NOW(),
            consecutive_failures = consecutive_failures + 1,
            consecutive_successes = 0
        WHERE id = $1
        RETURNING {INCIDENT_COLUMNS}
        "#
    ))
    .bind(incident_id)
    .bind(status)
    .fetch_one(pool)
    .await
}

async fn touch_incident_success(
    pool: &sqlx::PgPool,
    incident_id: i32,
) -> Result<StatusIncident, sqlx::Error> {
    sqlx::query_as::<_, StatusIncident>(&format!(
        r#"
        UPDATE status_incidents
        SET consecutive_successes = consecutive_successes + 1,
            consecutive_failures = 0
        WHERE id = $1
        RETURNING {INCIDENT_COLUMNS}
        "#
    ))
    .bind(incident_id)
    .fetch_one(pool)
    .await
}

async fn set_incident_telegram_message(
    pool: &sqlx::PgPool,
    incident_id: i32,
    message_id: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE status_incidents SET telegram_message_id = $2 WHERE id = $1")
        .bind(incident_id)
        .bind(message_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn recover_incident(pool: &sqlx::PgPool, incident_id: i32) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE status_incidents
        SET recovered_at = NOW(),
            consecutive_failures = 0,
            consecutive_successes = 0
        WHERE id = $1
        "#,
    )
    .bind(incident_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn delete_linked_warnings(state: &AppState, service: &str) {
    if fallbacks::fallback_config(service).is_some() {
        return;
    }

    #[derive(sqlx::FromRow)]
    struct LinkedWarning {
        id: i32,
        slot: Option<String>,
        token: Option<String>,
        network: Option<String>,
        response: String,
        severity: String,
        user_message: Option<String>,
        show_from: Option<chrono::DateTime<chrono::Utc>>,
        starts_at: Option<chrono::DateTime<chrono::Utc>>,
        ends_at: Option<chrono::DateTime<chrono::Utc>>,
    }

    let result = sqlx::query_as::<_, LinkedWarning>(
        r#"
        SELECT id, slot, token, network, response, severity, user_message,
               show_from, starts_at, ends_at
        FROM warning_slots
        WHERE linked_service = $1 AND linked_post_id IS NULL AND is_active = true
        "#,
    )
    .bind(service)
    .fetch_all(&state.db_pool)
    .await;

    match result {
        Ok(warnings) if !warnings.is_empty() => {
            for warning in &warnings {
                let changes = db::audit_delete_changes(
                    warning.id,
                    warning.slot.clone(),
                    warning.token.clone(),
                    warning.network.clone(),
                    json!({
                        "service": service,
                        "source": "linked_service_recovery",
                    }),
                );
                if let Err(e) =
                    db::delete_warning_with_audit(&state.db_pool, warning.id, "system", changes)
                        .await
                {
                    tracing::error!(
                        "[status-monitor] Failed to delete linked warning {} for {service}: {e}",
                        warning.id
                    );
                    continue;
                }

                notifications::notify_warning_event(
                    state,
                    notifications::WarningEvent {
                        action: notifications::WarningEventAction::Removed,
                        source: notifications::MessageTrigger::automatic(format!(
                            "{service} health check recovered"
                        )),
                        preview: notifications::WarningPreview::from_message(
                            warning.slot.as_deref(),
                            &warning.response,
                            &warning.severity,
                            warning.user_message.as_deref(),
                        ),
                        token: warning.token.clone(),
                        network: warning.network.clone(),
                        schedule: notifications::WarningSchedule {
                            show_from: warning.show_from,
                            starts_at: warning.starts_at,
                            ends_at: warning.ends_at,
                        },
                    },
                )
                .await;
            }
            db::invalidate_warnings_cache(state).await;
            tracing::info!(
                "[status-monitor] Deleted {} linked warning(s) for {service}",
                warnings.len()
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[status-monitor] Failed to delete linked warnings for {service}: {e}");
        }
    }
}

/// Check if any warnings linked to specific near-intents posts should be auto-closed.
/// A post is considered resolved if it no longer appears in the API or its `ends_at` has passed.
pub async fn check_linked_posts_resolved(state: &Arc<AppState>) {
    #[derive(sqlx::FromRow)]
    struct LinkedWarning {
        id: i32,
        slot: Option<String>,
        token: Option<String>,
        network: Option<String>,
        linked_post_id: Option<String>,
        response: String,
        severity: String,
        user_message: Option<String>,
        show_from: Option<chrono::DateTime<chrono::Utc>>,
        starts_at: Option<chrono::DateTime<chrono::Utc>>,
        ends_at: Option<chrono::DateTime<chrono::Utc>>,
    }

    let warnings = match sqlx::query_as::<_, LinkedWarning>(
        r#"
        SELECT id, slot, token, network, linked_post_id, response, severity,
               user_message, show_from, starts_at, ends_at
        FROM warning_slots
        WHERE linked_service = 'near-intents'
          AND linked_post_id IS NOT NULL
          AND is_active = true
        "#,
    )
    .fetch_all(&state.db_pool)
    .await
    {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("[status-monitor] Failed to load linked-post warnings: {e}");
            return;
        }
    };

    if warnings.is_empty() {
        return;
    }

    let posts = match oh_dear::fetch_intents_posts(state).await {
        Ok(posts) => posts,
        Err(e) => {
            tracing::error!("[status-monitor] Failed to fetch intents posts for linked check: {e}");
            return;
        }
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut deleted = Vec::new();

    for warning in &warnings {
        let Some(ref post_id) = warning.linked_post_id else {
            continue;
        };

        let post_still_active = posts.iter().any(|post| {
            post.id.as_deref() == Some(post_id.as_str())
                && match post.ends_at {
                    Some(ends) => now_ms < ends,
                    None => true,
                }
        });

        if !post_still_active {
            let changes = db::audit_delete_changes(
                warning.id,
                warning.slot.clone(),
                warning.token.clone(),
                warning.network.clone(),
                json!({
                    "linked_post_id": post_id,
                    "source": "linked_post_resolved",
                }),
            );
            if let Err(e) =
                db::delete_warning_with_audit(&state.db_pool, warning.id, "system", changes).await
            {
                tracing::error!(
                    "[status-monitor] Failed to delete warning {} for resolved post {post_id}: {e}",
                    warning.id
                );
                continue;
            }

            notifications::notify_warning_event(
                state,
                notifications::WarningEvent {
                    action: notifications::WarningEventAction::Removed,
                    source: notifications::MessageTrigger::automatic(format!(
                        "NEAR Intents status post resolved (#{post_id})"
                    )),
                    preview: notifications::WarningPreview::from_message(
                        warning.slot.as_deref(),
                        &warning.response,
                        &warning.severity,
                        warning.user_message.as_deref(),
                    ),
                    token: warning.token.clone(),
                    network: warning.network.clone(),
                    schedule: notifications::WarningSchedule {
                        show_from: warning.show_from,
                        starts_at: warning.starts_at,
                        ends_at: warning.ends_at,
                    },
                },
            )
            .await;

            deleted.push(warning.id);
        }
    }

    if !deleted.is_empty() {
        db::invalidate_warnings_cache(state).await;
        tracing::info!(
            "[status-monitor] Deleted {} warning(s) for resolved intents posts",
            deleted.len()
        );
    }
}

async fn process_service(state: &Arc<AppState>, service: &str) {
    let check = oh_dear::run_service_check(state, service).await;
    let Some(check) = check else {
        return;
    };

    let check_name = check.name.as_str();
    let unhealthy = oh_dear::is_unhealthy_status(&check.status);

    if unhealthy {
        let status = incident_status(&check.status);
        let incident = match load_active_incident(&state.db_pool, service, check_name).await {
            Ok(incident) => incident,
            Err(e) => {
                tracing::error!("[status-monitor] Failed to load incident for {service}: {e}");
                return;
            }
        };

        let incident = match incident {
            Some(existing) => {
                match touch_incident_failure(&state.db_pool, existing.id, status).await {
                    Ok(updated) => updated,
                    Err(e) => {
                        tracing::error!(
                            "[status-monitor] Failed to update incident {}: {e}",
                            existing.id
                        );
                        return;
                    }
                }
            }
            None => match open_incident(&state.db_pool, service, check_name, status).await {
                Ok(incident) => incident,
                Err(e) => {
                    tracing::error!("[status-monitor] Failed to open incident for {service}: {e}");
                    return;
                }
            },
        };

        // Wait for consecutive failures before notifying (filters brief blips).
        if incident.telegram_message_id.is_none()
            && incident.consecutive_failures >= ALERT_AFTER_FAILURES
        {
            let text = notifications::format_health_check_alert(
                service,
                check_name,
                status,
                &check.notification_message,
            );
            let callback_data = fallbacks::supports_fallback_button(service)
                .then(|| format!("{POST_TO_APP_CALLBACK_PREFIX}{service}"));
            let admin_url = admin_page_url();
            let check_url = oh_dear_status_url(service);

            match state
                .telegram_client
                .send_ops_alert_with_buttons(
                    &text,
                    &admin_url,
                    Some(&check_url),
                    callback_data.as_deref(),
                )
                .await
            {
                Ok(message_id) if message_id > 0 => {
                    tracing::info!(
                        "[status-monitor] Sent ops alert for {service} after {} failures (telegram message {message_id})",
                        incident.consecutive_failures
                    );
                    if let Err(e) =
                        set_incident_telegram_message(&state.db_pool, incident.id, message_id).await
                    {
                        tracing::error!(
                            "[status-monitor] Failed to persist telegram message id for incident {}: {e}",
                            incident.id
                        );
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::error!("[status-monitor] Failed to send ops alert for {service}: {e}");
                }
            }
        }
    } else {
        let incident = match load_active_incident(&state.db_pool, service, check_name).await {
            Ok(incident) => incident,
            Err(e) => {
                tracing::error!("[status-monitor] Failed to load incident for {service}: {e}");
                return;
            }
        };

        let Some(incident) = incident else {
            return;
        };

        let incident = match touch_incident_success(&state.db_pool, incident.id).await {
            Ok(updated) => updated,
            Err(e) => {
                tracing::error!(
                    "[status-monitor] Failed to record success for incident {}: {e}",
                    incident.id
                );
                return;
            }
        };

        // Require consecutive successes before recovering (stops alert↔recover flaps).
        if incident.consecutive_successes < RECOVER_AFTER_SUCCESSES {
            tracing::debug!(
                "[status-monitor] {service} healthy ({}/{} consecutive); holding incident open",
                incident.consecutive_successes,
                RECOVER_AFTER_SUCCESSES
            );
            return;
        }

        if let Err(e) = recover_incident(&state.db_pool, incident.id).await {
            tracing::error!(
                "[status-monitor] Failed to recover incident {}: {e}",
                incident.id
            );
            return;
        }

        delete_linked_warnings(state, service).await;

        match fallbacks::delete_fallback(state, service).await {
            Ok(Some(recovery)) => {
                tracing::info!(
                    "[status-monitor] Recovered {service}; deleted linked fallback warning(s)"
                );
                send_recovery_telegram(state, &recovery).await;
            }
            Ok(None) => {
                tracing::info!("[status-monitor] Recovered {service}");
            }
            Err(e) => {
                tracing::error!("[status-monitor] Failed to delete fallback for {service}: {e}");
            }
        }
    }
}

async fn delete_expired_warnings(state: &AppState) {
    #[derive(sqlx::FromRow)]
    struct ExpiredWarning {
        id: i32,
        slot: Option<String>,
        token: Option<String>,
        network: Option<String>,
        response: String,
        severity: String,
        user_message: Option<String>,
        show_from: Option<chrono::DateTime<chrono::Utc>>,
        starts_at: Option<chrono::DateTime<chrono::Utc>>,
        ends_at: Option<chrono::DateTime<chrono::Utc>>,
    }

    let warnings = match sqlx::query_as::<_, ExpiredWarning>(
        r#"
        SELECT id, slot, token, network, response, severity, user_message,
               show_from, starts_at, ends_at
        FROM warning_slots
        WHERE ends_at IS NOT NULL AND ends_at <= NOW()
        "#,
    )
    .fetch_all(&state.db_pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("[status-monitor] Failed to load expired warnings: {e}");
            return;
        }
    };

    if warnings.is_empty() {
        return;
    }

    let mut deleted = 0usize;
    for warning in warnings {
        let changes = db::audit_delete_changes(
            warning.id,
            warning.slot.clone(),
            warning.token.clone(),
            warning.network.clone(),
            json!({ "source": "expired_schedule" }),
        );
        if let Err(e) =
            db::delete_warning_with_audit(&state.db_pool, warning.id, "system", changes).await
        {
            tracing::error!(
                "[status-monitor] Failed to delete expired warning {}: {e}",
                warning.id
            );
            continue;
        }

        notifications::notify_warning_event(
            state,
            notifications::WarningEvent {
                action: notifications::WarningEventAction::Removed,
                source: notifications::MessageTrigger::automatic("scheduled end time reached"),
                preview: notifications::WarningPreview::from_message(
                    warning.slot.as_deref(),
                    &warning.response,
                    &warning.severity,
                    warning.user_message.as_deref(),
                ),
                token: warning.token.clone(),
                network: warning.network.clone(),
                schedule: notifications::WarningSchedule {
                    show_from: warning.show_from,
                    starts_at: warning.starts_at,
                    ends_at: warning.ends_at,
                },
            },
        )
        .await;

        deleted += 1;
    }

    if deleted > 0 {
        db::invalidate_warnings_cache(state).await;
        tracing::info!("[status-monitor] Deleted {deleted} expired scheduled warning(s)");
    }
}

async fn send_recovery_telegram(state: &Arc<AppState>, recovery: &fallbacks::AutoFallbackRecovery) {
    let text = notifications::format_recovery_message(recovery);
    if let Err(e) = state.telegram_client.send_ops_alert_html(&text).await {
        tracing::error!("[status-monitor] Failed to send recovery ops alert: {e}");
    }
}

pub async fn run_monitor_cycle(state: &Arc<AppState>) {
    futures::future::join_all(SUPPORTED_SERVICES.iter().map(|&service| {
        let state = Arc::clone(state);
        async move {
            process_service(&state, service).await;
        }
    }))
    .await;

    check_linked_posts_resolved(state).await;
    delete_expired_warnings(state).await;

    match fallbacks::cleanup_stale_auto_fallbacks(state).await {
        Ok(recoveries) => {
            for recovery in recoveries {
                let slot = match &recovery.trigger {
                    fallbacks::RecoveryTrigger::StaleCleanup { slot } => slot.as_str(),
                    fallbacks::RecoveryTrigger::Service { service } => service.as_str(),
                };
                tracing::info!(
                    "[status-monitor] Cleared stale auto-linked fallback warning(s) for {slot}"
                );
                send_recovery_telegram(state, &recovery).await;
            }
        }
        Err(e) => {
            tracing::error!("[status-monitor] Failed stale auto-fallback cleanup: {e}");
        }
    }
}

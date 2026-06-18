//! Telegram notification dispatcher.
//!
//! Reads undelivered rows from `dao_notifications` for DAOs that have a
//! connected Telegram chat and sends a message via the bot.
//!
//! Delivery is tracked in `dao_notification_deliveries` with ON CONFLICT DO NOTHING,
//! so restarting the worker never causes duplicate messages.

use crate::{
    AppState,
    handlers::{
        notifications::payload_decoder::{
            collect_notification_token_ids, decode_notification_content,
        },
        token::metadata::fetch_tokens_metadata_enriched,
    },
    utils::telegram::TelegramClient,
};
use std::sync::Arc;

const BATCH_SIZE: i64 = 50;

#[derive(sqlx::FromRow)]
struct PendingNotification {
    id: i64,
    dao_id: String,
    event_type: String,
    payload: serde_json::Value,
    chat_id: i64,
}

/// Read undelivered `dao_notifications` for Telegram-connected DAOs and send messages.
///
/// Returns the number of notifications successfully sent.
pub async fn run_telegram_dispatch_cycle(
    state: &Arc<AppState>,
    telegram_client: &TelegramClient,
    frontend_base_url: &str,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let pending: Vec<PendingNotification> = sqlx::query_as(
        r#"
        SELECT n.id, n.dao_id, n.event_type, n.payload, ttc.chat_id
        FROM dao_notifications n
        JOIN telegram_treasury_connections ttc ON ttc.dao_id = n.dao_id
        LEFT JOIN dao_notification_deliveries d
            ON d.notification_id = n.id
            AND d.destination = 'telegram'
            AND d.destination_ref = ttc.chat_id::text
        WHERE d.id IS NULL
          AND n.created_at >= ttc.connected_at
        ORDER BY n.id ASC
        LIMIT $1
        "#,
    )
    .bind(BATCH_SIZE)
    .fetch_all(&state.db_pool)
    .await?;

    if pending.is_empty() {
        return Ok(0);
    }

    let mut token_ids_to_fetch: Vec<String> = Vec::new();
    for notif in &pending {
        token_ids_to_fetch.extend(collect_notification_token_ids(
            &notif.event_type,
            &notif.payload,
        ));
    }
    token_ids_to_fetch.sort();
    token_ids_to_fetch.dedup();
    let token_metadata_map =
        fetch_tokens_metadata_enriched(state, &token_ids_to_fetch, false).await;

    let mut sent = 0usize;

    for notif in &pending {
        let decoded = decode_notification_content(
            &notif.event_type,
            &notif.dao_id,
            &notif.payload,
            &token_metadata_map,
            frontend_base_url,
        );
        let text = if decoded.subtitle.is_empty() {
            decoded.title.clone()
        } else {
            format!("{}\n{}", decoded.title, decoded.subtitle)
        };

        match telegram_client
            .send_message_with_button(
                notif.chat_id,
                &text,
                &decoded.action_text,
                &decoded.action_link,
            )
            .await
        {
            Ok(_) => {
                let destination_ref = notif.chat_id.to_string();
                let result = sqlx::query!(
                    r#"
                    INSERT INTO dao_notification_deliveries
                        (notification_id, destination, destination_ref)
                    VALUES ($1, 'telegram', $2)
                    ON CONFLICT (notification_id, destination, destination_ref) DO NOTHING
                    "#,
                    notif.id,
                    &destination_ref,
                )
                .execute(&state.db_pool)
                .await;

                if let Err(e) = result {
                    log::warn!(
                        "[telegram-dispatch] Failed to record delivery for notification {}: {}",
                        notif.id,
                        e
                    );
                } else {
                    sent += 1;
                }
            }
            Err(e) => {
                log::warn!(
                    "[telegram-dispatch] Failed to send notification {} to chat {}: {}",
                    notif.id,
                    notif.chat_id,
                    e
                );
            }
        }
    }

    Ok(sent)
}

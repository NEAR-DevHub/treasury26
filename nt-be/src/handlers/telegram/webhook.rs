use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use std::sync::Arc;
use teloxide::types::{ChatMemberKind, Update, UpdateKind};
use teloxide::utils::command::parse_command;

use crate::AppState;

/// Axum handler for incoming Telegram webhook updates.
///
/// Validates the `X-Telegram-Bot-Api-Secret-Token` header, then dispatches
/// to the appropriate internal handler based on update kind.
pub async fn handle_telegram_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(update): Json<Update>,
) -> StatusCode {
    // Validate the webhook secret token
    let expected = state.env_vars.telegram_webhook_secret.as_deref();
    let received = headers
        .get("X-Telegram-Bot-Api-Secret-Token")
        .and_then(|v| v.to_str().ok());

    match (expected, received) {
        (Some(e), Some(r)) if e == r => {}
        (None, _) => {} // No secret configured — allow all (dev mode)
        _ => return StatusCode::UNAUTHORIZED,
    }

    match update.kind {
        UpdateKind::MyChatMember(m) => match m.new_chat_member.kind {
            ChatMemberKind::Member(_)
            | ChatMemberKind::Administrator(_)
            | ChatMemberKind::Owner(_) => {
                handle_bot_added(&state, m.chat.id.0, m.chat.title()).await;
            }
            ChatMemberKind::Banned(_) | ChatMemberKind::Left => {
                handle_bot_removed(&state, m.chat.id.0).await;
            }
            ChatMemberKind::Restricted(_) => {}
        },
        UpdateKind::Message(msg)
            if msg
                .text()
                .and_then(|t| parse_command(t, "").map(|(cmd, _)| cmd))
                .is_some_and(|cmd| matches!(cmd, "start" | "connect")) =>
        {
            handle_bot_added(&state, msg.chat.id.0, msg.chat.title()).await;
        }
        _ => {}
    }

    StatusCode::OK
}

async fn handle_bot_added(state: &AppState, chat_id: i64, chat_title: Option<&str>) {
    // Upsert the chat record
    let upsert_result = sqlx::query!(
        r#"
        INSERT INTO telegram_chats (chat_id, chat_title)
        VALUES ($1, $2)
        ON CONFLICT (chat_id) DO UPDATE
            SET chat_title = EXCLUDED.chat_title, updated_at = now()
        "#,
        chat_id,
        chat_title,
    )
    .execute(&state.db_pool)
    .await;

    if let Err(e) = upsert_result {
        tracing::error!("Failed to upsert chat {}: {}", chat_id, e);
        return;
    }

    // Create a fresh connect token
    let token_result = sqlx::query_scalar::<_, uuid::Uuid>(
        "INSERT INTO telegram_connect_tokens (chat_id) VALUES ($1) RETURNING token",
    )
    .bind(chat_id)
    .fetch_one(&state.db_pool)
    .await;

    let token = match token_result {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("Failed to create connect token for chat {}: {}", chat_id, e);
            return;
        }
    };

    let connect_url = format!(
        "{}/telegram/connect?token={}",
        state.env_vars.frontend_base_url, token
    );

    let existing_connections = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM telegram_treasury_connections WHERE chat_id = $1",
    )
    .bind(chat_id)
    .fetch_one(&state.db_pool)
    .await
    .unwrap_or(0);

    let prompt_text = if existing_connections > 0 {
        format!(
            "✅ This chat has {} connected {}.\nUse the button below to review or update treasury connections.",
            existing_connections,
            if existing_connections == 1 {
                "treasury"
            } else {
                "treasuries"
            }
        )
    } else {
        "✅ No treasuries are connected to this chat.\nUse the button below to connect one."
            .to_string()
    };

    let sent_message_id = match state
        .telegram_client
        .send_message_with_button(chat_id, &prompt_text, "Connect Treasury", &connect_url)
        .await
    {
        Ok(message_id) => message_id,
        Err(e) => {
            tracing::error!("Failed to send connect message to chat {}: {}", chat_id, e);
            return;
        }
    };

    if let Err(e) = sqlx::query!(
        "UPDATE telegram_connect_tokens SET message_id = $1 WHERE token = $2",
        sent_message_id,
        token,
    )
    .execute(&state.db_pool)
    .await
    {
        tracing::warn!(
            "Failed to persist connect message_id for chat {}: {}",
            chat_id,
            e
        );
    }
}

async fn handle_bot_removed(state: &AppState, chat_id: i64) {
    // Cascade deletes tokens and connections automatically
    if let Err(e) = sqlx::query!("DELETE FROM telegram_chats WHERE chat_id = $1", chat_id)
        .execute(&state.db_pool)
        .await
    {
        tracing::error!("Failed to delete chat {}: {}", chat_id, e);
    }
}

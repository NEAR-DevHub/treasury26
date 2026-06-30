use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use std::sync::Arc;
use teloxide::{
    payloads::AnswerCallbackQuerySetters,
    prelude::Requester,
    types::{ChatMemberKind, Update, UpdateKind},
    utils::command::parse_command,
};

use crate::{
    AppState,
    handlers::status::{
        fallbacks::{self, parse_post_to_app_callback},
        notifications,
    },
};

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
        (Some(e), Some(r)) if crate::utils::admin_auth::constant_time_eq(e, r) => {}
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
        UpdateKind::CallbackQuery(callback) => {
            handle_callback_query(&state, callback).await;
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

async fn handle_callback_query(state: &AppState, callback: teloxide::types::CallbackQuery) {
    let Some(data) = callback.data.as_deref() else {
        return;
    };

    let Some(service) = parse_post_to_app_callback(data) else {
        return;
    };

    let Some(message) = callback.message.as_ref() else {
        return;
    };

    let chat_id = message.chat().id.0;
    if !is_ops_chat(state, chat_id) {
        answer_callback_query(state, callback.id.clone(), Some("Unauthorized")).await;
        return;
    }

    let activated_by = callback
        .from
        .username
        .as_deref()
        .or(Some(callback.from.first_name.as_str()))
        .unwrap_or("telegram-user");

    match fallbacks::activate_fallback(state, service, activated_by).await {
        Ok(warning_id) => {
            let already_active = warning_id.is_none();
            let note =
                notifications::format_activation_message(service, activated_by, already_active);
            if let Err(e) = state.telegram_client.send_ops_alert_html(&note).await {
                tracing::error!(
                    "[telegram] Failed to send post-to-app confirmation in chat {chat_id}: {e}"
                );
            }
            let callback_text = if already_active {
                "Warning already active"
            } else {
                "Posted to app"
            };
            answer_callback_query(state, callback.id.clone(), Some(callback_text)).await;
        }
        Err(e) => {
            tracing::error!("[telegram] Failed to activate fallback for {service}: {e}");
            answer_callback_query(
                state,
                callback.id.clone(),
                Some("Failed to activate fallback"),
            )
            .await;
        }
    }
}

fn is_ops_chat(state: &AppState, chat_id: i64) -> bool {
    let parse = |s: &str| s.parse::<i64>().ok();
    // Accept callbacks from the dedicated ops channel; fall back to the general
    // channel so existing setups without TELEGRAM_OPS_CHAT_ID keep working.
    let ops = state
        .env_vars
        .telegram_ops_chat_id
        .as_deref()
        .and_then(parse);
    let general = state.env_vars.telegram_chat_id.as_deref().and_then(parse);
    ops.or(general).is_some_and(|id| id == chat_id)
}

async fn answer_callback_query(
    state: &AppState,
    callback_id: teloxide::types::CallbackQueryId,
    text: Option<&str>,
) {
    let Some(bot) = state.telegram_client.bot() else {
        return;
    };

    let mut request = bot.answer_callback_query(callback_id);
    if let Some(text) = text {
        request = request.text(text);
    }

    if let Err(e) = request.await {
        tracing::warn!("[telegram] Failed to answer callback query: {e}");
    }
}

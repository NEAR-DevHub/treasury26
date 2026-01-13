//! Telegram client for sending notifications via Telegram Bot API.
//!
//! This module provides a simple client for sending messages to a Telegram chat
//! using a bot token. If the bot is not configured (missing token or chat ID),
//! messages are logged as warnings instead of failing.
//!
//! # Environment Variables
//! - `TELEGRAM_BOT_TOKEN`: The Telegram bot token for authentication
//! - `TELEGRAM_CHAT_ID`: The chat ID where messages will be sent
//!
//! # Examples
//! ```no_run
//! use nt_be::utils::telegram::TelegramClient;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let client = TelegramClient::new(
//!     Some("bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string()),
//!     Some("123456789".to_string()),
//! );
//!
//! client.send_message("Hello from Rust!").await?;
//! # Ok(())
//! # }
//! ```

#[derive(Clone, Debug, Default)]
pub struct TelegramClient {
    bot: Option<(String, String)>,
}

impl TelegramClient {
    /// Creates a new TelegramClient with optional bot token and chat ID.
    ///
    /// If either parameter is None, the client will be unconfigured and
    /// messages will be logged as warnings instead of sent.
    pub fn new(bot_token: Option<String>, chat_id: Option<String>) -> Self {
        Self {
            bot: bot_token.zip(chat_id),
        }
    }

    /// Sends a message to the configured Telegram chat.
    ///
    /// If the client is not configured (missing token or chat ID), this logs
    /// a warning and returns Ok without sending the message.
    ///
    /// # Errors
    /// Returns an error if:
    /// - The network request fails
    /// - The Telegram API returns a non-success status code
    pub async fn send_message(&self, message: &str) -> Result<(), Box<dyn std::error::Error>> {
        if let Some((bot_token, chat_id)) = &self.bot {
            let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);
            let response = reqwest::Client::new()
                .post(url)
                .json(&serde_json::json!({
                    "chat_id": chat_id,
                    "text": message,
                }))
                .send()
                .await?;

            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(format!("Telegram API returned {}: {}", status, body).into());
            }
            Ok(())
        } else {
            log::warn!(
                "Telegram client not configured. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment variables. Message ignored: {}",
                message
            );
            Ok(())
        }
    }
}

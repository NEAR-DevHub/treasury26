use teloxide::{
    Bot,
    payloads::{EditMessageTextSetters, SendMessageSetters},
    requests::Requester,
    types::{ChatId, InlineKeyboardButton, InlineKeyboardMarkup, ParseMode},
};
use url::Url;

/// Telegram bot client wrapping teloxide's Bot.
///
/// Provides helper methods for common messaging patterns used across the app:
/// - `send_message`: send a plain notification to the configured internal alerts channel
/// - `send_message_to_chat`: send a plain message to any chat by ID
/// - `send_message_with_button`: send a message with an inline URL button to any chat (HTML parse mode)
///
/// All methods silently succeed when the bot is not configured (missing token).
#[derive(Clone, Default, Debug)]
pub struct TelegramClient {
    pub(crate) bot: Option<Bot>,
    /// General notifications channel (`TELEGRAM_CHAT_ID`).
    notification_chat_id: Option<String>,
    /// Dedicated ops / monitoring channel (`TELEGRAM_OPS_CHAT_ID`).
    ops_chat_id: Option<String>,
}

impl TelegramClient {
    /// Create a new TelegramClient.
    ///
    /// - `bot_token`: the Telegram Bot API token (`TELEGRAM_BOT_TOKEN`)
    /// - `chat_id`: general notifications channel (`TELEGRAM_CHAT_ID`)
    /// - `ops_chat_id`: status-monitor ops channel (`TELEGRAM_OPS_CHAT_ID`)
    pub fn new(
        bot_token: Option<String>,
        chat_id: Option<String>,
        ops_chat_id: Option<String>,
    ) -> Self {
        Self {
            bot: bot_token.filter(|s| !s.is_empty()).map(Bot::new),
            notification_chat_id: chat_id,
            ops_chat_id,
        }
    }

    /// Expose the inner teloxide Bot, if configured.
    pub fn bot(&self) -> Option<&Bot> {
        self.bot.as_ref()
    }

    /// Send a plain-text notification to the ops monitoring channel (HTML).
    pub async fn send_ops_alert_html(
        &self,
        text: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (bot, chat_id_str) = match (&self.bot, &self.ops_chat_id) {
            (Some(b), Some(c)) => (b, c),
            _ => {
                tracing::warn!(
                    "Ops channel not configured (TELEGRAM_OPS_CHAT_ID). Alert ignored: {}",
                    text
                );
                return Ok(());
            }
        };

        let chat_id: i64 = chat_id_str
            .parse()
            .map_err(|_| format!("Invalid TELEGRAM_OPS_CHAT_ID: {}", chat_id_str))?;

        bot.send_message(ChatId(chat_id), text)
            .parse_mode(ParseMode::Html)
            .await?;
        Ok(())
    }

    /// Send a plain-text notification to the configured internal alerts channel.
    ///
    /// This is the legacy method used for internal operational alerts (user creation,
    /// treasury creation, whitelist requests). The chat ID comes from `TELEGRAM_CHAT_ID`.
    pub async fn send_message(
        &self,
        message: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (bot, chat_id_str) = match (&self.bot, &self.notification_chat_id) {
            (Some(b), Some(c)) => (b, c),
            _ => {
                tracing::warn!(
                    "Telegram client not configured. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Message ignored: {}",
                    message
                );
                return Ok(());
            }
        };

        let chat_id: i64 = chat_id_str
            .parse()
            .map_err(|_| format!("Invalid TELEGRAM_CHAT_ID: {}", chat_id_str))?;

        bot.send_message(ChatId(chat_id), message).await?;
        Ok(())
    }

    /// Send a plain-text message to an arbitrary Telegram chat.
    pub async fn send_message_to_chat(
        &self,
        chat_id: i64,
        text: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let bot = match &self.bot {
            Some(b) => b,
            None => {
                tracing::warn!(
                    "Telegram bot not configured (TELEGRAM_BOT_TOKEN not set). Message to chat {} ignored.",
                    chat_id
                );
                return Ok(());
            }
        };

        bot.send_message(ChatId(chat_id), text).await?;
        Ok(())
    }

    /// Send a message with a single inline URL button to an arbitrary Telegram chat.
    pub async fn send_message_with_button(
        &self,
        chat_id: i64,
        text: &str,
        button_label: &str,
        button_url: &str,
    ) -> Result<i32, Box<dyn std::error::Error + Send + Sync>> {
        let bot = match &self.bot {
            Some(b) => b,
            None => {
                tracing::warn!(
                    "Telegram bot not configured (TELEGRAM_BOT_TOKEN not set). Message with button to chat {} ignored.",
                    chat_id
                );
                return Ok(0);
            }
        };

        let parsed_url: Url = button_url
            .parse()
            .map_err(|_| format!("Invalid button URL: {}", button_url))?;

        let keyboard =
            InlineKeyboardMarkup::new([[InlineKeyboardButton::url(button_label, parsed_url)]]);

        let sent = bot
            .send_message(ChatId(chat_id), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(keyboard)
            .await?;
        Ok(sent.id.0)
    }

    /// Send an ops-channel alert with optional "Post to app" callback,
    /// "Open admin", and "View check" URL buttons.
    pub async fn send_ops_alert_with_buttons(
        &self,
        text: &str,
        admin_url: &str,
        check_url: Option<&str>,
        callback_data: Option<&str>,
    ) -> Result<i32, Box<dyn std::error::Error + Send + Sync>> {
        let (bot, chat_id_str) = match (&self.bot, &self.ops_chat_id) {
            (Some(b), Some(c)) => (b, c),
            _ => {
                tracing::warn!(
                    "Ops channel not configured (TELEGRAM_OPS_CHAT_ID). Alert ignored: {}",
                    text
                );
                return Ok(0);
            }
        };

        let chat_id: i64 = chat_id_str
            .parse()
            .map_err(|_| format!("Invalid TELEGRAM_OPS_CHAT_ID: {}", chat_id_str))?;

        let parsed_admin_url: Url = admin_url
            .parse()
            .map_err(|_| format!("Invalid admin URL: {}", admin_url))?;

        let admin_button = InlineKeyboardButton::url("Open admin", parsed_admin_url);

        let mut rows = match callback_data {
            Some(callback_data) => vec![vec![
                InlineKeyboardButton::callback("Post to app", callback_data.to_string()),
                admin_button,
            ]],
            None => vec![vec![admin_button]],
        };

        if let Some(check_url) = check_url {
            let parsed_check_url: Url = check_url
                .parse()
                .map_err(|_| format!("Invalid check URL: {}", check_url))?;
            rows.push(vec![InlineKeyboardButton::url(
                "View check",
                parsed_check_url,
            )]);
        }

        let keyboard = InlineKeyboardMarkup::new(rows);

        let sent = bot
            .send_message(ChatId(chat_id), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(keyboard)
            .await?;
        Ok(sent.id.0)
    }

    /// Edit an existing message in an arbitrary Telegram chat.
    pub async fn edit_message_text(
        &self,
        chat_id: i64,
        message_id: i32,
        text: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let bot = match &self.bot {
            Some(b) => b,
            None => {
                tracing::warn!(
                    "Telegram bot not configured (TELEGRAM_BOT_TOKEN not set). Edit message {} in chat {} ignored.",
                    message_id,
                    chat_id
                );
                return Ok(());
            }
        };

        if let Err(edit_err) = bot
            .edit_message_text(
                ChatId(chat_id),
                teloxide::types::MessageId(message_id),
                text,
            )
            .parse_mode(ParseMode::Html)
            .await
        {
            tracing::warn!(
                "Edit message {} in chat {} failed: {}. Falling back to send_message.",
                message_id,
                chat_id,
                edit_err
            );
            bot.send_message(ChatId(chat_id), text)
                .parse_mode(ParseMode::Html)
                .await?;
        }

        Ok(())
    }

    /// Ask the bot to leave a group/supergroup/channel chat.
    ///
    /// For private chats, Telegram does not allow bots to "leave" in the same way.
    pub async fn leave_chat(
        &self,
        chat_id: i64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let bot = match &self.bot {
            Some(b) => b,
            None => {
                tracing::warn!(
                    "Telegram bot not configured (TELEGRAM_BOT_TOKEN not set). leave_chat {} ignored.",
                    chat_id
                );
                return Ok(());
            }
        };

        bot.leave_chat(ChatId(chat_id)).await?;
        Ok(())
    }
}

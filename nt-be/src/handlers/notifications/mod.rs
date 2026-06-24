pub mod detector;
pub mod formatting;
pub mod payload_decoder;
pub mod telegram_dispatcher;

use crate::{AppState, utils::telegram::TelegramClient};
use std::sync::Arc;
use std::time::Duration;

const INTERVAL_SECS: u64 = 15;
const INITIAL_DELAY_SECS: u64 = 20;

/// Spawn the notification worker: event detection + Telegram dispatch run
/// concurrently every cycle via `tokio::join!`.
///
/// Detection scans `balance_changes` and `detected_swaps` for new events and
/// writes them to `dao_notifications`. Dispatch reads undelivered rows and sends
/// Telegram messages to connected chats.
///
/// Both functions are idempotent — safe to restart at any time.
pub fn run_notification_loop(
    state: Arc<AppState>,
    telegram_client: TelegramClient,
    frontend_base_url: String,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;
        loop {
            {
                let (det_result, disp_result) = tokio::join!(
                    detector::run_detection_cycle(&state.db_pool),
                    telegram_dispatcher::run_telegram_dispatch_cycle(
                        &state,
                        &telegram_client,
                        &frontend_base_url,
                    ),
                );
                if let Err(e) = det_result {
                    tracing::error!("Detection failed: {}", e);
                }
                match disp_result {
                    Ok(n) if n > 0 => {
                        tracing::info!("Sent {} notifications", n)
                    }
                    Err(e) => tracing::error!("Dispatch failed: {}", e),
                    _ => {}
                }
            }
            tokio::time::sleep(Duration::from_secs(INTERVAL_SECS)).await;
        }
    });
}

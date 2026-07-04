use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use near_api::{NearToken, Tokens};
use tokio::sync::RwLock;

use crate::{AppState, constants::ALERT_LOW_BALANCE_THRESHOLD, utils::telegram::TelegramClient};

const ALERT_COOLDOWN: Duration = Duration::from_secs(3600);

static LAST_ALERT_SENT_AT: LazyLock<RwLock<Option<Instant>>> = LazyLock::new(|| RwLock::new(None));

/// Returns true when liquid balance is below the sponsor low-balance threshold.
pub(crate) fn is_balance_low(liquid: NearToken) -> bool {
    liquid < ALERT_LOW_BALANCE_THRESHOLD
}

/// Returns true when enough time has passed since the last alert to send another.
pub(crate) fn cooldown_allows_alert(last_sent: Option<Instant>, now: Instant) -> bool {
    match last_sent {
        None => true,
        Some(sent_at) => now.duration_since(sent_at) >= ALERT_COOLDOWN,
    }
}

pub(crate) fn format_low_balance_message(account_id: &str, liquid: NearToken) -> String {
    format!(
        "⚠️ Sponsor balance low\nAccount: {}\nLiquid: {} (threshold: {})",
        account_id, liquid, ALERT_LOW_BALANCE_THRESHOLD,
    )
}

pub async fn fetch_sponsor_liquid_balance(
    state: &AppState,
) -> Result<NearToken, Box<dyn std::error::Error + Send + Sync>> {
    let balance = Tokens::account(state.signer_id.clone())
        .near_balance()
        .fetch_from(&state.network)
        .await?;

    Ok(NearToken::from_yoctonear(
        balance
            .total
            .as_yoctonear()
            .saturating_sub(balance.storage_locked.as_yoctonear()),
    ))
}

pub async fn run_sponsor_monitor_cycle(
    state: &Arc<AppState>,
    telegram_client: &TelegramClient,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = Instant::now();
    let last_sent = *LAST_ALERT_SENT_AT.read().await;
    if !cooldown_allows_alert(last_sent, now) {
        return Ok(());
    }

    let liquid = fetch_sponsor_liquid_balance(state).await?;
    if !is_balance_low(liquid) {
        return Ok(());
    }

    let message = format_low_balance_message(state.signer_id.as_str(), liquid);
    telegram_client.send_message(&message).await?;

    *LAST_ALERT_SENT_AT.write().await = Some(now);
    tracing::warn!(
        "Sent low-balance alert for {} (liquid: {})",
        state.signer_id,
        liquid,
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_balance_low_when_below_threshold() {
        assert!(is_balance_low(NearToken::from_near(4)));
        assert!(!is_balance_low(NearToken::from_near(5)));
        assert!(!is_balance_low(NearToken::from_near(10)));
    }

    #[test]
    fn cooldown_allows_first_alert() {
        assert!(cooldown_allows_alert(None, Instant::now()));
    }

    #[test]
    fn cooldown_blocks_within_one_hour() {
        let now = Instant::now();
        let recent = now - Duration::from_secs(1800);
        assert!(!cooldown_allows_alert(Some(recent), now));
    }

    #[test]
    fn cooldown_allows_after_one_hour() {
        let now = Instant::now();
        let old = now - ALERT_COOLDOWN;
        assert!(cooldown_allows_alert(Some(old), now));
    }

    #[test]
    fn format_low_balance_message_includes_account_and_amounts() {
        let msg = format_low_balance_message("sponsor.trezu.near", NearToken::from_near(3));
        assert!(msg.contains("sponsor.trezu.near"));
        assert!(msg.contains(&NearToken::from_near(3).to_string()));
        assert!(msg.contains(&ALERT_LOW_BALANCE_THRESHOLD.to_string()));
    }
}

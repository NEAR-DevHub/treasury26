//! Message templates for the warning system.
//!
//! Two kinds of warnings are auto-templated:
//!   1. Token/network-scoped warnings (Section 1 of the UI mapping) -- generated
//!      purely from severity + token/network.
//!   2. Feature/data/app-scoped warnings (Sections 2-4) -- generated from a
//!      predefined `scenario` chosen by the admin.
//!
//! Generated messages may contain a literal `{action}` placeholder that the
//! frontend fills in per page (e.g. "payment", "deposit", "exchange").

const STATUS_PAGE_LINK: &str = "[Status page](https://status.trezu.org/)";

const TOKEN_NETWORK_CRITICAL_SECONDARY_TOKEN: &str =
    "You can use a different token in the meantime.";
const TOKEN_NETWORK_CRITICAL_SECONDARY_NETWORK: &str =
    "You can use a different network in the meantime.";
const TOKEN_NETWORK_WARNING_BODY: &str =
    "Your {action} will go through once it recovers, it just may take longer than usual.";

/// Action words substituted for `{action}` per slot (admin preview + public API).
pub fn action_by_slot() -> std::collections::HashMap<String, String> {
    [
        ("payments", "payment"),
        ("deposit", "deposit"),
        ("exchange", "exchange"),
        ("action.vote", "vote"),
        ("action.create-proposal", "proposal"),
        ("data.balances", "transaction"),
        ("data.prices", "transaction"),
    ]
    .into_iter()
    .map(|(slot, action)| (slot.to_string(), action.to_string()))
    .collect()
}

fn scenario_label(scenario: &str) -> String {
    match scenario {
        "scheduled_maintenance" => "Scheduled maintenance".into(),
        "cant_process" => "Can't process requests".into(),
        "swaps_paused" => "Swaps are paused".into(),
        "payments_paused" => "Payments paused".into(),
        "deposits_paused" => "Deposits paused".into(),
        "requests_blocked" => "Requests blocked".into(),
        "balance_unavailable" => "Balance unavailable".into(),
        "history_not_loading" => "History not loading".into(),
        "prices_delayed" => "Prices delayed".into(),
        "tier1_backend" => "Tier 1 · Backend issue".into(),
        "tier2_tx_paused" => "Tier 2 · Transactions paused".into(),
        "tier3_down" => "Tier 3 · App temporarily down".into(),
        "tier4_investigating" => "Tier 4 · Under investigation".into(),
        _ => scenario.to_string(),
    }
}

/// All scenario-based message templates as (slot, scenario, message) tuples.
/// Single source of truth — used by `scenario_messages()` at runtime and
/// `template_data_json()` to feed the admin UI.
fn scenario_entries() -> Vec<(&'static str, &'static str, String)> {
    let cant_process = merge_warning_message(
        "Can't process new requests right now",
        "A temporary network issue. Your funds are unaffected — try again shortly.",
    );

    vec![
        // Virtual "features" slot (Payments + Exchange + Deposits). Generic
        // wording since one warning covers all three actions.
        (
            "features",
            "scheduled_maintenance",
            merge_warning_message(
                "Scheduled update",
                "Payments, swaps, and deposits will be briefly unavailable {schedule}.",
            ),
        ),
        ("features", "cant_process", cant_process.clone()),
        (
            "exchange",
            "swaps_paused",
            merge_warning_message(
                "Swaps are paused",
                "Price quotes are recovering — try again shortly.",
            ),
        ),
        ("exchange", "cant_process", cant_process.clone()),
        (
            "exchange",
            "scheduled_maintenance",
            merge_warning_message(
                "Scheduled update",
                "Exchange will be briefly unavailable {schedule}.",
            ),
        ),
        (
            "payments",
            "payments_paused",
            merge_warning_message("Payments are paused right now.", ""),
        ),
        ("payments", "cant_process", cant_process.clone()),
        (
            "payments",
            "scheduled_maintenance",
            merge_warning_message(
                "Scheduled update",
                "Payments will be briefly unavailable {schedule}.",
            ),
        ),
        (
            "deposit",
            "deposits_paused",
            merge_warning_message("Deposits are paused right now.", ""),
        ),
        (
            "deposit",
            "scheduled_maintenance",
            merge_warning_message(
                "Scheduled update",
                "Deposits will be briefly unavailable {schedule}.",
            ),
        ),
        ("action.vote", "requests_blocked", cant_process.clone()),
        ("action.create-proposal", "requests_blocked", cant_process),
        (
            "data.balances",
            "balance_unavailable",
            merge_warning_message(
                "We can't show your balances right now",
                "Your funds are on-chain and exactly where you left them. You can keep using your treasury.",
            ),
        ),
        (
            "data.activity",
            "history_not_loading",
            merge_warning_message(
                "Transaction history isn't loading right now",
                "This affects what you can see, not your funds or your treasury.",
            ),
        ),
        (
            "data.prices",
            "prices_delayed",
            merge_warning_message("Price data may be delayed.", ""),
        ),
        (
            "app",
            "tier1_backend",
            merge_warning_message(
                "We're having a temporary issue",
                "Some data may not load. Your funds are on-chain and unaffected — try again shortly.",
            ),
        ),
        (
            "app",
            "tier2_tx_paused",
            merge_warning_message(
                "Transactions are paused right now.",
                &format!(
                    "A network provider is recovering. Your funds are on-chain and in your control. Updates: {STATUS_PAGE_LINK}"
                ),
            ),
        ),
        (
            "app",
            "tier3_down",
            merge_warning_message(
                "Trezu is temporarily down.",
                &format!(
                    "Your funds are on-chain and in your control. Updates: {STATUS_PAGE_LINK}"
                ),
            ),
        ),
        (
            "app",
            "tier4_investigating",
            merge_warning_message(
                "We've paused Trezu while we investigate an issue.",
                &format!(
                    "We recommend not making any transactions until we confirm everything's clear. Updates: {STATUS_PAGE_LINK}"
                ),
            ),
        ),
    ]
}

/// Login slot message templates as (lookup key, message) tuples.
/// Keys are exact slot names or patterns (`login.wallet.*` matches any wallet slot).
/// Used by `login_messages()` at runtime and `template_data_json()` for the admin UI.
fn login_entries() -> Vec<(&'static str, String)> {
    vec![
        (
            "login",
            merge_warning_message(
                "Wallet sign-in is paused right now.",
                &format!("Your treasury and funds are safe on-chain. Updates: {STATUS_PAGE_LINK}"),
            ),
        ),
        (
            "login.wallet.*",
            "This wallet isn't working right now. It'll be back soon, or pick another.".into(),
        ),
    ]
}

/// Returns a JSON string with all constant template data for the admin UI.
/// Injected into the HTML page at serve time so the JS doesn't duplicate
/// these definitions.
pub fn template_data_json() -> String {
    let mut scenarios = serde_json::Map::new();
    for (slot, scenario, msg) in scenario_entries() {
        scenarios.insert(
            format!("{slot}::{scenario}"),
            serde_json::Value::String(msg),
        );
    }

    let mut login = serde_json::Map::new();
    for (key, msg) in login_entries() {
        login.insert(key.into(), serde_json::Value::String(msg));
    }

    let mut scenarios_by_slot = serde_json::Map::new();
    for (slot, scenario, _) in scenario_entries() {
        let entry = scenarios_by_slot
            .entry(slot.to_string())
            .or_insert_with(|| serde_json::Value::Array(vec![]));
        if let Some(arr) = entry.as_array_mut() {
            let already_listed = arr.iter().any(|item| {
                item.get("value")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v == scenario)
            });
            if !already_listed {
                arr.push(serde_json::json!({
                    "value": scenario,
                    "label": scenario_label(scenario),
                }));
            }
        }
    }

    let mut scenario_severity_map = serde_json::Map::new();
    for (_, scenario, _) in scenario_entries() {
        if let Some(severity) = scenario_severity(scenario) {
            scenario_severity_map.insert(
                scenario.to_string(),
                serde_json::Value::String(severity.to_string()),
            );
        }
    }

    let action_by_slot: serde_json::Map<String, serde_json::Value> = action_by_slot()
        .into_iter()
        .map(|(slot, action)| (slot, serde_json::Value::String(action)))
        .collect();

    let data = serde_json::json!({
        "statusPageLink": STATUS_PAGE_LINK,
        "scenarioMessages": scenarios,
        "loginMessages": login,
        "scenariosBySlot": scenarios_by_slot,
        "scenarioSeverity": scenario_severity_map,
        "actionBySlot": action_by_slot,
        "tokenNetwork": {
            "criticalPrimary": "{subject} is paused right now",
            "warningPrimary": "{subject} is slow right now",
            "criticalSecondaryToken": TOKEN_NETWORK_CRITICAL_SECONDARY_TOKEN,
            "criticalSecondaryNetwork": TOKEN_NETWORK_CRITICAL_SECONDARY_NETWORK,
            "warningBody": TOKEN_NETWORK_WARNING_BODY,
        },
    });

    serde_json::to_string(&data).unwrap()
}

/// Generate the user-facing message for a warning, when the inputs map to a
/// known template. Returns `None` when nothing can be auto-generated and the
/// admin should provide a free-form message.
pub fn generate_messages(
    severity: &str,
    slot: Option<&str>,
    token: Option<&str>,
    network: Option<&str>,
    scenario: Option<&str>,
) -> Option<String> {
    let token = normalize(token);
    let network = normalize(network);
    let scenario = normalize(scenario);

    // Token/network scope takes precedence -- it is fully templated.
    if token.is_some() || network.is_some() {
        return Some(token_network_messages(severity, token, network));
    }

    // Login slots are fully templated — no scenario needed.
    if let Some(slot) = normalize(slot)
        && let Some(msg) = login_messages(slot)
    {
        return Some(msg);
    }

    if let (Some(slot), Some(scenario)) = (normalize(slot), scenario) {
        return scenario_messages(slot, scenario);
    }

    None
}

fn normalize(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn subject(token: Option<&str>, network: Option<&str>) -> String {
    match (token, network) {
        (Some(token), Some(network)) => format!("{token} on {network}"),
        (Some(token), None) => token.to_string(),
        (None, Some(network)) => network.to_string(),
        (None, None) => "This option".to_string(),
    }
}

fn merge_warning_message(primary: &str, secondary: &str) -> String {
    let primary = primary.trim();
    let secondary = secondary.trim();
    if primary.is_empty() {
        return String::new();
    }
    if secondary.is_empty() {
        return primary.to_string();
    }
    format!("### {primary}\n{secondary}")
}

fn token_network_messages(severity: &str, token: Option<&str>, network: Option<&str>) -> String {
    let subject = subject(token, network);

    if severity == "critical" {
        let secondary = if token.is_some() {
            TOKEN_NETWORK_CRITICAL_SECONDARY_TOKEN
        } else {
            TOKEN_NETWORK_CRITICAL_SECONDARY_NETWORK
        };
        return merge_warning_message(&format!("{subject} is paused right now"), secondary);
    }

    // warning / info -- slow / degraded, does not block.
    merge_warning_message(
        &format!("{subject} is slow right now"),
        TOKEN_NETWORK_WARNING_BODY,
    )
}

/// Login slot messages. Lines starting with `### ` are rendered as headings.
fn login_messages(slot: &str) -> Option<String> {
    let key = if slot == "login" {
        "login"
    } else if slot.starts_with("login.wallet.") {
        "login.wallet.*"
    } else {
        return None;
    };

    login_entries()
        .into_iter()
        .find(|(k, _)| *k == key)
        .map(|(_, msg)| msg)
}

fn scenario_messages(slot: &str, scenario: &str) -> Option<String> {
    scenario_entries()
        .into_iter()
        .find(|(s, sc, _)| *s == slot && *sc == scenario)
        .map(|(_, _, msg)| msg)
}

/// Severity implied by a scenario (e.g. app Tier 1 = warning, Tiers 2-4 and
/// `requests_blocked` = critical). Returns `None` when the admin chooses severity.
pub fn scenario_severity(scenario: &str) -> Option<&'static str> {
    match scenario {
        "tier1_backend" => Some("warning"),
        "tier2_tx_paused"
        | "tier3_down"
        | "tier4_investigating"
        | "requests_blocked"
        | "scheduled_maintenance"
        | "swaps_paused"
        | "payments_paused"
        | "deposits_paused"
        | "cant_process" => Some("critical"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_network_critical_suggests_different_token() {
        let message = generate_messages(
            "critical",
            Some("deposit"),
            Some("ADA"),
            Some("Cardano"),
            None,
        )
        .expect("message");
        assert!(message.starts_with("### ADA on Cardano is paused right now\n"));
        assert!(message.contains("different token"));
    }

    #[test]
    fn network_only_critical_suggests_different_network() {
        let message = generate_messages("critical", Some("deposit"), None, Some("Cardano"), None)
            .expect("message");
        assert!(message.starts_with("### Cardano is paused right now\n"));
        assert!(message.contains("different network"));
    }

    #[test]
    fn warning_severity_contains_action_placeholder() {
        let message = generate_messages("warning", Some("payments"), Some("USDC"), None, None)
            .expect("message");
        assert!(message.starts_with("### USDC is slow right now\n"));
        assert!(message.contains("{action}"));
    }

    #[test]
    fn scenario_messages_resolve() {
        let message = generate_messages(
            "critical",
            Some("exchange"),
            None,
            None,
            Some("swaps_paused"),
        )
        .expect("message");
        assert!(message.starts_with("### Swaps are paused\n"));
        assert!(message.contains("Price quotes are recovering"));
    }

    #[test]
    fn cant_process_uses_heading_and_body() {
        let message = generate_messages(
            "critical",
            Some("payments"),
            None,
            None,
            Some("cant_process"),
        )
        .expect("message");
        assert!(message.starts_with("### Can't process new requests right now\n"));
    }

    #[test]
    fn single_line_scenario_stays_plain() {
        let message = generate_messages(
            "critical",
            Some("payments"),
            None,
            None,
            Some("payments_paused"),
        )
        .expect("message");
        assert_eq!(message, "Payments are paused right now.");
    }

    #[test]
    fn app_tier_severity_mapping() {
        assert_eq!(scenario_severity("tier1_backend"), Some("warning"));
        assert_eq!(scenario_severity("tier3_down"), Some("critical"));
        assert_eq!(scenario_severity("unknown"), None);
    }

    #[test]
    fn no_template_without_inputs() {
        assert!(generate_messages("warning", Some("app"), None, None, None).is_none());
    }
}

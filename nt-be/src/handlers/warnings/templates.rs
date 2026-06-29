//! Legal-approved messages from `shared/status-situations.json`.
//! Used at write time (admin save, Telegram fallback) — public API serves stored `user_message`.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

const CATALOG_JSON: &str = include_str!("../../../../shared/status-situations.json");

#[derive(Debug, Deserialize)]
struct Catalog {
    #[serde(rename = "statusPageLink")]
    status_page_link: String,
    situations: Vec<Situation>,
}

#[derive(Debug, Deserialize)]
struct Situation {
    id: String,
    #[serde(rename = "label")]
    _label: String,
    response: String,
    severity: String,
    #[serde(default, rename = "scope")]
    _scope: Option<String>,
    message: Option<String>,
    #[serde(default, rename = "byPlacement")]
    by_placement: Option<HashMap<String, String>>,
    #[serde(default, rename = "messagesByScope")]
    messages_by_scope: Option<HashMap<String, String>>,
}

static CATALOG: LazyLock<Catalog> =
    LazyLock::new(|| serde_json::from_str(CATALOG_JSON).expect("valid status-situations.json"));

fn situation(id: &str) -> Option<&Situation> {
    CATALOG.situations.iter().find(|s| s.id == id)
}

fn placement_template(situation: &Situation, slot: &str) -> Option<String> {
    let key = if slot.starts_with("login.wallet.") {
        "login.wallet.*"
    } else {
        slot
    };
    if let Some(by) = &situation.by_placement
        && let Some(msg) = by.get(key)
    {
        return Some(msg.clone());
    }
    situation.message.clone()
}

fn subject(token: Option<&str>, network: Option<&str>) -> String {
    match (token, network) {
        (Some(token), Some(network)) => {
            format!("{} on {}", token.to_uppercase(), network.to_uppercase())
        }
        (Some(token), None) => token.to_uppercase(),
        (None, Some(network)) => network.to_uppercase(),
        (None, None) => String::new(),
    }
}

fn action_for_slot(slot: &str) -> &'static str {
    match slot {
        "payments" => "payment",
        "deposit" => "deposit",
        "exchange" => "exchange",
        "action.approve" => "approve",
        "action.reject" => "reject",
        "action.remove" => "remove",
        "action.create-proposal" => "proposal",
        "data.balances" => "transaction",
        _ => "transaction",
    }
}

/// Values substituted into a catalog message template.
#[derive(Default)]
pub struct TemplateValues<'a> {
    pub slot: Option<&'a str>,
    pub token: Option<&'a str>,
    pub network: Option<&'a str>,
    pub wallet: Option<&'a str>,
    pub schedule: Option<&'a str>,
    pub request_type: Option<&'a str>,
    pub capability: Option<&'a str>,
}

/// Substitute placeholders in a catalog message template.
pub fn fill_message_template(template: &str, v: &TemplateValues<'_>) -> String {
    let subj = subject(v.token, v.network);
    let action = v.slot.map(action_for_slot).unwrap_or("transaction");
    template
        .replace("{statusPageLink}", &CATALOG.status_page_link)
        .replace("{subject}", &subj)
        .replace("{token}", &v.token.unwrap_or("").to_uppercase())
        .replace("{network}", &v.network.unwrap_or("").to_uppercase())
        .replace("{wallet}", v.wallet.unwrap_or(""))
        .replace("{action}", action)
        .replace("{schedule}", v.schedule.unwrap_or(""))
        .replace("{requestType}", v.request_type.unwrap_or(""))
        .replace("{capability}", v.capability.unwrap_or(""))
}

/// Full catalog JSON for the admin UI.
pub fn template_data_json() -> String {
    CATALOG_JSON.to_string()
}

/// Action words substituted for `{action}` per slot (public API).
pub fn action_by_slot() -> HashMap<String, String> {
    [
        ("payments", "payment"),
        ("deposit", "deposit"),
        ("exchange", "exchange"),
        ("action.approve", "approve"),
        ("action.reject", "reject"),
        ("action.remove", "remove"),
        ("action.create-proposal", "proposal"),
        ("data.balances", "transaction"),
    ]
    .into_iter()
    .map(|(slot, action)| (slot.to_string(), action.to_string()))
    .collect()
}

fn scope_template(
    situation: &Situation,
    token: Option<&str>,
    network: Option<&str>,
) -> Option<String> {
    let by_scope = situation.messages_by_scope.as_ref()?;
    let has_token = token.is_some();
    let has_network = network.is_some();
    if has_token && has_network {
        return by_scope.get("token+network").cloned();
    }
    if has_token {
        return by_scope.get("token").cloned();
    }
    if has_network {
        return by_scope.get("network").cloned();
    }
    None
}

/// Generate user-facing message when a known situation + placement is selected.
pub fn generate_messages(
    _response: &str,
    _severity: &str,
    slot: Option<&str>,
    token: Option<&str>,
    network: Option<&str>,
    situation_id: Option<&str>,
) -> Option<String> {
    let slot = normalize(slot)?;
    let situation_id = normalize(situation_id)?;
    let situation = situation(situation_id)?;
    let template = scope_template(situation, normalize(token), normalize(network))
        .or_else(|| placement_template(situation, slot))?;

    let wallet = slot
        .strip_prefix("login.wallet.")
        .map(|id| id.replace('-', " "));

    Some(fill_message_template(
        &template,
        &TemplateValues {
            slot: Some(slot),
            token: normalize(token),
            network: normalize(network),
            wallet: wallet.as_deref(),
            ..Default::default()
        },
    ))
}

fn normalize(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub fn situation_response(situation_id: &str) -> Option<&str> {
    situation(situation_id).map(|s| s.response.as_str())
}

pub fn situation_severity(situation_id: &str) -> Option<&str> {
    situation(situation_id).map(|s| s.severity.as_str())
}

pub fn parse_warning_copy(message: &str) -> (String, String) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    if let Some(idx) = lines.iter().position(|l| l.trim().starts_with("### ")) {
        let heading = lines[idx].trim().trim_start_matches("### ").to_string();
        let body = lines[(idx + 1)..].join("\n").trim().to_string();
        return (heading, body);
    }
    (trimmed.to_string(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_all_situations() {
        assert!(CATALOG.situations.len() >= 15);
    }

    #[test]
    fn network_paused_token_and_network_scope_copy() {
        let message = generate_messages(
            "paused",
            "high",
            Some("deposit"),
            Some("USDC"),
            Some("Ethereum"),
            Some("network_paused"),
        )
        .expect("message");
        assert!(message.contains("USDC on ETHEREUM is paused right now"));
        assert!(message.contains("Other tokens work as normal"));
    }

    #[test]
    fn network_paused_token_scope_copy() {
        let message = generate_messages(
            "paused",
            "high",
            Some("payments"),
            Some("USDC"),
            None,
            Some("network_paused"),
        )
        .expect("message");
        assert!(message.contains("### USDC is paused right now"));
    }

    #[test]
    fn network_slow_subject_composes_token_and_network() {
        let message = generate_messages(
            "notice",
            "low",
            Some("deposit"),
            Some("USDC"),
            Some("Ethereum"),
            Some("network_slow"),
        )
        .expect("message");
        assert!(message.contains("USDC on ETHEREUM is slow right now"));
    }

    #[test]
    fn features_paused_copy() {
        let message = generate_messages(
            "paused",
            "high",
            Some("exchange"),
            None,
            None,
            Some("features_paused"),
        )
        .expect("message");
        assert!(message.contains("Exchange is temporarily paused"));
    }

    #[test]
    fn provider_maintenance_by_placement() {
        let msg = generate_messages(
            "notice",
            "low",
            Some("exchange"),
            None,
            None,
            Some("provider_maintenance"),
        )
        .expect("message");
        assert!(msg.contains("Scheduled provider maintenance"), "{msg}");
        assert!(msg.contains("Swaps may be briefly unavailable"), "{msg}");
        assert!(msg.contains("Your funds are on-chain"), "{msg}");
    }

    #[test]
    fn situation_response_and_severity_from_catalog() {
        assert_eq!(situation_response("backend_down"), Some("notice"));
        assert_eq!(situation_response("features_paused"), Some("paused"));
        assert_eq!(situation_severity("funds_at_risk"), Some("critical"));
        assert_eq!(situation_severity("scheduled_maintenance"), Some("low"));
    }

    // Cross-language parity — these must match resolve-warning-message.test.ts.
    #[test]
    fn parity_scheduled_maintenance_payments_by_placement() {
        let msg = generate_messages(
            "notice",
            "low",
            Some("payments"),
            None,
            None,
            Some("scheduled_maintenance"),
        )
        .expect("message");
        assert!(msg.contains("Scheduled update"), "{msg}");
        assert!(
            msg.contains("Payments will be briefly unavailable"),
            "{msg}"
        );
    }

    #[test]
    fn parity_approvals_paused_vote_slot() {
        let msg = generate_messages(
            "paused",
            "high",
            Some("action.approve"),
            None,
            None,
            Some("approvals_paused"),
        )
        .expect("message");
        assert!(
            msg.contains("Approving requests is paused right now"),
            "{msg}"
        );
        assert!(msg.contains("reject pending requests"), "{msg}");
    }

    #[test]
    fn parity_backend_down_app_slot() {
        let msg = generate_messages(
            "notice",
            "high",
            Some("app"),
            None,
            None,
            Some("backend_down"),
        )
        .expect("message");
        assert!(msg.contains("We're having a temporary issue"), "{msg}");
        assert!(
            msg.contains("Your funds are on-chain and unaffected"),
            "{msg}"
        );
    }

    #[test]
    fn parity_network_paused_network_scope() {
        let msg = generate_messages(
            "paused",
            "high",
            Some("payments"),
            None,
            Some("sol"),
            Some("network_paused"),
        )
        .expect("message");
        assert!(msg.contains("### SOL is paused right now"), "{msg}");
        assert!(msg.contains("use a different network"), "{msg}");
    }
}

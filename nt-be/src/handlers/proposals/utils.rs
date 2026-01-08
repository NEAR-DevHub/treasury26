use super::types::{FunctionCallAction, Proposal, ProposalUIKind};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

pub fn decode_args(args: &str) -> Option<Value> {
    STANDARD
        .decode(args)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub fn parse_key_to_readable_format(key: &str) -> String {
    let mut result = String::new();
    let mut prev_char_is_lowercase = false;

    for (i, c) in key.chars().enumerate() {
        if c == '_' {
            result.push(' ');
            prev_char_is_lowercase = false;
        } else if c.is_uppercase() && prev_char_is_lowercase {
            result.push(' ');
            result.push(c);
            prev_char_is_lowercase = false;
        } else {
            if i == 0 || result.ends_with(' ') {
                result.push(c.to_ascii_uppercase());
            } else {
                result.push(c);
            }
            prev_char_is_lowercase = c.is_lowercase();
        }
    }
    result
}

pub fn decode_proposal_description(key: &str, description: &str) -> Option<String> {
    if let Ok(parsed_data) = serde_json::from_str::<Value>(description) {
        if let Some(val) = parsed_data.get(key) {
            return match val {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                Value::Bool(b) => Some(b.to_string()),
                _ => None,
            };
        }
    }

    let markdown_key = parse_key_to_readable_format(key);
    for line in description.split("<br>") {
        if let Some(rest) = line.trim().strip_prefix("* ") {
            if let Some((current_key, value)) = rest.split_once(':') {
                if current_key.trim().to_lowercase() == markdown_key.to_lowercase() {
                    return Some(value.trim().to_string());
                }
            }
        }
    }

    None
}

fn is_vesting_proposal(receiver_id: &str, actions: &[FunctionCallAction]) -> bool {
    let is_lockup = receiver_id.contains("lockup.near");
    let first_action = actions.first();
    is_lockup && first_action.map(|a| a.method_name.as_str()) == Some("create")
}

fn is_batch_payment_proposal(receiver_id: &str, actions: &[FunctionCallAction]) -> bool {
    if receiver_id != "bulkpayment.near" {
        return false;
    }
    actions.iter().any(|a| a.method_name == "approve_list")
}

fn process_ft_transfer_proposal(proposal: &Proposal, actions: &[FunctionCallAction]) -> Option<ProposalUIKind> {
    if is_intent_withdraw_proposal(actions, &proposal.kind) {
        return Some(ProposalUIKind::PaymentRequest);
    }

    let action = actions.iter().find(|a| a.method_name == "ft_transfer" || a.method_name == "ft_transfer_call");
    if let Some(action) = action {
        if action.method_name == "ft_transfer" {
            return Some(ProposalUIKind::PaymentRequest);
        }
        if let Some(args) = decode_args(&action.args) {
            if args.get("receiver_id").and_then(|v| v.as_str()) == Some("bulkpayment.near") {
                return Some(ProposalUIKind::BatchPaymentRequest);
            }
        }
        return Some(ProposalUIKind::PaymentRequest);
    }
    None
}

fn is_mt_transfer_proposal(actions: &[FunctionCallAction]) -> bool {
    actions.iter().any(|a| a.method_name == "mt_transfer" || a.method_name == "mt_transfer_call")
}

fn is_intent_withdraw_proposal(actions: &[FunctionCallAction], kind: &serde_json::Value) -> bool {
    if let Some(fc) = kind.get("FunctionCall") {
        let receiver_id = fc.get("receiver_id").and_then(|v| v.as_str()).unwrap_or("");
        return receiver_id == "intents.near" && actions.iter().any(|a| a.method_name == "ft_withdraw");
    }
    false
}

fn staking_type(receiver_id: &str, actions: &[FunctionCallAction], kind: &serde_json::Value) -> Option<ProposalUIKind> {
    if is_intent_withdraw_proposal(actions, kind) {
        return Some(ProposalUIKind::WithdrawEarnings);
    }

    let is_pool = receiver_id.ends_with("poolv1.near") || receiver_id.ends_with("lockup.near");
    if !is_pool {
        return None;
    }

    if actions.iter().any(|a| a.method_name == "stake" || a.method_name == "deposit_and_stake" || a.method_name == "deposit") {
        return Some(ProposalUIKind::EarnNear);
    }
    if actions.iter().any(|a| a.method_name == "withdraw" || a.method_name == "withdraw_all" || a.method_name == "withdraw_all_from_staking_pool") {
        return Some(ProposalUIKind::WithdrawEarnings);
    }
    if actions.iter().any(|a| a.method_name == "unstake") {
        return Some(ProposalUIKind::UnstakeNear);
    }
    None
}

pub fn get_proposal_ui_kind(proposal: &Proposal) -> ProposalUIKind {
    let kind_obj = match proposal.kind.as_object() {
        Some(obj) => obj,
        None => {
            if proposal.kind.as_str() == Some("Vote") {
                return ProposalUIKind::Vote;
            }
            return ProposalUIKind::Unsupported;
        }
    };

    if kind_obj.contains_key("Transfer") {
        return ProposalUIKind::PaymentRequest;
    }

    if let Some(fc) = kind_obj.get("FunctionCall") {
        let receiver_id = fc.get("receiver_id").and_then(|v| v.as_str()).unwrap_or("");
        let actions_val = fc.get("actions").and_then(|v| v.as_array());
        let mut actions = Vec::new();
        if let Some(arr) = actions_val {
            for v in arr {
                if let Ok(action) = serde_json::from_value::<FunctionCallAction>(v.clone()) {
                    actions.push(action);
                }
            }
        }

        if is_vesting_proposal(receiver_id, &actions) {
            return ProposalUIKind::Vesting;
        }
        if let Some(kind) = process_ft_transfer_proposal(proposal, &actions) {
            return kind;
        }
        if is_batch_payment_proposal(receiver_id, &actions) {
            return ProposalUIKind::BatchPaymentRequest;
        }
        if is_mt_transfer_proposal(&actions) {
            return ProposalUIKind::Exchange;
        }
        if let Some(kind) = staking_type(receiver_id, &actions, &proposal.kind) {
            return kind;
        }
        return ProposalUIKind::FunctionCall;
    }

    if kind_obj.contains_key("ChangePolicy")
        || kind_obj.contains_key("ChangePolicyUpdateParameters")
        || kind_obj.contains_key("ChangePolicyAddOrUpdateRole")
        || kind_obj.contains_key("ChangePolicyRemoveRole")
        || kind_obj.contains_key("ChangePolicyUpdateDefaultVotePolicy")
    {
        return ProposalUIKind::ChangePolicy;
    }

    if kind_obj.contains_key("ChangeConfig") {
        return ProposalUIKind::UpdateGeneralSettings;
    }

    if kind_obj.contains_key("UpgradeSelf") || kind_obj.contains_key("UpgradeRemote") {
        return ProposalUIKind::Upgrade;
    }

    if kind_obj.contains_key("AddMemberToRole") || kind_obj.contains_key("RemoveMemberFromRole") {
        return ProposalUIKind::Members;
    }

    if kind_obj.contains_key("SetStakingContract") {
        return ProposalUIKind::SetStakingContract;
    }

    if kind_obj.contains_key("AddBounty") || kind_obj.contains_key("BountyDone") {
        return ProposalUIKind::Bounty;
    }

    if kind_obj.contains_key("Vote") {
        return ProposalUIKind::Vote;
    }

    if kind_obj.contains_key("FactoryInfoUpdate") {
        return ProposalUIKind::FactoryInfoUpdate;
    }

    ProposalUIKind::Unsupported
}


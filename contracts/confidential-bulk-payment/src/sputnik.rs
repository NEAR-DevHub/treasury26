//! Mirror of the sputnik-dao `Proposal` shape, narrowed to the fields the
//! confidential-bulk-payment subaccount needs to consume from `get_proposal`.

use near_sdk::serde_json;
use near_sdk::{AccountId, ext_contract, near};

/// Typed proxy for sputnik-dao `get_proposal`.
#[ext_contract(ext_sputnik)]
pub trait SputnikDao {
    fn get_proposal(&self, id: u64) -> SputnikProposal;
}

#[derive(Debug)]
#[near(serializers = [json])]
pub struct SputnikProposal {
    pub kind: ProposalKind,
    pub description: String,
    pub status: String,
}

#[derive(Debug)]
#[near(serializers = [json])]
pub enum ProposalKind {
    FunctionCall(FCKind),
    #[serde(other)]
    Other,
}

#[derive(Debug)]
#[near(serializers = [json])]
pub struct FCKind {
    pub receiver_id: AccountId,
    pub actions: Vec<FCAction>,
}

#[derive(Debug)]
#[near(serializers = [json])]
pub struct FCAction {
    pub method_name: String,
    pub args: String,
}

impl SputnikProposal {
    /// Extract `key` from the proposal description.
    /// Mirrors `extract_from_description` in nt-be/src/handlers/proposals/scraper.rs:
    /// 1. Try parsing as JSON object.
    /// 2. Otherwise split on `<br>` / `\n`, look for `* key: value` markdown lines.
    pub fn description_field(&self, key: &str) -> Option<String> {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&self.description) {
            if let Some(obj) = v.as_object() {
                if let Some(val) = obj.get(key) {
                    return val.as_str().map(|s| s.to_string());
                }
            }
        }

        for raw_line in self.description.split("<br>").flat_map(|s| s.split('\n')) {
            let line = raw_line.trim();
            let line = line.strip_prefix('*').unwrap_or(line).trim();
            if let Some((k, v)) = line.split_once(':') {
                if normalize_key(k.trim()) == normalize_key(key) {
                    return Some(v.trim().to_string());
                }
            }
        }
        None
    }
}

fn normalize_key(k: &str) -> String {
    k.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

//! Token Discovery Service
//!
//! Functions to discover new tokens for monitored accounts by analyzing
//! transaction receipts, querying contract states, and checking FastNear balances.

use near_api::NetworkConfig;
use near_primitives::views::ReceiptView;
use serde::Deserialize;
use std::collections::HashSet;

/// Extract FT token contract addresses from a receipt
///
/// Scans the receipt for NEP-141 fungible token method calls:
/// - ft_transfer
/// - ft_transfer_call
/// - ft_on_transfer (callback)
///
/// Returns the receiver_id (token contract address) for any matching methods.
///
/// # Arguments
/// * `receipt` - The receipt to analyze
/// * `account_id` - The account we're monitoring (to check if involved in transfer)
///
/// # Returns
/// Set of token contract addresses found in the receipt
pub fn extract_ft_tokens_from_receipt(receipt: &ReceiptView, account_id: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();

    // Check if this receipt has actions
    if let near_primitives::views::ReceiptEnumView::Action { actions, .. } = &receipt.receipt {
        for action in actions {
            if let near_primitives::views::ActionView::FunctionCall { method_name, .. } = action {
                // Check for FT transfer methods
                if method_name == "ft_transfer"
                    || method_name == "ft_transfer_call"
                    || method_name == "ft_on_transfer"
                {
                    // The receiver_id is the token contract
                    // Only include if the monitored account is involved
                    if receipt.predecessor_id.as_str() == account_id
                        || receipt.receiver_id.as_str() == account_id
                    {
                        tokens.insert(receipt.receiver_id.to_string());
                    }
                }
            }
        }
    }

    tokens
}

/// Snapshot current NEAR Intents token holdings for an account
///
/// Queries the intents.near multi-token contract via mt_tokens_for_owner
/// to get a complete snapshot of all intents tokens currently held by the account.
///
/// This function returns the COMPLETE list of tokens at the current moment.
/// The list changes over time as tokens are added/removed. By calling this
/// periodically (via the monitoring cycle), we naturally track token changes.
///
/// # Returns
/// Complete list of token IDs in format: "intents.near:nep141:token.near"
/// where token.near is the underlying FT contract address.
///
/// The full format is preserved to allow extracting the FT contract address
/// when querying ft_metadata for decimals and other token information.
pub async fn snapshot_intents_tokens(
    network: &NetworkConfig,
    account_id: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    call_mt_tokens_for_owner(network, account_id).await
}

#[derive(Deserialize, Debug)]
struct FastNearToken {
    contract_id: String,
    balance: String,
}

#[derive(Deserialize, Debug)]
struct FastNearResponse {
    tokens: Option<Vec<FastNearToken>>,
}

/// Fetch all FT token contract IDs with positive balances from FastNear API
///
/// Queries `https://api.fastnear.com/v1/account/{account_id}/full` to get
/// a real-time view of all fungible tokens held by the account.
///
/// # Returns
/// List of FT contract IDs (e.g. "usdc.near", "wrap.near") that have positive balances.
pub async fn fetch_fastnear_ft_tokens(
    http_client: &reqwest::Client,
    fastnear_api_key: &str,
    account_id: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let response = http_client
        .get(format!(
            "https://api.fastnear.com/v1/account/{}/full",
            account_id
        ))
        .header("Authorization", format!("Bearer {}", fastnear_api_key))
        .send()
        .await?;

    let data: FastNearResponse = response.json().await?;

    let tokens = data
        .tokens
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t.balance.parse::<u128>().unwrap_or(0) > 0)
        .map(|t| t.contract_id)
        .collect();

    Ok(tokens)
}

/// Internal helper to call mt_tokens_for_owner on intents.near contract
async fn call_mt_tokens_for_owner(
    network: &NetworkConfig,
    account_id: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use near_api::{Contract, Reference};
    use serde::Deserialize;
    use std::str::FromStr;

    #[derive(Deserialize)]
    struct TokenEntry {
        token_id: String,
    }

    let contract_id = near_api::types::AccountId::from_str("intents.near")?;
    let contract = Contract(contract_id);

    let args = serde_json::json!({
        "account_id": account_id
    });

    // Get raw JSON response - returns array of {token_id: string} objects
    let response: near_api::Data<Vec<TokenEntry>> = contract
        .call_function("mt_tokens_for_owner", args)
        .read_only()
        .at(Reference::Final)
        .fetch_from(network)
        .await?;

    // Extract token_ids and prepend "intents.near:" to match our format
    let tokens: Vec<String> = response
        .data
        .into_iter()
        .map(|entry| format!("intents.near:{}", entry.token_id))
        .collect();

    Ok(tokens)
}

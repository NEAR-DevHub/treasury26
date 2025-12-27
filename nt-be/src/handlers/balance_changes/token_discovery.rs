//! Token Discovery Service
//!
//! Functions to discover new tokens for monitored accounts by analyzing
//! transaction receipts and querying contract states.

use near_primitives::views::ReceiptView;
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
pub fn extract_ft_tokens_from_receipt(
    receipt: &ReceiptView,
    account_id: &str,
) -> HashSet<String> {
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

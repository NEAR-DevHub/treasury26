//! Bare account strings for NEAR Intents / 1Click confidential flows.
//!
//! Bronze, gold, and `quote_metadata` store addresses without `chain:` prefixes
//! (`bob.near`, `0xabc…`, `intents.near`).

use std::fmt;

fn looks_like_near_account(value: &str) -> bool {
    value.ends_with(".near") || value.ends_with(".testnet") || value.ends_with(".tg")
}

/// Strip a leading `chain:` prefix if present; otherwise return the input unchanged.
pub fn bare_account(value: &str) -> String {
    match value.split_once(':') {
        Some((chain, account)) if !chain.is_empty() && !account.is_empty() => account.to_string(),
        _ => value.to_string(),
    }
}

/// Compare two account strings after normalizing to bare form.
pub fn accounts_equal(a: &str, b: &str) -> bool {
    bare_account(a) == bare_account(b)
}

/// True when `value` is a NEAR account id and matches `account` after normalization.
pub fn is_near_account(value: &str, account: &str) -> bool {
    let bare = bare_account(value);
    looks_like_near_account(&bare) && bare == bare_account(account)
}

/// Bare NEAR account id if `value` normalizes to a NEAR-shaped account.
pub fn as_near_account(value: &str) -> Option<String> {
    let bare = bare_account(value);
    looks_like_near_account(&bare).then_some(bare)
}

/// Error returned when a normalized account string is empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseAccountIdError(String);

impl fmt::Display for ParseAccountIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid account id '{}'", self.0)
    }
}

impl std::error::Error for ParseAccountIdError {}

/// Parse and normalize to bare storage form.
pub fn parse_bare_account(s: &str) -> Result<String, ParseAccountIdError> {
    let bare = bare_account(s);
    if bare.is_empty() {
        return Err(ParseAccountIdError(s.to_string()));
    }
    Ok(bare)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_account_strips_chain_prefix() {
        assert_eq!(bare_account("near:bob.near"), "bob.near");
        assert_eq!(bare_account("arb:0xabc"), "0xabc");
        assert_eq!(bare_account("bob.near"), "bob.near");
    }

    #[test]
    fn accounts_equal_normalizes_prefixes() {
        assert!(accounts_equal("bob.near", "near:bob.near"));
        assert!(accounts_equal("0xabc", "arb:0xabc"));
    }

    #[test]
    fn is_near_account_matches_bare_and_prefixed() {
        assert!(is_near_account("bob.near", "bob.near"));
        assert!(is_near_account("near:bob.near", "bob.near"));
        assert!(!is_near_account("0xabc", "0xabc"));
        assert!(!is_near_account("bob.near", "alice.near"));
    }

    #[test]
    fn as_near_account_accepts_bare_and_prefixed() {
        assert_eq!(as_near_account("bob.near").as_deref(), Some("bob.near"));
        assert_eq!(
            as_near_account("near:bob.near").as_deref(),
            Some("bob.near")
        );
        assert_eq!(as_near_account("eth:0xabc"), None);
    }

    #[test]
    fn parse_bare_account_is_idempotent() {
        assert_eq!(parse_bare_account("bob.near").unwrap(), "bob.near");
        assert_eq!(parse_bare_account("near:bob.near").unwrap(), "bob.near");
    }
}

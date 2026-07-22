//! Neutral application seam for authoritative public balance reads.
//!
//! The underlying readers predate the public snapshot projection. Keeping the
//! routing here lets the new projection depend on balance-reading behavior,
//! rather than on any legacy persistence model.

use bigdecimal::BigDecimal;
use near_api::NetworkConfig;
use sqlx::PgPool;

pub use crate::handlers::balance_changes::history::{
    BalanceSnapshot, ChartMeta, ChartResponse, ChartStatus, Interval,
};
pub use crate::handlers::balance_changes::utils::with_transport_retry;

fn is_proven_nonexistence(message: &str) -> bool {
    message.contains("UnknownAccount")
        || message.contains("UNKNOWN_ACCOUNT")
        || message.contains("does not exist while viewing")
        || message.contains("Contract account does not exist")
}

fn is_definitive_non_staking_contract(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("methodresolveerror(methodnotfound)")
        || lower.contains("methodnotfound")
        || lower.contains("method not found")
        || lower.contains("codedoesnotexist")
        || lower.contains("contract code does not exist")
        || lower.contains("contract account does not exist")
        || lower.contains("unknownaccount")
}

/// Validate that a candidate implements the staking-pool balance interface at
/// an exact block. A missing contract/method is a definitive non-pool; RPC,
/// transport and response-decoding failures remain errors so discovery cannot
/// silently publish an incomplete inventory.
pub async fn validate_staking_pool_at_block(
    network: &NetworkConfig,
    account_id: &str,
    pool_id: &str,
    block_height: u64,
) -> Result<bool, String> {
    match crate::handlers::balance_changes::balance::staking::get_staking_balance_at_exact_block(
        network,
        account_id,
        pool_id,
        block_height,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) if is_definitive_non_staking_contract(&error.to_string()) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub async fn get_public_balance_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    asset: &str,
    block_height: u64,
) -> Result<BigDecimal, String> {
    if let Some(staking_pool) = asset.strip_prefix("staking:") {
        let result =
            crate::handlers::balance_changes::balance::staking::get_staking_balance_at_exact_block(
                network,
                account_id,
                staking_pool,
                block_height,
            )
            .await;
        return match result {
            Ok(balance) => Ok(balance),
            Err(error) if is_proven_nonexistence(&error.to_string()) => Ok(BigDecimal::from(0)),
            Err(error) => Err(error.to_string()),
        };
    }

    let result = crate::handlers::balance_changes::balance::get_balance_at_block(
        pool,
        network,
        account_id,
        asset,
        block_height,
    )
    .await;
    match result {
        Ok(balance) => Ok(balance),
        Err(error) if is_proven_nonexistence(&error.to_string()) => Ok(BigDecimal::from(0)),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::is_definitive_non_staking_contract;

    #[test]
    fn staking_validation_only_suppresses_definitive_non_pool_errors() {
        assert!(is_definitive_non_staking_contract(
            "MethodResolveError(MethodNotFound)"
        ));
        assert!(is_definitive_non_staking_contract(
            "Contract account does not exist"
        ));
        assert!(!is_definitive_non_staking_contract("429 Too Many Requests"));
        assert!(!is_definitive_non_staking_contract(
            "failed to parse return value as U128"
        ));
        assert!(!is_definitive_non_staking_contract(
            "transport connection reset"
        ));
    }
}

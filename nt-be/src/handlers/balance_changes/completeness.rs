//! Balance History Completeness Check
//!
//! Computes real-time completeness information for balance history per token.
//! Uses existing `find_gaps()` for interior gap detection and checks backward
//! completeness based on token type.

use bigdecimal::BigDecimal;
use near_api::{AccountId, Contract, NetworkConfig, Reference};
use serde::Serialize;
use sqlx::PgPool;
use sqlx::types::chrono::{DateTime, Utc};
use std::str::FromStr;

use super::gap_detector;
use super::utils::with_transport_retry;

/// Completeness information for a single token
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCompleteness {
    pub token_id: String,
    pub has_gaps: bool,
    pub gap_count: usize,
    pub reaches_beginning: bool,
}

/// Full completeness response for an account
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessResponse {
    pub account_id: String,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub tokens: Vec<TokenCompleteness>,
}

/// Earliest record info for a token
struct EarliestRecord {
    balance_before: BigDecimal,
    block_height: i64,
    counterparty: String,
}

/// Check completeness for all tokens of an account
pub async fn check_completeness(
    pool: &PgPool,
    archival_network: &NetworkConfig,
    account_id: &str,
    up_to_block: i64,
) -> Result<CompletenessResponse, Box<dyn std::error::Error + Send + Sync>> {
    // Get last_synced_at from monitored_accounts
    let last_synced_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT last_synced_at FROM monitored_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?
    .flatten();

    // Get all distinct tokens for this account
    let token_ids: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
        ORDER BY token_id
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    let mut tokens = Vec::new();

    for token_id in token_ids {
        // 1. Check interior gaps using existing find_gaps
        let gaps = gap_detector::find_gaps(pool, account_id, &token_id, up_to_block).await?;
        let gap_count = gaps.len();
        let has_gaps = gap_count > 0;

        // 2. Check backward completeness
        let reaches_beginning =
            check_reaches_beginning(pool, archival_network, account_id, &token_id).await?;

        tokens.push(TokenCompleteness {
            token_id,
            has_gaps,
            gap_count,
            reaches_beginning,
        });
    }

    Ok(CompletenessResponse {
        account_id: account_id.to_string(),
        last_synced_at,
        tokens,
    })
}

/// Check if we have reached the beginning of a token's history
///
/// The logic depends on token type:
/// - NEAR: earliest balance_before == 0 means we've reached account creation
/// - FT (NEP-141): earliest balance_before == 0, then check storage_balance_of
///   at a block before the earliest record to confirm no earlier history
/// - Intents (NEP-245): earliest balance_before == 0 and not a SNAPSHOT means
///   we've found the beginning
async fn check_reaches_beginning(
    pool: &PgPool,
    archival_network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    // Get the earliest record for this token (excluding STAKING_SNAPSHOT)
    let earliest = sqlx::query_as!(
        EarliestRecord,
        r#"
        SELECT balance_before, block_height, counterparty as "counterparty!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
          AND counterparty != 'STAKING_SNAPSHOT'
        ORDER BY block_height ASC
        LIMIT 1
        "#,
        account_id,
        token_id
    )
    .fetch_optional(pool)
    .await?;

    let earliest = match earliest {
        Some(r) => r,
        None => return Ok(true), // No records = nothing to check
    };

    let zero = BigDecimal::from(0);

    if token_id == "near" || token_id == "NEAR" {
        // NEAR: Named accounts are created with a nonzero balance for storage.
        // If earliest balance_before == 0, we've reached account creation.
        Ok(earliest.balance_before == zero)
    } else if token_id.contains(':') {
        // Intents tokens (format: "intents.near:nep141:token.near")
        // If earliest balance_before == 0 and it's not a SNAPSHOT, we've found the beginning.
        // A SNAPSHOT with balance_before > 0 means the backward walk is still in progress.
        if earliest.balance_before == zero && earliest.counterparty != "SNAPSHOT" {
            Ok(true)
        } else {
            Ok(false)
        }
    } else {
        // FT tokens (NEP-141)
        // If earliest balance_before > 0, we definitely haven't reached the beginning.
        if earliest.balance_before != zero {
            return Ok(false);
        }

        // balance_before == 0, but this isn't conclusive for FT tokens because
        // an account could sell all tokens (balance -> 0) then receive more.
        // Check if the account was registered with the FT contract at a block
        // before the earliest record.
        check_ft_not_registered_before(
            archival_network,
            account_id,
            token_id,
            earliest.block_height,
        )
        .await
    }
}

/// Check backward completeness for NEAR and intents tokens (no RPC needed).
/// Extracted for testability - only FT tokens require RPC calls.
#[cfg(test)]
async fn check_reaches_beginning_db_only(
    pool: &PgPool,
    account_id: &str,
    token_id: &str,
) -> Result<Option<bool>, Box<dyn std::error::Error + Send + Sync>> {
    let earliest = sqlx::query_as!(
        EarliestRecord,
        r#"
        SELECT balance_before, block_height, counterparty as "counterparty!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
          AND counterparty != 'STAKING_SNAPSHOT'
        ORDER BY block_height ASC
        LIMIT 1
        "#,
        account_id,
        token_id
    )
    .fetch_optional(pool)
    .await?;

    let earliest = match earliest {
        Some(r) => r,
        None => return Ok(Some(true)),
    };

    let zero = BigDecimal::from(0);

    if token_id == "near" || token_id == "NEAR" {
        Ok(Some(earliest.balance_before == zero))
    } else if token_id.contains(':') {
        Ok(Some(
            earliest.balance_before == zero && earliest.counterparty != "SNAPSHOT",
        ))
    } else {
        // FT tokens: can determine false if balance_before > 0,
        // but need RPC for the balance_before == 0 case
        if earliest.balance_before != zero {
            Ok(Some(false))
        } else {
            Ok(None) // Needs RPC check
        }
    }
}

/// Check if an account was NOT registered with an FT contract before a given block.
///
/// Calls storage_balance_of at a block before the earliest record. If the account
/// wasn't registered, there's no earlier history and we've reached the beginning.
async fn check_ft_not_registered_before(
    archival_network: &NetworkConfig,
    account_id: &str,
    token_contract: &str,
    earliest_block: i64,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    // Check at the block just before the earliest record
    let check_block = if earliest_block > 1 {
        (earliest_block - 1) as u64
    } else {
        return Ok(true); // Block 0 or 1 = definitely the beginning
    };

    let contract_id = AccountId::from_str(token_contract)?;

    // Call storage_balance_of at the archival block
    let result: Result<near_api::Data<Option<serde_json::Value>>, _> =
        with_transport_retry("ft_storage_balance_of", || {
            Contract(contract_id.clone())
                .call_function(
                    "storage_balance_of",
                    serde_json::json!({
                        "account_id": account_id
                    }),
                )
                .read_only()
                .at(Reference::AtBlock(check_block))
                .fetch_from(archival_network)
        })
        .await;

    match result {
        Ok(data) => {
            // If storage_balance_of returns null/None, account was not registered
            Ok(data.data.is_none())
        }
        Err(e) => {
            let err_str = e.to_string();
            // If the contract didn't exist at that block or the method doesn't exist,
            // the account wasn't registered
            if err_str.contains("UnknownAccount")
                || err_str.contains("MethodNotFound")
                || err_str.contains("CodeDoesNotExist")
            {
                Ok(true)
            } else {
                log::warn!(
                    "Failed to check FT storage_balance_of for {} on {} at block {}: {}",
                    account_id,
                    token_contract,
                    check_block,
                    err_str
                );
                // On error, conservatively report as not reaching beginning
                Ok(false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::utils::block_timestamp_to_datetime;
    use super::*;
    use sqlx::PgPool;
    use sqlx::types::BigDecimal;
    use std::str::FromStr;

    /// Helper to insert a balance change record for testing
    async fn insert_balance_change(
        pool: &PgPool,
        account_id: &str,
        token_id: &str,
        block_height: i64,
        balance_before: &str,
        balance_after: &str,
        counterparty: &str,
    ) {
        let before_bd = BigDecimal::from_str(balance_before).unwrap();
        let after_bd = BigDecimal::from_str(balance_after).unwrap();
        let amount = &before_bd - &after_bd;
        let block_timestamp = block_height * 1_000_000_000;
        let block_time = block_timestamp_to_datetime(block_timestamp);

        sqlx::query!(
            r#"
            INSERT INTO balance_changes
            (account_id, token_id, block_height, block_timestamp, block_time,
             amount, balance_before, balance_after, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
            account_id,
            token_id,
            block_height,
            block_timestamp,
            block_time,
            amount,
            before_bd,
            after_bd,
            Some(counterparty),
            serde_json::json!({}),
            serde_json::json!({})
        )
        .execute(pool)
        .await
        .expect("Failed to insert balance change");
    }

    #[sqlx::test]
    async fn test_near_reaches_beginning_when_balance_before_zero(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        // NEAR: earliest balance_before = 0 means we've reached account creation
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            100,
            "0",
            "5000000",
            "sender.near",
        )
        .await;
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            200,
            "5000000",
            "4000000",
            "recipient.near",
        )
        .await;

        let result = check_reaches_beginning_db_only(&pool, "test.near", "near")
            .await
            .unwrap();
        assert_eq!(
            result,
            Some(true),
            "NEAR with balance_before=0 should reach beginning"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_near_does_not_reach_beginning_when_balance_before_nonzero(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        // NEAR: earliest balance_before > 0 means we haven't reached account creation
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            100,
            "1000000",
            "900000",
            "recipient.near",
        )
        .await;

        let result = check_reaches_beginning_db_only(&pool, "test.near", "near")
            .await
            .unwrap();
        assert_eq!(
            result,
            Some(false),
            "NEAR with balance_before>0 should not reach beginning"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_intents_reaches_beginning_when_balance_before_zero(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        // Intents: balance_before = 0 and not a SNAPSHOT => reaches beginning
        insert_balance_change(
            &pool,
            "test.near",
            "intents.near:nep141:usdc.near",
            100,
            "0",
            "1000000",
            "sender.near",
        )
        .await;

        let result =
            check_reaches_beginning_db_only(&pool, "test.near", "intents.near:nep141:usdc.near")
                .await
                .unwrap();
        assert_eq!(
            result,
            Some(true),
            "Intents with balance_before=0 and non-SNAPSHOT should reach beginning"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_intents_does_not_reach_beginning_with_snapshot(pool: PgPool) -> sqlx::Result<()> {
        // Intents: SNAPSHOT with balance_before > 0 means backward walk still in progress
        insert_balance_change(
            &pool,
            "test.near",
            "intents.near:nep141:usdc.near",
            100,
            "5000",
            "5000",
            "SNAPSHOT",
        )
        .await;
        insert_balance_change(
            &pool,
            "test.near",
            "intents.near:nep141:usdc.near",
            200,
            "5000",
            "4000",
            "recipient.near",
        )
        .await;

        let result =
            check_reaches_beginning_db_only(&pool, "test.near", "intents.near:nep141:usdc.near")
                .await
                .unwrap();
        assert_eq!(
            result,
            Some(false),
            "Intents SNAPSHOT with balance_before>0 should not reach beginning"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_ft_does_not_reach_beginning_when_balance_before_nonzero(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        // FT: balance_before > 0 definitively means not at the beginning
        insert_balance_change(
            &pool,
            "test.near",
            "usdt.tether-token.near",
            100,
            "500000",
            "400000",
            "recipient.near",
        )
        .await;

        let result = check_reaches_beginning_db_only(&pool, "test.near", "usdt.tether-token.near")
            .await
            .unwrap();
        assert_eq!(
            result,
            Some(false),
            "FT with balance_before>0 should not reach beginning"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_ft_needs_rpc_when_balance_before_zero(pool: PgPool) -> sqlx::Result<()> {
        // FT: balance_before = 0 is inconclusive without RPC check
        insert_balance_change(
            &pool,
            "test.near",
            "usdt.tether-token.near",
            100,
            "0",
            "1000000",
            "sender.near",
        )
        .await;

        let result = check_reaches_beginning_db_only(&pool, "test.near", "usdt.tether-token.near")
            .await
            .unwrap();
        assert_eq!(
            result, None,
            "FT with balance_before=0 should need RPC check"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_no_records_reaches_beginning(pool: PgPool) -> sqlx::Result<()> {
        // No records for a token => reaches beginning (nothing to check)
        let result = check_reaches_beginning_db_only(&pool, "test.near", "near")
            .await
            .unwrap();
        assert_eq!(result, Some(true), "No records should reach beginning");
        Ok(())
    }

    #[sqlx::test]
    async fn test_gap_count_with_gaps(pool: PgPool) -> sqlx::Result<()> {
        // Insert records with gaps for gap counting
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            100,
            "1000",
            "900",
            "recipient.near",
        )
        .await;
        // Gap: balance_before (700) != previous balance_after (900)
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            200,
            "700",
            "600",
            "recipient.near",
        )
        .await;
        // Continuous
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            300,
            "600",
            "500",
            "recipient.near",
        )
        .await;
        // Gap: balance_before (400) != previous balance_after (500)
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            400,
            "400",
            "300",
            "recipient.near",
        )
        .await;

        let gaps = gap_detector::find_gaps(&pool, "test.near", "near", 400).await?;
        assert_eq!(gaps.len(), 2, "Should detect two gaps");
        Ok(())
    }

    #[sqlx::test]
    async fn test_staking_snapshot_ignored_in_earliest_record(pool: PgPool) -> sqlx::Result<()> {
        // STAKING_SNAPSHOT should be excluded from earliest record check
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            50,
            "999",
            "999",
            "STAKING_SNAPSHOT",
        )
        .await;
        // The real earliest non-staking record has balance_before = 0
        insert_balance_change(
            &pool,
            "test.near",
            "near",
            100,
            "0",
            "5000000",
            "sender.near",
        )
        .await;

        let result = check_reaches_beginning_db_only(&pool, "test.near", "near")
            .await
            .unwrap();
        assert_eq!(
            result,
            Some(true),
            "Should ignore STAKING_SNAPSHOT and find balance_before=0"
        );
        Ok(())
    }
}

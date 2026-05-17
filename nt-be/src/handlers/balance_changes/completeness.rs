//! Balance History Completeness Check
//!
//! Checks whether balance history is complete within a given time range.
//! Uses `find_gaps_in_time_range()` to detect interior gaps per token
//! and returns the gap list so callers can assess export completeness.

use near_account_id::{AccountId, AccountIdRef};
use serde::Serialize;
use sqlx::PgPool;
use sqlx::types::chrono::{DateTime, Utc};

use super::gap_detector::{self, TimeRangeGap};

/// Completeness information for a single token
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCompleteness {
    pub token_id: String,
    pub has_gaps: bool,
    pub gap_count: usize,
    pub gaps: Vec<TimeRangeGap>,
}

/// Full completeness response for an account
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessResponse {
    pub account_id: AccountId,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub tokens: Vec<TokenCompleteness>,
}

/// Check completeness for all tokens of an account within a time range
pub async fn check_completeness(
    pool: &PgPool,
    account_id: &AccountIdRef,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<CompletenessResponse, Box<dyn std::error::Error + Send + Sync>> {
    // Get all distinct tokens for this account within the time range
    let token_ids: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
          AND block_time >= $2 AND block_time <= $3
        ORDER BY token_id
        "#,
    )
    .bind(account_id.as_str())
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await?;

    let mut tokens = Vec::new();

    for token_id in token_ids {
        let gaps =
            gap_detector::find_gaps_in_time_range(pool, account_id.as_str(), &token_id, from, to)
                .await?;
        let gap_count = gaps.len();
        let has_gaps = gap_count > 0;

        tokens.push(TokenCompleteness {
            token_id,
            has_gaps,
            gap_count,
            gaps,
        });
    }

    Ok(CompletenessResponse {
        account_id: account_id.to_owned(),
        from,
        to,
        tokens,
    })
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
    async fn test_gap_count_with_gaps(pool: PgPool) -> sqlx::Result<()> {
        // Insert records with gaps for gap counting
        insert_balance_change(&pool, "test.near", "near", 100, "1000", "900", "r.near").await;
        // Gap: balance_before (700) != previous balance_after (900)
        insert_balance_change(&pool, "test.near", "near", 200, "700", "600", "r.near").await;
        // Continuous
        insert_balance_change(&pool, "test.near", "near", 300, "600", "500", "r.near").await;
        // Gap: balance_before (400) != previous balance_after (500)
        insert_balance_change(&pool, "test.near", "near", 400, "400", "300", "r.near").await;

        let from = block_timestamp_to_datetime(0);
        let to = block_timestamp_to_datetime(500 * 1_000_000_000);

        let response = check_completeness(&pool, "test.near".try_into().unwrap(), from, to)
            .await
            .unwrap();

        assert_eq!(response.tokens.len(), 1);
        let token = &response.tokens[0];
        assert_eq!(token.token_id, "near");
        assert!(token.has_gaps);
        assert_eq!(token.gap_count, 2, "Should detect two gaps");
        assert_eq!(token.gaps.len(), 2);

        // Verify gap details
        assert_eq!(token.gaps[0].start_block, 100);
        assert_eq!(token.gaps[0].end_block, 200);
        assert_eq!(token.gaps[1].start_block, 300);
        assert_eq!(token.gaps[1].end_block, 400);

        Ok(())
    }

    #[sqlx::test]
    async fn test_no_gaps_in_continuous_chain(pool: PgPool) -> sqlx::Result<()> {
        insert_balance_change(&pool, "test.near", "near", 100, "1000", "900", "r.near").await;
        insert_balance_change(&pool, "test.near", "near", 200, "900", "800", "r.near").await;
        insert_balance_change(&pool, "test.near", "near", 300, "800", "700", "r.near").await;

        let from = block_timestamp_to_datetime(0);
        let to = block_timestamp_to_datetime(400 * 1_000_000_000);

        let response = check_completeness(&pool, "test.near".try_into().unwrap(), from, to)
            .await
            .unwrap();

        assert_eq!(response.tokens.len(), 1);
        assert!(!response.tokens[0].has_gaps);
        assert_eq!(response.tokens[0].gap_count, 0);
        assert!(response.tokens[0].gaps.is_empty());
        Ok(())
    }

    #[sqlx::test]
    async fn test_time_range_filters_gaps(pool: PgPool) -> sqlx::Result<()> {
        // Gap at block 100→200, but we query a time range that only includes block 300→400
        insert_balance_change(&pool, "test.near", "near", 100, "1000", "900", "r.near").await;
        insert_balance_change(&pool, "test.near", "near", 200, "700", "600", "r.near").await;
        insert_balance_change(&pool, "test.near", "near", 300, "600", "500", "r.near").await;
        insert_balance_change(&pool, "test.near", "near", 400, "500", "400", "r.near").await;

        // Time range covering only blocks 300-400 (no gap in that range)
        let from = block_timestamp_to_datetime(250 * 1_000_000_000);
        let to = block_timestamp_to_datetime(450 * 1_000_000_000);

        let response = check_completeness(&pool, "test.near".try_into().unwrap(), from, to)
            .await
            .unwrap();

        assert_eq!(response.tokens.len(), 1);
        assert!(
            !response.tokens[0].has_gaps,
            "Should have no gaps in the queried time range"
        );
        Ok(())
    }

    #[sqlx::test]
    async fn test_multiple_tokens(pool: PgPool) -> sqlx::Result<()> {
        // NEAR: continuous
        insert_balance_change(&pool, "test.near", "near", 100, "1000", "900", "r.near").await;
        insert_balance_change(&pool, "test.near", "near", 200, "900", "800", "r.near").await;

        // USDT: has a gap
        insert_balance_change(
            &pool,
            "test.near",
            "usdt.tether-token.near",
            100,
            "500",
            "400",
            "r.near",
        )
        .await;
        insert_balance_change(
            &pool,
            "test.near",
            "usdt.tether-token.near",
            200,
            "300",
            "200",
            "r.near",
        )
        .await;

        let from = block_timestamp_to_datetime(0);
        let to = block_timestamp_to_datetime(300 * 1_000_000_000);

        let response = check_completeness(&pool, "test.near".try_into().unwrap(), from, to)
            .await
            .unwrap();

        assert_eq!(response.tokens.len(), 2);

        let near_token = response
            .tokens
            .iter()
            .find(|t| t.token_id == "near")
            .unwrap();
        assert!(!near_token.has_gaps);

        let usdt_token = response
            .tokens
            .iter()
            .find(|t| t.token_id == "usdt.tether-token.near")
            .unwrap();
        assert!(usdt_token.has_gaps);
        assert_eq!(usdt_token.gap_count, 1);
        Ok(())
    }

    #[sqlx::test]
    async fn test_empty_time_range(pool: PgPool) -> sqlx::Result<()> {
        insert_balance_change(&pool, "test.near", "near", 100, "1000", "900", "r.near").await;

        // Time range with no records
        let from = block_timestamp_to_datetime(500 * 1_000_000_000);
        let to = block_timestamp_to_datetime(600 * 1_000_000_000);

        let response = check_completeness(&pool, "test.near".try_into().unwrap(), from, to)
            .await
            .unwrap();

        assert!(
            response.tokens.is_empty(),
            "No tokens should appear for empty time range"
        );
        Ok(())
    }
}

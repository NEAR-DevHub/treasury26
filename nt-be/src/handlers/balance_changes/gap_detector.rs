//! Gap Detection Service
//!
//! This module implements balance chain gap detection using PostgreSQL window functions.
//! A "gap" occurs when the balance_after of one record doesn't match the balance_before
//! of the next record for the same account and token.

use sqlx::PgPool;

#[cfg(test)]
use super::utils::block_timestamp_to_datetime;

/// Represents a gap in the balance change chain
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BalanceGap {
    pub account_id: String,
    pub token_id: String,
    pub start_block: i64,
    pub end_block: i64,
    pub actual_balance_after: String,
    pub expected_balance_before: String,
}

/// Find gaps in the balance change chain for a specific account and token.
///
/// Uses PostgreSQL LAG window function to efficiently compare consecutive records.
/// A gap is detected when balance_before[i] != balance_after[i-1].
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - Account to check
/// * `token_id` - Token to check (e.g., "near", "wrap.near")
/// * `up_to_block` - Only check records up to this block height (inclusive)
///
/// # Returns
/// Vector of gaps found, ordered by block height. Empty if chain is continuous.
pub async fn find_gaps(
    pool: &PgPool,
    account_id: &str,
    token_id: &str,
    up_to_block: i64,
) -> Result<Vec<BalanceGap>, sqlx::Error> {
    let gaps = sqlx::query_as::<_, BalanceGap>(
        r#"
        WITH balance_chain AS (
            SELECT 
                account_id,
                token_id,
                block_height,
                balance_before,
                balance_after,
                LAG(block_height) OVER w as prev_block_height,
                LAG(balance_after) OVER w as prev_balance_after
            FROM balance_changes
            WHERE account_id = $1 
              AND token_id = $2
              AND block_height <= $3
            WINDOW w AS (PARTITION BY account_id, token_id ORDER BY block_height)
        )
        SELECT 
            account_id,
            token_id,
            prev_block_height as start_block,
            block_height as end_block,
            prev_balance_after::TEXT as actual_balance_after,
            balance_before::TEXT as expected_balance_before
        FROM balance_chain
        WHERE prev_block_height IS NOT NULL 
          AND balance_before != prev_balance_after
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(token_id)
    .bind(up_to_block)
    .fetch_all(pool)
    .await?;

    Ok(gaps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::types::BigDecimal;
    use std::str::FromStr;

    #[sqlx::test]
    async fn test_find_gaps_with_gap(pool: PgPool) -> sqlx::Result<()> {
        // Insert records with a gap
        let block_time1 = block_timestamp_to_datetime(1000000000i64);
        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
            "test.near",
            "NEAR",
            100i64,
            1000000000i64,
            block_time1,
            BigDecimal::from_str("100").unwrap(),
            BigDecimal::from_str("1000").unwrap(),
            BigDecimal::from_str("900").unwrap(),
            Some("recipient.near"),
            serde_json::json!({}),
            serde_json::json!({})
        )
        .execute(&pool)
        .await?;

        // Gap: balance_before (700) != previous balance_after (900)
        let block_time2 = block_timestamp_to_datetime(2000000000i64);
        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
            "test.near",
            "NEAR",
            200i64,
            2000000000i64,
            block_time2,
            BigDecimal::from_str("100").unwrap(),
            BigDecimal::from_str("700").unwrap(),
            BigDecimal::from_str("600").unwrap(),
            Some("recipient.near"),
            serde_json::json!({}),
            serde_json::json!({})
        )
        .execute(&pool)
        .await?;

        let gaps = find_gaps(&pool, "test.near", "NEAR", 200).await?;

        assert_eq!(gaps.len(), 1, "Should detect one gap");
        assert_eq!(gaps[0].start_block, 100);
        assert_eq!(gaps[0].end_block, 200);
        assert_eq!(gaps[0].actual_balance_after, "900");
        assert_eq!(gaps[0].expected_balance_before, "700");

        Ok(())
    }

    #[sqlx::test]
    async fn test_find_gaps_continuous_chain(pool: PgPool) -> sqlx::Result<()> {
        // Insert continuous records (no gap)
        let block_time1 = block_timestamp_to_datetime(1000000000i64);
        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
            "test.near",
            "NEAR",
            100i64,
            1000000000i64,
            block_time1,
            BigDecimal::from_str("100").unwrap(),
            BigDecimal::from_str("1000").unwrap(),
            BigDecimal::from_str("900").unwrap(),
            Some("recipient.near"),
            serde_json::json!({}),
            serde_json::json!({})
        )
        .execute(&pool)
        .await?;

        // Continuous: balance_before (900) == previous balance_after (900)
        let block_time2 = block_timestamp_to_datetime(2000000000i64);
        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
            "test.near",
            "NEAR",
            200i64,
            2000000000i64,
            block_time2,
            BigDecimal::from_str("100").unwrap(),
            BigDecimal::from_str("900").unwrap(),
            BigDecimal::from_str("800").unwrap(),
            Some("recipient.near"),
            serde_json::json!({}),
            serde_json::json!({})
        )
        .execute(&pool)
        .await?;

        let gaps = find_gaps(&pool, "test.near", "NEAR", 200).await?;

        assert_eq!(gaps.len(), 0, "Should detect no gaps in continuous chain");

        Ok(())
    }

    #[sqlx::test]
    async fn test_find_gaps_multiple_gaps(pool: PgPool) -> sqlx::Result<()> {
        let records = vec![
            (100i64, "1000", "900"),
            (200i64, "700", "600"), // Gap 1: 900 -> 700
            (300i64, "600", "500"), // Continuous
            (400i64, "400", "300"), // Gap 2: 500 -> 400
        ];

        for (block, before, after) in records {
            let before_bd = BigDecimal::from_str(before).unwrap();
            let after_bd = BigDecimal::from_str(after).unwrap();
            let amount = &before_bd - &after_bd;
            let block_timestamp = block * 10000000;
            let block_time = block_timestamp_to_datetime(block_timestamp);

            sqlx::query!(
                r#"
                INSERT INTO balance_changes 
                (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, counterparty, actions, raw_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                "#,
                "test.near",
                "NEAR",
                block,
                block_timestamp,
                block_time,
                amount,
                before_bd,
                after_bd,
                Some("recipient.near"),
                serde_json::json!({}),
                serde_json::json!({})
            )
            .execute(&pool)
            .await?;
        }

        let gaps = find_gaps(&pool, "test.near", "NEAR", 400).await?;

        assert_eq!(gaps.len(), 2, "Should detect two gaps");
        assert_eq!(gaps[0].start_block, 100);
        assert_eq!(gaps[0].end_block, 200);
        assert_eq!(gaps[1].start_block, 300);
        assert_eq!(gaps[1].end_block, 400);

        Ok(())
    }
}

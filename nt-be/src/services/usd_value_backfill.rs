//! Background service to populate usd_value on balance_changes records.
//!
//! This service periodically finds balance_changes rows where usd_value IS NULL,
//! fetches the USD price at the exact block_time from DefiLlama, and computes
//! usd_value = abs(amount) * price.
//!
//! Note: amounts in balance_changes are already in human-readable form
//! (e.g. 0.042 NEAR, not yoctoNEAR), so no division by 10^decimals is needed.
//!
//! It processes records in batches, grouping by token to minimise API calls.

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;

use super::defillama::DeFiLlamaClient;
use super::price_lookup::token_id_to_unified_asset_id;
use super::price_provider::PriceProvider;

/// How many records to process per cycle
const BATCH_SIZE: i64 = 50;

/// Interval between backfill cycles
const BACKFILL_INTERVAL_SECS: u64 = 60;

/// Delay between individual DefiLlama API calls to avoid rate limiting
const API_CALL_DELAY_MS: u64 = 2000;

/// A balance_changes row that needs usd_value populated
#[derive(sqlx::FromRow)]
struct PendingRecord {
    id: i64,
    token_id: String,
    block_time: DateTime<Utc>,
    amount: BigDecimal,
}

/// Run the background usd_value backfill service
pub async fn run_usd_value_backfill_service(pool: PgPool, client: DeFiLlamaClient) {
    tracing::info!(
        "Starting usd_value backfill service (interval: {}s)",
        BACKFILL_INTERVAL_SECS
    );

    // Wait for other services to start up
    tokio::time::sleep(Duration::from_secs(15)).await;

    let mut interval = tokio::time::interval(Duration::from_secs(BACKFILL_INTERVAL_SECS));

    loop {
        interval.tick().await;

        match backfill_batch(&pool, &client).await {
            Ok(0) => {
                tracing::debug!("usd_value backfill: no pending records");
            }
            Ok(count) => {
                tracing::info!("usd_value backfill: updated {} records", count);
            }
            Err(e) => {
                tracing::warn!("usd_value backfill error: {}", e);
            }
        }
    }
}

/// Process one batch of records that need usd_value populated
pub async fn backfill_batch(
    pool: &PgPool,
    client: &DeFiLlamaClient,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Fetch records that need usd_value, excluding snapshots and zero amounts
    let rows: Vec<PendingRecord> = sqlx::query_as(
        r#"
        SELECT id, token_id, block_time, amount
        FROM balance_changes
        WHERE usd_value IS NULL
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'NOT_REGISTERED')
          AND amount != 0
          AND block_time IS NOT NULL
          AND token_id IS NOT NULL
        ORDER BY block_time DESC
        LIMIT $1
        "#,
    )
    .bind(BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    // Build token_id -> defillama_asset_id cache
    let mut token_info_cache: HashMap<String, Option<String>> = HashMap::new();
    for row in &rows {
        if token_info_cache.contains_key(&row.token_id) {
            continue;
        }
        let info = resolve_token_info(&row.token_id, client);
        token_info_cache.insert(row.token_id.clone(), info);
    }

    // Prepare records with resolved info
    struct RecordWithInfo {
        id: i64,
        amount: BigDecimal,
        defillama_asset_id: String,
        timestamp: i64,
    }

    let mut records_with_info: Vec<RecordWithInfo> = Vec::new();

    for row in &rows {
        if let Some(Some(defillama_id)) = token_info_cache.get(&row.token_id) {
            records_with_info.push(RecordWithInfo {
                id: row.id,
                amount: row.amount.clone(),
                defillama_asset_id: defillama_id.clone(),
                timestamp: row.block_time.timestamp(),
            });
        }
    }

    let mut updated = 0;

    // Group by timestamp to batch DefiLlama calls
    let mut by_timestamp: HashMap<i64, Vec<&RecordWithInfo>> = HashMap::new();
    for rec in &records_with_info {
        by_timestamp.entry(rec.timestamp).or_default().push(rec);
    }

    for (timestamp, recs) in &by_timestamp {
        // Collect unique asset_ids for this timestamp
        let asset_ids: Vec<String> = recs
            .iter()
            .map(|r| r.defillama_asset_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        // Fetch prices from DefiLlama
        let prices = match client.get_prices_at_timestamp(&asset_ids, *timestamp).await {
            Ok(p) => p,
            Err(e) => {
                let msg = e.to_string();
                let short = if msg.len() > 120 { &msg[..120] } else { &msg };
                tracing::warn!("DefiLlama price fetch failed at {}: {}", timestamp, short);
                // Back off longer on errors (likely rate limited)
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        // Update each record in this timestamp group
        for rec in recs {
            if let Some(&price) = prices.get(&rec.defillama_asset_id) {
                let usd_value = compute_usd_value(&rec.amount, price);

                if let Some(val) = usd_value {
                    sqlx::query!(
                        "UPDATE balance_changes SET usd_value = $1 WHERE id = $2",
                        val,
                        rec.id,
                    )
                    .execute(pool)
                    .await?;
                    updated += 1;
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(API_CALL_DELAY_MS)).await;
    }

    Ok(updated)
}

/// Resolve a token_id to its DefiLlama asset ID
fn resolve_token_info(token_id: &str, client: &DeFiLlamaClient) -> Option<String> {
    let unified_id = token_id_to_unified_asset_id(token_id)?;
    client.translate_asset_id(&unified_id)
}

/// Compute the USD value from a human-readable amount and per-token price
///
/// usd_value = abs(amount) * price
///
/// Note: `amount` in balance_changes is already in human-readable form
/// (e.g. 0.042 NEAR, not 42000000000000000000000 yoctoNEAR),
/// so no division by 10^decimals is needed.
fn compute_usd_value(amount: &BigDecimal, price: f64) -> Option<BigDecimal> {
    use std::str::FromStr;

    let abs_amount = if amount < &BigDecimal::from(0) {
        -amount
    } else {
        amount.clone()
    };

    // Convert price via its string representation to avoid f64 → BigDecimal precision explosion
    // (e.g. f64 0.98 is internally 0.97999999999999998223..., but formats as "0.98")
    let price_bd = BigDecimal::from_str(&price.to_string()).ok()?;

    Some(abs_amount * price_bd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bigdecimal::ToPrimitive;

    #[test]
    fn test_compute_usd_value() {
        // 1.5 NEAR at $3.00 -> $4.50 (amount is human-readable, not yoctoNEAR)
        use std::str::FromStr;
        let amount = BigDecimal::from_str("1.5").unwrap();
        let result = compute_usd_value(&amount, 3.0).unwrap();
        let val = result.to_f64().unwrap();
        assert_eq!(val, 4.5, "1.5 NEAR at $3.00 = $4.50");
    }

    #[test]
    fn test_compute_usd_value_negative_amount() {
        // -2 USDC at $1.00 -> $2.00 (amount is human-readable)
        use std::str::FromStr;
        let amount = BigDecimal::from_str("-2.0").unwrap();
        let result = compute_usd_value(&amount, 1.0).unwrap();
        let val = result.to_f64().unwrap();
        assert_eq!(val, 2.0, "-2 USDC at $1.00 = $2.00");
    }

    #[test]
    fn test_compute_usd_value_small_near_amount() {
        // Real-world case: 0.0000599348488061 NEAR at $0.98
        // Expected: 0.0000599348488061 * 0.98 = 0.00005873615182997800
        use std::str::FromStr;
        let amount = BigDecimal::from_str("0.0000599348488061").unwrap();
        let result = compute_usd_value(&amount, 0.98).unwrap();
        let val = result.to_f64().unwrap();
        let expected = 0.0000599348488061 * 0.98;
        assert!(
            (val - expected).abs() < 1e-18,
            "Expected {}, got {}",
            expected,
            val
        );
    }

    #[test]
    fn test_compute_usd_value_btc() {
        // 0.005 BTC at $95,000 -> $475.00 (amount is human-readable)
        use std::str::FromStr;
        let amount = BigDecimal::from_str("0.005").unwrap();
        let result = compute_usd_value(&amount, 95_000.0).unwrap();
        let val = result.to_f64().unwrap();
        assert_eq!(val, 475.0, "0.005 BTC at $95,000 = $475.00");
    }
}

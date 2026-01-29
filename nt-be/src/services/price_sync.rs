//! Background price synchronization service
//!
//! This service runs periodically to fetch and cache historical prices from DeFiLlama.
//! API endpoints only read from the cache - they never block on price fetches.
//!
//! The list of assets to sync is derived from the balance_changes table - we only
//! fetch prices for tokens that users actually have in their treasuries.

use chrono::{NaiveDate, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use super::price_lookup::token_id_to_unified_asset_id;
use super::price_provider::PriceProvider;
use bigdecimal::BigDecimal;

/// Interval between price sync checks (1 minute)
const SYNC_CHECK_INTERVAL_SECS: u64 = 60;

/// Run the background price sync service
///
/// This function runs in a loop, checking every minute for assets that need
/// price data. It only fetches for assets that don't have recent data.
///
/// The list of assets is derived from the balance_changes table - we only sync
/// prices for tokens that users actually have in their treasuries.
pub async fn run_price_sync_service<P: PriceProvider + Send + Sync>(pool: PgPool, provider: P) {
    log::info!(
        "Starting background price sync service (check interval: {} seconds)",
        SYNC_CHECK_INTERVAL_SECS
    );

    // Run initial sync after a short delay to let server start
    tokio::time::sleep(Duration::from_secs(5)).await;

    let mut interval = tokio::time::interval(Duration::from_secs(SYNC_CHECK_INTERVAL_SECS));

    loop {
        interval.tick().await;

        // Find assets that need syncing (don't have yesterday's price)
        // We sync end-of-day prices, so we only sync completed days (yesterday and earlier)
        let yesterday = (Utc::now() - chrono::Duration::days(1)).date_naive();
        let assets_needing_sync = match get_assets_needing_sync(&pool, &provider, yesterday).await {
            Ok(assets) => assets,
            Err(e) => {
                log::error!("Failed to check which assets need sync: {}", e);
                continue;
            }
        };

        if assets_needing_sync.is_empty() {
            log::debug!("All assets have yesterday's prices, no sync needed");
            continue;
        }

        log::info!(
            "Price sync: {} assets need updating",
            assets_needing_sync.len()
        );

        for asset_id in assets_needing_sync {
            match sync_asset_prices(&pool, &provider, &asset_id).await {
                Ok(count) => {
                    log::info!("Synced {} prices for {}", count, asset_id);
                }
                Err(e) => {
                    log::warn!("Failed to sync prices for {}: {}", asset_id, e);
                }
            }

            // Small delay between assets to avoid rate limiting
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

/// Get list of provider asset IDs that need syncing (latest price is before target date)
///
/// This function:
/// 1. Queries distinct token_ids from balance_changes table
/// 2. Maps them to unified asset IDs using token_id_to_unified_asset_id
/// 3. Maps unified IDs to provider-specific asset IDs
/// 4. Filters to those missing yesterday's price
async fn get_assets_needing_sync<P: PriceProvider>(
    pool: &PgPool,
    provider: &P,
    target_date: NaiveDate,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    // Get all unique token_ids from balance_changes
    let token_ids: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        "#,
    )
    .fetch_all(pool)
    .await?;

    // Map token_ids to provider asset IDs
    let mut provider_asset_ids: HashSet<String> = HashSet::new();
    for (token_id,) in token_ids {
        // Map token_id to unified asset ID
        if let Some(unified_id) = token_id_to_unified_asset_id(&token_id) {
            // Map unified ID to provider-specific asset ID
            if let Some(provider_id) = provider.translate_asset_id(&unified_id) {
                provider_asset_ids.insert(provider_id);
            }
        }
    }

    if provider_asset_ids.is_empty() {
        return Ok(Vec::new());
    }

    log::debug!(
        "Found {} unique provider asset IDs from balance_changes",
        provider_asset_ids.len()
    );

    // Get the latest price date for each asset
    let latest_dates: Vec<(String, NaiveDate)> = sqlx::query_as(
        r#"
        SELECT asset_id, MAX(price_date) as latest_date
        FROM historical_prices
        GROUP BY asset_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    let latest_map: HashMap<String, NaiveDate> = latest_dates.into_iter().collect();

    // Return assets that either:
    // 1. Don't exist in the database yet
    // 2. Have a latest price date older than target date (yesterday)
    let needing_sync: Vec<String> = provider_asset_ids
        .into_iter()
        .filter(|asset| {
            match latest_map.get(asset) {
                None => true,                          // Asset not in DB yet
                Some(latest) => *latest < target_date, // Latest price is older than target
            }
        })
        .collect();

    Ok(needing_sync)
}

/// Sync prices for a single asset
async fn sync_asset_prices<P: PriceProvider>(
    pool: &PgPool,
    provider: &P,
    asset_id: &str,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Fetch all historical prices from the provider
    let prices = provider.get_all_historical_prices(asset_id).await?;

    if prices.is_empty() {
        return Ok(0);
    }

    // Cache all prices in the database
    cache_prices_batch(pool, asset_id, &prices, provider.source_name()).await?;

    Ok(prices.len())
}

/// Cache multiple prices in the database using a batch insert
async fn cache_prices_batch(
    pool: &PgPool,
    asset_id: &str,
    prices: &HashMap<NaiveDate, f64>,
    source: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if prices.is_empty() {
        return Ok(());
    }

    // Build batch insert using UNNEST for efficiency
    let dates: Vec<NaiveDate> = prices.keys().cloned().collect();
    let price_values: Vec<BigDecimal> = prices
        .values()
        .map(|&p| BigDecimal::try_from(p))
        .collect::<Result<Vec<_>, _>>()?;

    sqlx::query(
        r#"
        INSERT INTO historical_prices (asset_id, price_date, price_usd, source)
        SELECT $1, unnest($2::date[]), unnest($3::numeric[]), $4
        ON CONFLICT (asset_id, price_date, source) DO UPDATE SET
            price_usd = EXCLUDED.price_usd,
            fetched_at = NOW()
        "#,
    )
    .bind(asset_id)
    .bind(&dates)
    .bind(&price_values)
    .bind(source)
    .execute(pool)
    .await?;

    Ok(())
}

/// Perform an immediate price sync for all assets in balance_changes
///
/// This is useful for initial startup or manual triggers.
/// Returns the number of assets successfully synced.
pub async fn sync_all_prices_now<P: PriceProvider + Send + Sync>(
    pool: &PgPool,
    provider: &P,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Get all assets that need syncing (using a far future date to get all)
    let far_future = NaiveDate::from_ymd_opt(2099, 12, 31).unwrap();
    let assets = get_assets_needing_sync(pool, provider, far_future).await?;

    log::info!("Running immediate price sync for {} assets", assets.len());

    let mut success_count = 0;

    for asset_id in &assets {
        match sync_asset_prices(pool, provider, asset_id).await {
            Ok(count) => {
                log::info!("Synced {} prices for {}", count, asset_id);
                success_count += 1;
            }
            Err(e) => {
                log::warn!("Failed to sync prices for {}: {}", asset_id, e);
            }
        }

        // Small delay between assets to avoid rate limiting
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(success_count)
}

//! Background price synchronization service
//!
//! This service runs periodically to fetch and cache prices from DeFiLlama.
//! API endpoints only read from the cache - they never block on price fetches.
//!
//! The list of assets to sync is derived from public balance changes and
//! confidential gold tables - we only fetch prices for tokens users actually
//! have in their treasuries.

use chrono::{NaiveDate, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use super::price_lookup::token_id_to_unified_asset_id;
use super::price_provider::PriceProvider;
use bigdecimal::BigDecimal;

/// Interval between current price cache refreshes.
const SYNC_CHECK_INTERVAL_SECS: u64 = 60;

/// Maximum number of provider asset IDs to request in one current-price call.
const CURRENT_PRICE_BATCH_SIZE: usize = 50;

/// Run the background price sync service
///
/// This function runs in a loop, refreshing current prices every 60 seconds
/// and backfilling historical daily prices for assets that need them.
///
/// The list of assets is derived from public and confidential treasury data.
pub async fn run_price_sync_service<P: PriceProvider + Send + Sync>(pool: PgPool, provider: P) {
    tracing::info!(
        "Starting background price sync service (check interval: {} seconds)",
        SYNC_CHECK_INTERVAL_SECS
    );

    // Run initial sync after a short delay to let server start
    tokio::time::sleep(Duration::from_secs(5)).await;

    let mut interval = tokio::time::interval(Duration::from_secs(SYNC_CHECK_INTERVAL_SECS));

    loop {
        interval.tick().await;

        let provider_asset_ids = match get_all_provider_asset_ids(&pool, &provider).await {
            Ok(assets) => assets,
            Err(e) => {
                tracing::error!("Failed to load price sync asset list: {}", e);
                continue;
            }
        };

        if provider_asset_ids.is_empty() {
            tracing::debug!("No assets found for price sync");
            continue;
        }

        // Find assets that need syncing (don't have yesterday's price)
        // We sync end-of-day prices, so we only sync completed days (yesterday and earlier)
        let yesterday = (Utc::now() - chrono::Duration::days(1)).date_naive();
        let assets_needing_sync =
            match get_assets_needing_sync(&pool, &provider_asset_ids, yesterday).await {
                Ok(assets) => assets,
                Err(e) => {
                    tracing::error!("Failed to check which assets need sync: {}", e);
                    continue;
                }
            };

        if assets_needing_sync.is_empty() {
            tracing::debug!("All assets have yesterday's prices, no sync needed");
        } else {
            tracing::info!(
                "Price sync: {} assets need updating",
                assets_needing_sync.len()
            );

            for asset_id in assets_needing_sync {
                match sync_asset_prices(&pool, &provider, &asset_id).await {
                    Ok(count) => {
                        tracing::info!("Synced {} prices for {}", count, asset_id);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to sync prices for {}: {}", asset_id, e);
                    }
                }

                // Small delay between assets to avoid rate limiting
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        match sync_current_prices(&pool, &provider, &provider_asset_ids).await {
            Ok(count) => {
                tracing::info!(
                    "Refreshed {} current prices for {} tracked assets",
                    count,
                    provider_asset_ids.len()
                );
            }
            Err(e) => {
                tracing::warn!("Failed to refresh current prices: {}", e);
            }
        }
    }
}

/// Get list of provider asset IDs that need syncing (latest price is before target date)
///
/// This function:
/// 1. Queries distinct token IDs from public and confidential treasury tables
/// 2. Maps them to unified asset IDs using token_id_to_unified_asset_id
/// 3. Maps unified IDs to provider-specific asset IDs
async fn get_all_provider_asset_ids<P: PriceProvider>(
    pool: &PgPool,
    provider: &P,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    // Get all unique token IDs/assets we have seen in public and confidential data.
    let token_ids: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE token_id IS NOT NULL
        UNION
        SELECT DISTINCT asset AS token_id
        FROM gold_confidential_balance_snapshots
        WHERE asset IS NOT NULL
        UNION
        SELECT DISTINCT origin_asset AS token_id
        FROM gold_confidential_history_events
        WHERE origin_asset IS NOT NULL
        UNION
        SELECT DISTINCT destination_asset AS token_id
        FROM gold_confidential_history_events
        WHERE destination_asset IS NOT NULL
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

    tracing::debug!(
        "Found {} unique provider asset IDs for price sync",
        provider_asset_ids.len()
    );

    Ok(provider_asset_ids.into_iter().collect())
}

/// Get list of provider asset IDs that need historical syncing.
async fn get_assets_needing_sync(
    pool: &PgPool,
    provider_asset_ids: &[String],
    target_date: NaiveDate,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    if provider_asset_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Current prices update today's row every cycle, so historical catch-up must
    // check the specific completed day rather than relying on MAX(price_date).
    let synced_assets: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT asset_id
        FROM historical_prices
        WHERE asset_id = ANY($1)
          AND price_date = $2
        "#,
    )
    .bind(provider_asset_ids)
    .bind(target_date)
    .fetch_all(pool)
    .await?;

    let synced_assets: HashSet<String> = synced_assets
        .into_iter()
        .map(|(asset_id,)| asset_id)
        .collect();

    let needing_sync: Vec<String> = provider_asset_ids
        .iter()
        .filter(|asset| !synced_assets.contains(*asset))
        .cloned()
        .collect();

    Ok(needing_sync)
}

/// Refresh today's cached price for all tracked assets.
async fn sync_current_prices<P: PriceProvider>(
    pool: &PgPool,
    provider: &P,
    asset_ids: &[String],
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    if asset_ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0;
    for chunk in asset_ids.chunks(CURRENT_PRICE_BATCH_SIZE) {
        let prices = provider.get_current_prices(chunk).await?;
        if prices.is_empty() {
            continue;
        }

        cache_current_prices(pool, &prices, provider.source_name()).await?;
        total += prices.len();
    }

    Ok(total)
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

    sqlx::query!(
        r#"
        INSERT INTO historical_prices (asset_id, price_date, price_usd, source)
        SELECT $1, unnest($2::date[]), unnest($3::numeric[]), $4
        ON CONFLICT (asset_id, price_date, source) DO UPDATE SET
            price_usd = EXCLUDED.price_usd,
            fetched_at = NOW()
        "#,
        asset_id,
        &dates,
        &price_values,
        source,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Cache current prices as today's row in `historical_prices`.
async fn cache_current_prices(
    pool: &PgPool,
    prices: &HashMap<String, f64>,
    source: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if prices.is_empty() {
        return Ok(());
    }

    let today = Utc::now().date_naive();
    let asset_ids: Vec<String> = prices.keys().cloned().collect();
    let dates: Vec<NaiveDate> = asset_ids.iter().map(|_| today).collect();
    let price_values: Vec<BigDecimal> = asset_ids
        .iter()
        .map(|asset_id| BigDecimal::try_from(prices[asset_id]))
        .collect::<Result<Vec<_>, _>>()?;

    sqlx::query(
        r#"
        INSERT INTO historical_prices (asset_id, price_date, price_usd, source)
        SELECT unnest($1::text[]), unnest($2::date[]), unnest($3::numeric[]), $4
        ON CONFLICT (asset_id, price_date, source) DO UPDATE SET
            price_usd = EXCLUDED.price_usd,
            fetched_at = NOW()
        "#,
    )
    .bind(&asset_ids)
    .bind(&dates)
    .bind(&price_values)
    .bind(source)
    .execute(pool)
    .await?;

    Ok(())
}

/// Perform an immediate historical price sync for all tracked assets
///
/// This is useful for initial startup or manual triggers.
/// Returns the number of assets successfully synced.
pub async fn sync_all_prices_now<P: PriceProvider + Send + Sync>(
    pool: &PgPool,
    provider: &P,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Get all assets that need syncing (using a far future date to get all)
    let far_future = NaiveDate::from_ymd_opt(2099, 12, 31).unwrap();
    let provider_asset_ids = get_all_provider_asset_ids(pool, provider).await?;
    let assets = get_assets_needing_sync(pool, &provider_asset_ids, far_future).await?;

    tracing::info!("Running immediate price sync for {} assets", assets.len());

    let mut success_count = 0;

    for asset_id in &assets {
        match sync_asset_prices(pool, provider, asset_id).await {
            Ok(count) => {
                tracing::info!("Synced {} prices for {}", count, asset_id);
                success_count += 1;
            }
            Err(e) => {
                tracing::warn!("Failed to sync prices for {}: {}", asset_id, e);
            }
        }

        // Small delay between assets to avoid rate limiting
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(success_count)
}

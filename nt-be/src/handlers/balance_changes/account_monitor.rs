use near_api::NetworkConfig;
use sqlx::PgPool;
use sqlx::types::chrono::{DateTime, Utc};
use std::collections::HashSet;

use super::balance::ft::get_balance_at_block as get_ft_balance;
use super::gap_filler::{
    fill_gaps_with_hints, insert_snapshot_record, resolve_missing_action_kind,
    resolve_missing_tx_hashes,
};
use super::staking_rewards::{is_staking_token, track_and_fill_staking_rewards};
use super::swap_detector::{
    classify_proposal_swap_deposits, detect_swaps_from_api_with_client, store_detected_swaps,
};
use super::token_discovery::{fetch_fastnear_ft_tokens, snapshot_intents_tokens};
use super::transfer_hints::TransferHintService;
use super::transfer_hints::neardata::NeardataClient;
use crate::AppState;

/// Compute the effective block floor for gap-filling lookback.
///
/// Returns the higher of:
/// - The account's `CreateAccount` block from `balance_changes`
/// - The `maintenance_block_floor` column from `monitored_accounts`
///
/// Used by both `run_maintenance_cycle` and `fill_account_gaps`.
async fn get_effective_block_floor(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let creation_block: Option<i64> = sqlx::query_scalar(
        "SELECT block_height FROM balance_changes \
         WHERE account_id = $1 AND action_kind = 'CreateAccount' AND token_id = 'near' \
         ORDER BY block_height ASC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    let maintenance_floor: Option<i64> = sqlx::query_scalar(
        "SELECT maintenance_block_floor FROM monitored_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?
    .flatten();

    Ok(match (creation_block, maintenance_floor) {
        (Some(c), Some(m)) => Some(c.max(m)),
        (c, m) => c.or(m),
    })
}

/// Return true when the account has new intents balance changes after the last
/// detected swap block. This is used to avoid calling the Intents Explorer API
/// for accounts with no recent intents activity.
async fn has_new_intents_activity_since_last_swap(
    pool: &PgPool,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    let has_new = sqlx::query_scalar!(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM balance_changes bc
            WHERE bc.account_id = $1
              AND bc.token_id LIKE 'intents.near:%'
              AND bc.block_height > COALESCE(
                  (SELECT MAX(ds.block_height) FROM detected_swaps ds WHERE ds.account_id = $1),
                  0
              )
        ) AS "exists!"
        "#,
        account_id
    )
    .fetch_one(pool)
    .await?;

    Ok(has_new)
}

/// Run one maintenance cycle for all enabled monitored accounts.
///
/// Handles: token discovery, gap filling, tx resolution, swap detection,
/// and staking rewards. Accounts marked dirty are prioritised (processed
/// first) and have their dirty flag cleared after processing.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `up_to_block` - Process gaps up to this block height
/// * `hint_service` - Optional transfer hint service for accelerated gap filling
/// * `fastnear` - Optional `(http_client, api_key)` for FT token discovery via FastNear balance API
/// * `intents_api_key` - Optional Intents Explorer API key for swap detection
/// * `intents_api_url` - Intents Explorer API base URL
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(job = "account_maintenance", up_to_block = up_to_block)
)]
pub async fn run_maintenance_cycle(
    app_state: &AppState,
    up_to_block: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    // Process all enabled, non-confidential accounts; dirty accounts first.
    // Confidential DAOs are handled by a dedicated 5-minute poll worker
    // (`run_confidential_poll_cycle`) and have no on-chain pipeline to run.
    let accounts: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        r#"
        SELECT account_id, dirty_at
        FROM monitored_accounts
        WHERE enabled = true
          AND is_confidential_account = false
        ORDER BY dirty_at DESC NULLS LAST
        "#,
    )
    .fetch_all(&app_state.db_pool)
    .await?;

    // Correct NEAR transfer counterparties unconditionally — runs even if no
    // monitored accounts are registered, so pre-existing wrong records are fixed.
    match super::counterparty_correction::correct_near_counterparties(
        &app_state.db_pool,
        &app_state.network,
    )
    .await
    {
        Ok(count) if count > 0 => {
            tracing::info!("Corrected {} NEAR transfer counterparties", count);
        }
        Err(e) => {
            tracing::warn!("Error correcting NEAR counterparties: {}", e);
        }
        _ => {}
    }

    if accounts.is_empty() {
        return Ok(());
    }

    tracing::info!("Processing {} enabled accounts", accounts.len());

    for (account_id, original_dirty_at) in &accounts {
        tracing::info!("Processing {}", account_id);

        {
            // Regular treasury: full on-chain pipeline

            // 1. Discover new FT tokens via FastNear
            match discover_ft_tokens_from_fastnear(
                &app_state.db_pool,
                &app_state.network,
                &app_state.http_client,
                &app_state.env_vars.fastnear_api_key,
                account_id,
                up_to_block,
            )
            .await
            {
                Ok(count) if count > 0 => {
                    tracing::info!(
                        "{}: Discovered {} new FT tokens via FastNear",
                        account_id,
                        count
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "{}: Error discovering FT tokens via FastNear: {}",
                        account_id,
                        e
                    );
                }
                _ => {}
            }

            // 2. Discover FT tokens from receipts
            match discover_ft_tokens_from_receipts(
                &app_state.db_pool,
                &app_state.network,
                account_id,
                up_to_block,
            )
            .await
            {
                Ok(count) if count > 0 => {
                    tracing::info!(
                        "{}: Discovered {} new FT tokens from receipts",
                        account_id,
                        count
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "{}: Error discovering FT tokens from receipts: {}",
                        account_id,
                        e
                    );
                }
                _ => {}
            }

            // 3. Discover intents tokens
            match discover_intents_tokens(
                &app_state.db_pool,
                &app_state.network,
                account_id,
                up_to_block,
            )
            .await
            {
                Ok(count) if count > 0 => {
                    tracing::info!("{}: Discovered {} new intents tokens", account_id, count);
                }
                Err(e) => {
                    tracing::warn!("{}: Error discovering intents tokens: {}", account_id, e);
                }
                _ => {}
            }

            // 4. Determine effective block floor (creation block ∨ maintenance_block_floor)
            let effective_floor = get_effective_block_floor(&app_state.db_pool, account_id).await?;
            if let Some(block) = effective_floor {
                tracing::debug!("{}: Effective block floor: {}", account_id, block,);
            }

            // 5. Fill gaps for all tokens
            let mut tokens: Vec<String> = sqlx::query_scalar(
                r#"
            SELECT DISTINCT token_id
            FROM balance_changes
            WHERE account_id = $1 AND token_id IS NOT NULL
            ORDER BY token_id
            "#,
            )
            .bind(account_id)
            .fetch_all(&app_state.db_pool)
            .await?;

            if !tokens.contains(&"near".to_string()) {
                tokens.push("near".to_string());
            }

            let mut total_filled = 0;
            for token_id in &tokens {
                if is_staking_token(token_id) {
                    continue;
                }

                match fill_gaps_with_hints(
                    &app_state.db_pool,
                    &app_state.archival_network,
                    account_id,
                    token_id,
                    up_to_block,
                    app_state.transfer_hint_service.as_deref(),
                    effective_floor,
                    app_state.neardata_client.as_ref(),
                )
                .await
                {
                    Ok(filled) => {
                        if !filled.is_empty() {
                            tracing::info!(
                                "{}/{}: Filled {} gaps",
                                account_id,
                                token_id,
                                filled.len()
                            );
                            total_filled += filled.len();
                        }
                    }
                    Err(e) => {
                        tracing::error!("{}/{}: Error filling gaps: {}", account_id, token_id, e);
                    }
                }
            }

            if total_filled > 0 {
                tracing::info!(
                    "{}: Filled {} total gaps across all tokens",
                    account_id,
                    total_filled
                );
            }

            // 6. Resolve missing transaction hashes
            match resolve_missing_tx_hashes(&app_state.db_pool, &app_state.network, account_id, 10)
                .await
            {
                Ok(count) if count > 0 => {
                    tracing::info!("{}: Resolved {} missing tx hashes", account_id, count);
                }
                Err(e) => {
                    tracing::warn!("{}: Error resolving missing tx hashes: {}", account_id, e);
                }
                _ => {}
            }

            // 7. Resolve missing action_kind
            match resolve_missing_action_kind(
                &app_state.db_pool,
                &app_state.network,
                account_id,
                10,
            )
            .await
            {
                Ok(count) if count > 0 => {
                    tracing::info!("{}: Resolved {} missing action_kind", account_id, count);
                }
                Err(e) => {
                    tracing::warn!("{}: Error resolving missing action_kind: {}", account_id, e);
                }
                _ => {}
            }

            // 8. Detect and store swaps only when there are new intents token
            // changes after the last detected swap block.
            match has_new_intents_activity_since_last_swap(&app_state.db_pool, account_id).await {
                Ok(true) => {
                    match detect_swaps_from_api_with_client(
                        &app_state.http_client,
                        &app_state.db_pool,
                        account_id,
                        app_state.env_vars.intents_explorer_api_key.as_deref(),
                        &app_state.env_vars.intents_explorer_api_url,
                    )
                    .await
                    {
                        Ok(swaps) => {
                            if !swaps.is_empty() {
                                match store_detected_swaps(&app_state.db_pool, &swaps).await {
                                    Ok(inserted) if inserted > 0 => {
                                        tracing::info!(
                                            "{}: Detected and stored {} new swaps",
                                            account_id,
                                            inserted
                                        );
                                    }
                                    Err(e) => {
                                        tracing::error!(
                                            "{}: Error storing detected swaps: {}",
                                            account_id,
                                            e
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!("{}: Error detecting swaps: {}", account_id, e);
                        }
                    }
                }
                Ok(false) => {
                    tracing::debug!(
                        "{}: Skipping swap detection (no new intents activity)",
                        account_id
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "{}: Could not check intents activity before swap detection: {}",
                        account_id,
                        e
                    );
                }
            }

            // 9. Classify DAO proposal-based swap deposits
            match classify_proposal_swap_deposits(
                &app_state.db_pool,
                &app_state.network,
                account_id,
            )
            .await
            {
                Ok(count) if count > 0 => {
                    tracing::info!(
                        "{}: Classified {} proposal swap deposits",
                        account_id,
                        count
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "{}: Error classifying proposal swap deposits: {}",
                        account_id,
                        e
                    );
                }
                _ => {}
            }

            // 10. Track staking rewards
            if !app_state.env_vars.disable_staking_rewards {
                match track_and_fill_staking_rewards(
                    &app_state.db_pool,
                    &app_state.archival_network,
                    account_id,
                    up_to_block,
                )
                .await
                {
                    Ok(records_created) if records_created > 0 => {
                        tracing::info!(
                            "{}: Created {} staking reward records",
                            account_id,
                            records_created
                        );
                    }
                    Err(e) => {
                        tracing::warn!("{}: Error tracking staking rewards: {}", account_id, e);
                    }
                    _ => {}
                }
            }
        } // end regular treasury

        // 11. Update last_synced_at
        if let Err(e) = sqlx::query!(
            "UPDATE monitored_accounts SET last_synced_at = NOW() WHERE account_id = $1",
            account_id
        )
        .execute(&app_state.db_pool)
        .await
        {
            tracing::error!("{}: Error updating last_synced_at: {}", account_id, e);
        }

        // 11. Conditional clear: only clear dirty_at if it hasn't changed since we started
        if let Some(dirty_at) = original_dirty_at {
            let result = sqlx::query!(
                "UPDATE monitored_accounts SET dirty_at = NULL WHERE account_id = $1 AND dirty_at = $2",
                account_id,
                dirty_at,
            )
            .execute(&app_state.db_pool)
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => {
                    tracing::info!("{} dirty flag cleared", account_id);
                }
                Ok(_) => {
                    tracing::info!(
                        "{} dirty flag was re-set during processing, leaving for next cycle",
                        account_id
                    );
                }
                Err(e) => {
                    tracing::error!("{}: Error clearing dirty flag: {}", account_id, e);
                }
            }
        }
    }

    tracing::info!("Cycle complete");
    Ok(())
}

/// Discover FT tokens from counterparties in collected balance changes
///
/// This function:
/// 1. Gets distinct counterparties from recent NEAR balance changes
/// 2. Checks if each counterparty is an FT contract (by calling ft_balance_of)
/// 3. For newly discovered FT tokens, seeds an initial balance change record
async fn discover_ft_tokens_from_receipts(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    up_to_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    // Get distinct counterparties from recent NEAR balance changes
    // Exclude metadata values that are not actual account IDs
    let counterparties: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT counterparty
        FROM balance_changes
        WHERE account_id = $1
          AND token_id = 'near'
          AND counterparty != 'SNAPSHOT'
        ORDER BY counterparty
        LIMIT 100
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    if counterparties.is_empty() {
        return Ok(0);
    }

    // Get tokens we already know about
    let known_tokens: HashSet<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Check each counterparty to see if it's an FT contract
    let mut discovered_tokens = HashSet::new();

    for counterparty in counterparties {
        // Skip if we already track this token
        if known_tokens.contains(&counterparty) {
            continue;
        }

        // Try to query FT balance - if it succeeds, it's an FT contract
        match get_ft_balance(pool, network, account_id, &counterparty, up_to_block as u64).await {
            Ok(_balance) => {
                tracing::debug!("Counterparty {} is an FT contract", counterparty);
                discovered_tokens.insert(counterparty);
            }
            Err(_) => {
                // Not an FT contract, or error querying - skip it
                tracing::debug!("Counterparty {} is not an FT contract", counterparty);
            }
        }
    }

    if discovered_tokens.is_empty() {
        return Ok(0);
    }

    // For each discovered FT token, insert it into monitored tokens list
    // The next monitoring cycle will automatically fill gaps for these tokens
    let seeded_count = discovered_tokens.len();
    for token_contract in discovered_tokens {
        // Insert a marker record so the token appears in the distinct token_id query
        // Use the earliest block where we have data to start gap filling from there
        let earliest_block: Option<i64> = sqlx::query_scalar(
            r#"
            SELECT MIN(block_height)
            FROM balance_changes
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .fetch_one(pool)
        .await?;

        if let Some(_start_block) = earliest_block {
            // Insert a snapshot record using the shared helper
            match insert_snapshot_record(
                pool,
                network,
                account_id,
                &token_contract,
                up_to_block as u64,
            )
            .await
            {
                Ok(_) => {
                    tracing::info!(
                        "Discovered FT token {} for account {}",
                        token_contract,
                        account_id
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "Failed to insert snapshot for discovered token {} at block {}: {}",
                        token_contract,
                        up_to_block,
                        e
                    );
                    continue;
                }
            }
        }
    }

    Ok(seeded_count)
}

/// Discover FT tokens via FastNear balance API
///
/// This function:
/// 1. Queries FastNear for all FT tokens with positive balances
/// 2. Cross-references against already-tracked tokens in balance_changes
/// 3. For newly discovered tokens, seeds an initial snapshot record
///
/// This catches tokens that the counterparty-based discovery misses — for example,
/// when a treasury receives a direct FT deposit from an account it has never
/// transacted with in NEAR.
#[tracing::instrument(
    level = "debug",
    skip_all,
    fields(account_id = account_id, up_to_block = up_to_block)
)]
pub async fn discover_ft_tokens_from_fastnear(
    pool: &PgPool,
    network: &NetworkConfig,
    http_client: &reqwest::Client,
    fastnear_api_key: &str,
    account_id: &str,
    up_to_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    let fastnear_tokens =
        match fetch_fastnear_ft_tokens(http_client, fastnear_api_key, account_id).await {
            Ok(tokens) => tokens,
            Err(e) => {
                tracing::warn!(
                    "Failed to fetch FastNear FT tokens for {}: {}",
                    account_id,
                    e
                );
                return Ok(0);
            }
        };

    if fastnear_tokens.is_empty() {
        return Ok(0);
    }

    // Get tokens we already know about
    let known_tokens: HashSet<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Find new FT tokens not yet tracked
    let new_tokens: Vec<_> = fastnear_tokens
        .into_iter()
        .filter(|t| !known_tokens.contains(t))
        .collect();

    if new_tokens.is_empty() {
        return Ok(0);
    }

    // For each new FT token, insert a snapshot record
    let mut seeded_count = 0;
    for token_contract in new_tokens {
        match insert_snapshot_record(
            pool,
            network,
            account_id,
            &token_contract,
            up_to_block as u64,
        )
        .await
        {
            Ok(_) => {
                tracing::info!(
                    "Discovered FT token {} for account {} via FastNear",
                    token_contract,
                    account_id
                );
                seeded_count += 1;
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to insert snapshot for FastNear-discovered token {} at block {}: {}",
                    token_contract,
                    up_to_block,
                    e
                );
            }
        }
    }

    Ok(seeded_count)
}

/// Discover intents tokens via mt_tokens_for_owner snapshot
///
/// This function:
/// 1. Calls mt_tokens_for_owner on intents.near to get all tokens held by the account
/// 2. For newly discovered intents tokens, seeds an initial balance change record
/// 3. The next monitoring cycle will automatically fill gaps for these tokens
#[tracing::instrument(
    level = "debug",
    skip_all,
    fields(account_id = account_id, up_to_block = up_to_block)
)]
pub async fn discover_intents_tokens(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    up_to_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    // Get current intents tokens for this account
    let intents_tokens = match snapshot_intents_tokens(network, account_id).await {
        Ok(tokens) => tokens,
        Err(e) => {
            // Not all accounts have intents tokens - this is expected
            tracing::debug!("No intents tokens for {}: {}", account_id, e);
            return Ok(0);
        }
    };

    if intents_tokens.is_empty() {
        return Ok(0);
    }

    // Get tokens we already know about
    let known_tokens: HashSet<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id IS NOT NULL
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Find new intents tokens
    let new_tokens: Vec<_> = intents_tokens
        .into_iter()
        .filter(|t| !known_tokens.contains(t))
        .collect();

    if new_tokens.is_empty() {
        return Ok(0);
    }

    tracing::info!(
        "{}: Discovered {} new intents tokens",
        account_id,
        new_tokens.len()
    );

    // For each new intents token, insert a snapshot record
    let mut seeded_count = 0;
    for token_id in new_tokens {
        match insert_snapshot_record(pool, network, account_id, &token_id, up_to_block as u64).await
        {
            Ok(_) => {
                tracing::info!(
                    "Discovered intents token {} for account {}",
                    token_id,
                    account_id
                );
                seeded_count += 1;
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to insert snapshot for intents token {} at block {}: {}",
                    token_id,
                    up_to_block,
                    e
                );
            }
        }
    }

    Ok(seeded_count)
}

/// Fill gaps for all non-staking tokens of an account up to the given block.
///
/// This is a utility function used by the maintenance cycle and exposed
/// for integration testing with controlled block heights.
///
/// Respects `maintenance_block_floor` from monitored_accounts as a hard stop
/// for how far back gap filling scans (merged with any creation_block floor).
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(account_id = account_id, up_to_block = up_to_block)
)]
pub async fn fill_account_gaps(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    up_to_block: i64,
    hint_service: Option<&TransferHintService>,
    neardata: Option<&NeardataClient>,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let effective_floor = get_effective_block_floor(pool, account_id).await?;

    let mut tokens: Vec<String> = sqlx::query_scalar(
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

    if !tokens.contains(&"near".to_string()) {
        tokens.push("near".to_string());
    }

    let mut total_filled = 0;

    for token_id in &tokens {
        if is_staking_token(token_id) {
            continue;
        }

        match fill_gaps_with_hints(
            pool,
            network,
            account_id,
            token_id,
            up_to_block,
            hint_service,
            effective_floor,
            neardata,
        )
        .await
        {
            Ok(filled) => {
                if !filled.is_empty() {
                    tracing::info!("{}/{}: Filled {} gaps", account_id, token_id, filled.len());
                    total_filled += filled.len();
                }
            }
            Err(e) => {
                tracing::error!("{}/{}: Error filling gaps: {}", account_id, token_id, e);
            }
        }
    }

    Ok(total_filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_maintenance_cycle_with_no_dirty_accounts() {
        let state = crate::utils::test_utils::init_test_state().await;

        // Should not error with no dirty accounts
        let result = run_maintenance_cycle(&state, 177_000_000).await;
        assert!(result.is_ok());
    }
}

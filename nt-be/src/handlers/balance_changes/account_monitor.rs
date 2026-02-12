use near_api::NetworkConfig;
use sqlx::PgPool;
use std::collections::HashSet;

use super::balance::ft::get_balance_at_block as get_ft_balance;
use super::gap_filler::{fill_gaps_with_hints, insert_snapshot_record};
use super::staking_rewards::{is_staking_token, track_and_fill_staking_rewards};
use super::token_discovery::{fetch_fastnear_ft_tokens, snapshot_intents_tokens};
use super::transfer_hints::TransferHintService;

/// Run one cycle of monitoring for all enabled accounts
///
/// This function:
/// 1. Queries all enabled accounts from monitored_accounts table
/// 2. For each account:
///    - Gets all known tokens for that account from balance_changes
///    - Runs gap filling for each token up to the specified block
///    - Discovers new FT tokens via FastNear API (if configured)
///    - Discovers new FT tokens from counterparties in balance changes
///    - Discovers new intents tokens via mt_tokens_for_owner
///    - Tracks staking rewards
///    - Updates last_synced_at timestamp after processing
/// 3. Handles errors gracefully, continuing with next account if one fails
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `up_to_block` - Process gaps up to this block height
/// * `hint_service` - Optional transfer hint service for accelerated gap filling
/// * `fastnear` - Optional `(http_client, api_key)` for FT token discovery via FastNear balance API
pub async fn run_monitor_cycle(
    pool: &PgPool,
    network: &NetworkConfig,
    up_to_block: i64,
    hint_service: Option<&TransferHintService>,
    fastnear: Option<(&reqwest::Client, &str)>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get all enabled monitored accounts
    let accounts = sqlx::query!(
        r#"
        SELECT account_id, last_synced_at
        FROM monitored_accounts
        WHERE enabled = true
        ORDER BY 
            CASE WHEN last_synced_at IS NULL THEN 0 ELSE 1 END,
            last_synced_at ASC NULLS FIRST
        "#
    )
    .fetch_all(pool)
    .await?;

    if accounts.is_empty() {
        println!("No enabled accounts to monitor");
        return Ok(());
    }

    println!("Monitoring {} enabled accounts", accounts.len());

    for account in accounts {
        let account_id = &account.account_id;

        // Get all unique tokens for this account
        // Note: This appears to be an N+1 query pattern, but it's intentional for this use case.
        // See: https://github.com/NEAR-DevHub/treasury26/pull/17#discussion_r2652866830
        //
        // Rationale: This is a background job that processes accounts sequentially, not a web request.
        // Loading all account-token pairs upfront would:
        // 1. Hold a large dataset in memory unnecessarily
        // 2. Not improve performance since we process one account at a time anyway
        // 3. Make the code more complex
        //
        // The query overhead is negligible compared to the RPC calls for filling gaps.
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

        // Always ensure NEAR is in the tokens list - it may not be tracked yet
        // even if other tokens (like intents tokens) have already been discovered
        if !tokens.contains(&"near".to_string()) {
            tokens.push("near".to_string());
        }

        println!("  {}: Checking {} tokens", account_id, tokens.len());

        let mut processed_tokens = 0;
        let mut errors = Vec::new();

        for token_id in &tokens {
            // Skip staking tokens - they use epoch-based snapshots, not gap filling
            if is_staking_token(token_id) {
                processed_tokens += 1;
                continue;
            }

            match fill_gaps_with_hints(
                pool,
                network,
                account_id,
                token_id,
                up_to_block,
                hint_service,
            )
            .await
            {
                Ok(filled) => {
                    if !filled.is_empty() {
                        println!("    {}: Filled {} gaps", token_id, filled.len());
                    }
                    processed_tokens += 1;
                }
                Err(e) => {
                    eprintln!("    {}: Error filling gaps: {}", token_id, e);
                    errors.push(format!("{}: {}", token_id, e));
                }
            }
        }

        // Update last_synced_at even if some tokens had errors
        if processed_tokens > 0 {
            sqlx::query!(
                r#"
                UPDATE monitored_accounts
                SET last_synced_at = NOW()
                WHERE account_id = $1
                "#,
                account_id
            )
            .execute(pool)
            .await?;

            println!(
                "  {}: Updated sync timestamp ({}/{} tokens processed)",
                account_id,
                processed_tokens,
                tokens.len()
            );
        }

        if !errors.is_empty() {
            eprintln!(
                "  {}: {} errors occurred: {:?}",
                account_id,
                errors.len(),
                errors
            );
        }

        // Discover new FT tokens via FastNear balance API
        // This catches tokens not found by counterparty-based discovery (e.g., direct
        // FT deposits from accounts the treasury has never transacted with in NEAR)
        if let Some((http_client, api_key)) = fastnear {
            match discover_ft_tokens_from_fastnear(
                pool,
                network,
                http_client,
                api_key,
                account_id,
                up_to_block,
            )
            .await
            {
                Ok(discovered_count) => {
                    if discovered_count > 0 {
                        println!(
                            "  {}: Discovered {} new FT tokens via FastNear",
                            account_id, discovered_count
                        );
                    }
                }
                Err(e) => {
                    eprintln!(
                        "  {}: Error discovering FT tokens via FastNear: {}",
                        account_id, e
                    );
                }
            }
        }

        // Discover new FT tokens from collected receipts
        match discover_ft_tokens_from_receipts(pool, network, account_id, up_to_block).await {
            Ok(discovered_count) => {
                if discovered_count > 0 {
                    println!(
                        "  {}: Discovered {} new FT tokens",
                        account_id, discovered_count
                    );
                }
            }
            Err(e) => {
                eprintln!("  {}: Error discovering FT tokens: {}", account_id, e);
            }
        }

        // Discover intents tokens via mt_tokens_for_owner snapshot
        match discover_intents_tokens(pool, network, account_id, up_to_block).await {
            Ok(discovered_count) => {
                if discovered_count > 0 {
                    println!(
                        "  {}: Discovered {} new intents tokens",
                        account_id, discovered_count
                    );
                }
            }
            Err(e) => {
                eprintln!("  {}: Error discovering intents tokens: {}", account_id, e);
            }
        }

        // Track staking rewards - discover staking pools, create epoch snapshots, and fill gaps
        match track_and_fill_staking_rewards(pool, network, account_id, up_to_block).await {
            Ok(records_created) => {
                if records_created > 0 {
                    println!(
                        "  {}: Created {} staking reward records (snapshots + filled gaps)",
                        account_id, records_created
                    );
                }
            }
            Err(e) => {
                eprintln!("  {}: Error tracking staking rewards: {}", account_id, e);
            }
        }
    }

    println!("Monitor cycle complete");
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
                log::debug!("Counterparty {} is an FT contract", counterparty);
                discovered_tokens.insert(counterparty);
            }
            Err(_) => {
                // Not an FT contract, or error querying - skip it
                log::debug!("Counterparty {} is not an FT contract", counterparty);
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
                    log::info!(
                        "Discovered FT token {} for account {}",
                        token_contract,
                        account_id
                    );
                }
                Err(e) => {
                    log::warn!(
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
                log::warn!(
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
                log::info!(
                    "Discovered FT token {} for account {} via FastNear",
                    token_contract,
                    account_id
                );
                seeded_count += 1;
            }
            Err(e) => {
                log::warn!(
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
            log::debug!("No intents tokens for {}: {}", account_id, e);
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

    println!("    Discovered {} new intents tokens", new_tokens.len());

    // For each new intents token, insert a snapshot record
    let mut seeded_count = 0;
    for token_id in new_tokens {
        match insert_snapshot_record(pool, network, account_id, &token_id, up_to_block as u64).await
        {
            Ok(_) => {
                log::info!(
                    "Discovered intents token {} for account {}",
                    token_id,
                    account_id
                );
                seeded_count += 1;
            }
            Err(e) => {
                log::warn!(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_monitor_cycle_with_no_accounts() {
        let state = crate::utils::test_utils::init_test_state().await;
        let network = NetworkConfig::mainnet();

        // Should not error with no accounts
        let result = run_monitor_cycle(
            &state.db_pool,
            &network,
            177_000_000,
            state.transfer_hint_service.as_ref(),
            None,
        )
        .await;
        assert!(result.is_ok());
    }
}

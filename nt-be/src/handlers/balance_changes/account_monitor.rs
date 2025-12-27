use near_api::NetworkConfig;
use sqlx::PgPool;
use std::collections::HashSet;

use super::gap_filler::fill_gaps;

/// Run one cycle of monitoring for all enabled accounts
/// 
/// This function:
/// 1. Queries all enabled accounts from monitored_accounts table
/// 2. For each account:
///    - Gets all known tokens for that account from balance_changes
///    - Runs gap filling for each token up to the specified block
///    - Updates last_synced_at timestamp after processing
/// 3. Handles errors gracefully, continuing with next account if one fails
pub async fn run_monitor_cycle(
    pool: &PgPool,
    network: &NetworkConfig,
    up_to_block: i64,
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
        
        // Get all unique tokens for this account (excluding nulls which shouldn't happen but be safe)
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

        // If no tokens are tracked yet, ensure we at least check NEAR balance
        if tokens.is_empty() {
            println!("  {}: No known tokens, will seed NEAR balance", account_id);
            tokens.push("near".to_string());
        }

        println!("  {}: Checking {} tokens", account_id, tokens.len());
        
        let mut processed_tokens = 0;
        let mut errors = Vec::new();

        for token_id in &tokens {
            match fill_gaps(pool, network, account_id, token_id, up_to_block).await {
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
            
            println!("  {}: Updated sync timestamp ({}/{} tokens processed)", 
                     account_id, processed_tokens, tokens.len());
        }

        if !errors.is_empty() {
            eprintln!("  {}: {} errors occurred: {:?}", account_id, errors.len(), errors);
        }
    }

    println!("Monitor cycle complete");
    Ok(())
}

/// Discover new tokens for a monitored account by querying its current balance
/// 
/// This checks the account's current state and adds any tokens with non-zero balances
/// to the monitoring list by inserting initial balance change records.
pub async fn discover_account_tokens(
    pool: &PgPool,
    _network: &NetworkConfig,
    account_id: &str,
    _current_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
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

    println!("Account {} has {} known tokens", account_id, known_tokens.len());
    
    // TODO: Query account's current balances for all tokens
    // This would require:
    // 1. Query FT contracts the account has interacted with
    // 2. Check balance for each token
    // 3. Insert initial balance_change records for new tokens with non-zero balances
    
    // For now, just return 0 as this is a placeholder for Phase 20-22 (Token Discovery)
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_monitor_cycle_with_no_accounts() {
        let state = crate::utils::test_utils::init_test_state().await;
        let network = NetworkConfig::mainnet();
        
        // Should not error with no accounts
        let result = run_monitor_cycle(&state.db_pool, &network, 177_000_000).await;
        assert!(result.is_ok());
    }
}

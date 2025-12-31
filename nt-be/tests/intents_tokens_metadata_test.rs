//! Integration test for intents token metadata discovery
//!
//! Tests that running the monitor cycle discovers and stores metadata for intents tokens
//! by extracting the actual FT contract and querying it.

mod common;

use dotenvy::dotenv;
use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

/// Test that intents token metadata is discovered during monitoring
#[tokio::test]
async fn test_intents_tokens_metadata_discovery() {
    // Load environment variables
    dotenv().ok();

    // Get test database URL
    let db_url = std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL_TEST"))
        .expect("DATABASE_URL or DATABASE_URL_TEST must be set");

    // Connect to database
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to connect to test database");

    // Clear any existing counterparties for the tokens we'll test
    sqlx::query!(
        "DELETE FROM counterparties WHERE account_id LIKE 'intents.near:%'"
    )
    .execute(&pool)
    .await
    .expect("Failed to clear test counterparties");

    // Clear existing balance changes for the test account
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = 'webassemblymusic-treasury.sputnik-dao.near'"
    )
    .execute(&pool)
    .await
    .expect("Failed to clear balance changes");

    // Add the monitored account (enabled by default)
    sqlx::query!(
        "INSERT INTO monitored_accounts (account_id, created_at, enabled)
         VALUES ('webassemblymusic-treasury.sputnik-dao.near', NOW(), true)
         ON CONFLICT (account_id) DO UPDATE SET enabled = true"
    )
    .execute(&pool)
    .await
    .expect("Failed to add monitored account");

    // Run a monitoring cycle - this will:
    // 1. Call snapshot_intents_tokens() to discover intents tokens
    // 2. Insert snapshot records for newly discovered tokens
    // 3. Fill gaps which will call ensure_ft_metadata() for each token
    // 4. ensure_ft_metadata() will extract the actual contract and query metadata

    // Use current block where account has intents tokens
    let up_to_block = 179111593; // Current block with intents tokens

    // Get network config with fastnear API key
    let network = common::create_archival_network();

    println!("Running first monitoring cycle to discover intents tokens...");
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .expect("Failed to run first monitoring cycle");

    println!("\nRunning second monitoring cycle to fetch metadata for discovered tokens...");
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .expect("Failed to run second monitoring cycle");

    // Query all discovered intents token metadata
    let intents_metadata = sqlx::query!(
        r#"
        SELECT account_id, token_symbol, token_name, token_decimals
        FROM counterparties
        WHERE account_id LIKE 'intents.near:%'
        ORDER BY account_id
        "#
    )
    .fetch_all(&pool)
    .await
    .expect("Failed to query intents metadata");

    println!("\n✓ Discovered {} intents tokens:", intents_metadata.len());
    for token in &intents_metadata {
        println!(
            "  - {}: symbol={}, decimals={}",
            token.account_id,
            token.token_symbol.as_deref().unwrap_or("N/A"),
            token.token_decimals.unwrap_or(0)
        );
    }

    // Verify specific tokens we know should be there
    let token_map: std::collections::HashMap<_, _> = intents_metadata
        .iter()
        .map(|t| (t.account_id.as_str(), t))
        .collect();

    // ETH
    if let Some(eth) = token_map.get("intents.near:nep141:eth.omft.near") {
        assert_eq!(eth.token_symbol.as_deref(), Some("ETH"));
        assert_eq!(eth.token_decimals, Some(18));
        println!("✓ ETH metadata correct");
    }

    // BTC
    if let Some(btc) = token_map.get("intents.near:nep141:btc.omft.near") {
        assert_eq!(btc.token_symbol.as_deref(), Some("BTC"));
        assert_eq!(btc.token_decimals, Some(8));
        println!("✓ BTC metadata correct");
    }

    // USDC (optional - not all blocks have this token)
    if let Some(usdc) = token_map.get("intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near") {
        assert_eq!(usdc.token_symbol.as_deref(), Some("USDC"));
        assert_eq!(usdc.token_decimals, Some(6));
        println!("✓ USDC metadata correct");
    }

    // Verify we discovered a reasonable number of tokens
    assert!(
        intents_metadata.len() >= 3,
        "Should have discovered at least 3 intents tokens (found {})",
        intents_metadata.len()
    );

    pool.close().await;
}

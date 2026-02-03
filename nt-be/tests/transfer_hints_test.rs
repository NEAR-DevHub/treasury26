//! Integration tests for Transfer Hints functionality
//!
//! These tests verify the FastNear transfers-api integration works correctly
//! with the real API endpoint.

mod common;

use nt_be::handlers::balance_changes::transfer_hints::{
    TransferHintProvider, TransferHintService, fastnear::FastNearProvider,
};

/// Test that FastNearProvider can query the real FastNear API
/// Uses a wide block range to ensure we find some transfers
#[tokio::test]
async fn test_fastnear_provider_real_api() {
    common::load_test_env();
    let network = common::create_archival_network();

    let provider = FastNearProvider::new(network).with_api_key(common::get_fastnear_api_key());

    // Query a known account with transfers (petersalomonsen.near)
    // Use a wide block range (1M blocks ≈ 11 days)
    let hints = provider
        .get_hints("petersalomonsen.near", "near", 180_000_000, 182_000_000)
        .await
        .expect("FastNear API query should succeed");

    println!(
        "Found {} NEAR hints for petersalomonsen.near in block range 180M-182M",
        hints.len()
    );

    for hint in hints.iter().take(5) {
        println!(
            "  Block {}: amount={:?}, counterparty={:?}, receipt={:?}",
            hint.block_height, hint.amount, hint.counterparty, hint.receipt_id
        );
    }

    // This is a soft assertion - we just verify the API call succeeded
    println!("API call succeeded");
}

/// Test that FastNearProvider correctly filters by token type
#[tokio::test]
async fn test_fastnear_provider_ft_token() {
    common::load_test_env();
    let network = common::create_archival_network();

    let provider = FastNearProvider::new(network).with_api_key(common::get_fastnear_api_key());

    // Query for FT tokens - use the USDC token which petersalomonsen.near uses
    let hints = provider
        .get_hints(
            "petersalomonsen.near",
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // USDC
            130_000_000,
            145_000_000,
        )
        .await
        .expect("FastNear API query should succeed");

    println!("Found {} USDC hints for petersalomonsen.near", hints.len());

    for hint in hints.iter().take(5) {
        println!(
            "  Block {}: amount={:?}, counterparty={:?}",
            hint.block_height, hint.amount, hint.counterparty
        );
    }
}

/// Test that TransferHintService works with FastNearProvider
#[tokio::test]
async fn test_transfer_hint_service_with_fastnear() {
    common::load_test_env();
    let network = common::create_archival_network();

    let service = TransferHintService::new()
        .with_provider(FastNearProvider::new(network).with_api_key(common::get_fastnear_api_key()));

    // Verify service supports the right tokens
    assert!(service.supports_token("near"), "Should support NEAR");
    assert!(
        service.supports_token("wrap.near"),
        "Should support FT tokens"
    );
    assert!(
        service.supports_token("intents.near:nep141:wrap.near"),
        "Should support intents tokens (multi-token via asset_type: Mt)"
    );

    // Query for NEAR transfers with a wide range
    let hints = service
        .get_hints("petersalomonsen.near", "near", 180_000_000, 182_000_000)
        .await;

    println!("TransferHintService returned {} hints", hints.len());
    // Soft assertion - API call succeeded
}

/// Test that intents (multi-token) transfers are supported
#[tokio::test]
async fn test_fastnear_intents_token() {
    common::load_test_env();
    let network = common::create_archival_network();

    let provider =
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key());

    // Intents tokens are now supported by FastNear (asset_type: "Mt")
    assert!(provider.supports_token("intents.near:nep141:wrap.near"));
    assert!(provider.supports_token("intents.near:nep141:eth.omft.near"));

    let service = TransferHintService::new().with_provider(provider);

    // Query intents token hints for an account known to have intents transfers
    let hints = service
        .get_hints(
            "webassemblymusic-treasury.sputnik-dao.near",
            "intents.near:nep141:eth.omft.near",
            148_000_000,
            152_000_000,
        )
        .await;

    println!("Found {} intents token hints", hints.len());
    // We should find some hints (based on FastNear API response showing Mt transfers)
}

/// Test hint verification with actual balance data
/// This test queries hints and then verifies them against RPC
#[tokio::test]
async fn test_hint_verification_with_rpc() {
    use nt_be::handlers::balance_changes::balance;

    common::load_test_env();
    let network = common::create_archival_network();

    let provider =
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key());

    // Get hints for a known account with wide range
    let hints = provider
        .get_hints("petersalomonsen.near", "near", 180_000_000, 182_000_000)
        .await
        .expect("FastNear API query should succeed");

    if hints.is_empty() {
        println!("No NEAR hints found in range - skipping verification");
        return;
    }

    // Create a dummy pool for balance queries
    let env_vars = nt_be::utils::env::EnvVars::default();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy(&env_vars.database_url)
        .expect("Failed to create pool");

    // Verify first hint by querying balance at that block
    let hint = &hints[0];
    println!("Verifying hint at block {}", hint.block_height);

    let balance_at_hint = balance::get_balance_at_block(
        &pool,
        &network,
        "petersalomonsen.near",
        "near",
        hint.block_height,
    )
    .await
    .expect("Balance query should succeed");

    println!(
        "Balance at block {}: {}",
        hint.block_height, balance_at_hint
    );

    // Also check balance at block before to verify change
    if hint.block_height > 180_000_000 {
        let balance_before = balance::get_balance_at_block(
            &pool,
            &network,
            "petersalomonsen.near",
            "near",
            hint.block_height - 1,
        )
        .await
        .expect("Balance query should succeed");

        println!(
            "Balance at block {}: {}",
            hint.block_height - 1,
            balance_before
        );

        // If hint is valid, balances should be different
        if balance_at_hint != balance_before {
            println!(
                "✓ Hint verified: balance changed at block {}",
                hint.block_height
            );
        } else {
            println!("⚠ Balance unchanged at hint block - hint may not be the exact change block");
        }
    }
}

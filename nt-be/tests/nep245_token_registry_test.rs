//! Test NEP-245 token registry lookup
//!
//! Verifies that the token registry can find tokens by their defuseAssetId,
//! especially NEP-245 multi-token IDs that contain colons.

use nt_be::constants::intents_tokens;

#[test]
fn test_nep245_token_lookup() {
    // Test NEP-245 tokens with colons in their IDs
    let test_cases = vec![
        (
            "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
            "USDC",
            6,
        ),
        (
            "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",
            "USDC",
            18,
        ),
        (
            "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
            "USDC",
            6,
        ),
        (
            "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
            "USDC",
            6,
        ),
    ];

    for (defuse_asset_id, expected_symbol, expected_decimals) in test_cases {
        let token = intents_tokens::find_token_by_defuse_asset_id(defuse_asset_id);
        assert!(
            token.is_some(),
            "Token not found for defuseAssetId: {}",
            defuse_asset_id
        );

        let token = token.unwrap();
        assert_eq!(
            token.symbol, expected_symbol,
            "Symbol mismatch for {}",
            defuse_asset_id
        );
        assert_eq!(
            token.decimals, expected_decimals,
            "Decimals mismatch for {}",
            defuse_asset_id
        );
    }

    println!("✓ All NEP-245 token lookups successful");
}

#[test]
fn test_nep141_token_lookup() {
    // Test NEP-141 tokens (should also work)
    let test_cases = vec![
        ("nep141:wrap.near", "NEAR", 24),
        ("nep141:eth.omft.near", "ETH", 18),
        ("nep141:btc.omft.near", "BTC", 8),
    ];

    for (defuse_asset_id, expected_symbol, expected_decimals) in test_cases {
        let token = intents_tokens::find_token_by_defuse_asset_id(defuse_asset_id);
        assert!(
            token.is_some(),
            "Token not found for defuseAssetId: {}",
            defuse_asset_id
        );

        let token = token.unwrap();
        assert_eq!(
            token.symbol, expected_symbol,
            "Symbol mismatch for {}",
            defuse_asset_id
        );
        assert_eq!(
            token.decimals, expected_decimals,
            "Decimals mismatch for {}",
            defuse_asset_id
        );
    }

    println!("✓ All NEP-141 token lookups successful");
}

#[test]
fn test_token_not_found() {
    // Test that non-existent tokens return None
    let token = intents_tokens::find_token_by_defuse_asset_id("nep245:nonexistent:token");
    assert!(token.is_none(), "Should return None for non-existent token");

    println!("✓ Non-existent token returns None as expected");
}

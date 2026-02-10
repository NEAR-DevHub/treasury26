use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    constants::intents_tokens::{TokenDeployment, get_tokens_map},
    utils::cache::CacheTier,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTokensQuery {
    pub token_in: Option<String>,
    pub token_out: Option<String>,
    pub intents_token_contract_id: Option<String>,
    pub destination_network: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub chain_id: String,
    pub chain_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_address: Option<String>,
    pub decimals: u8,
    pub bridge: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenSearchResult {
    pub defuse_asset_id: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    pub icon: String,
    pub origin_chain_name: String,
    pub unified_asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_info: Option<NetworkInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchTokensResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_in: Option<TokenSearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_out: Option<TokenSearchResult>,
}

/// Search for tokenIn with intentsTokenContractId matching
fn search_token_in(
    query: &str,
    intents_token_contract_id: Option<&str>,
) -> Option<TokenSearchResult> {
    let query_lower = query.to_lowercase();
    let tokens_map = get_tokens_map();

    // Remove "nep141:" prefix if present for matching
    let contract_id_clean = intents_token_contract_id.map(|c| c.replace("nep141:", ""));

    // Search through all unified tokens
    for (_, unified_token) in tokens_map.iter() {
        // Search through grouped tokens
        for base_token in &unified_token.grouped_tokens {
            // Check if symbol or name matches
            if base_token.symbol.to_lowercase() != query_lower
                && base_token.name.to_lowercase() != query_lower
            {
                continue;
            }

            // If contract ID is provided, try to match the deployment
            if let Some(ref contract_id) = contract_id_clean {
                // Check if this base token has a deployment matching the contract ID
                let has_matching_deployment =
                    base_token
                        .deployments
                        .iter()
                        .any(|deployment| match deployment {
                            TokenDeployment::Native { chain_name, .. } => chain_name == contract_id,
                            TokenDeployment::Fungible { address, .. } => address == contract_id,
                        });

                // If contract ID provided but this token doesn't have matching deployment, skip it
                if !has_matching_deployment {
                    continue;
                }

                // Find the network info for the matching deployment
                let network_info =
                    base_token
                        .deployments
                        .iter()
                        .find_map(|deployment| match deployment {
                            TokenDeployment::Native {
                                chain_name,
                                decimals,
                                bridge,
                                ..
                            } => {
                                if chain_name == contract_id {
                                    Some(NetworkInfo {
                                        chain_id: chain_name.clone(),
                                        chain_name: chain_name.clone(),
                                        contract_address: None,
                                        decimals: *decimals,
                                        bridge: bridge.clone(),
                                    })
                                } else {
                                    None
                                }
                            }
                            TokenDeployment::Fungible {
                                address,
                                chain_name,
                                decimals,
                                bridge,
                                ..
                            } => {
                                if address == contract_id {
                                    Some(NetworkInfo {
                                        chain_id: format!("nep141:{}", address),
                                        chain_name: chain_name.clone(),
                                        contract_address: Some(address.clone()),
                                        decimals: *decimals,
                                        bridge: bridge.clone(),
                                    })
                                } else {
                                    None
                                }
                            }
                        });

                return Some(TokenSearchResult {
                    defuse_asset_id: base_token.defuse_asset_id.clone(),
                    symbol: base_token.symbol.clone(),
                    name: base_token.name.clone(),
                    decimals: base_token.decimals,
                    icon: base_token.icon.clone(),
                    origin_chain_name: base_token.origin_chain_name.clone(),
                    unified_asset_id: unified_token.unified_asset_id.clone(),
                    network_info,
                });
            } else {
                // No contract ID filter, return first match
                return Some(TokenSearchResult {
                    defuse_asset_id: base_token.defuse_asset_id.clone(),
                    symbol: base_token.symbol.clone(),
                    name: base_token.name.clone(),
                    decimals: base_token.decimals,
                    icon: base_token.icon.clone(),
                    origin_chain_name: base_token.origin_chain_name.clone(),
                    unified_asset_id: unified_token.unified_asset_id.clone(),
                    network_info: None,
                });
            }
        }
    }

    None
}

/// Search for tokenOut with destinationNetwork (chainId) matching
fn search_token_out(query: &str, destination_network: Option<&str>) -> Option<TokenSearchResult> {
    let mut query_lower = query.to_lowercase();
    if query_lower == "wnear" {
        query_lower = "near".to_string();
    }
    let tokens_map = get_tokens_map();

    // Search through all unified tokens
    for (_, unified_token) in tokens_map.iter() {
        // Search through grouped tokens
        for base_token in &unified_token.grouped_tokens {
            // Check if symbol or name matches
            if base_token.symbol.to_lowercase() == query_lower
                || base_token.name.to_lowercase() == query_lower
            {
                // Find the network deployment matching the destination network (chainId)
                let network_info = if let Some(chain_id) = destination_network {
                    base_token.deployments.iter().find_map(|deployment| {
                        match deployment {
                            TokenDeployment::Native {
                                chain_name,
                                decimals,
                                bridge,
                                ..
                            } => {
                                // For native tokens, chainId is the chain name
                                if chain_name == chain_id {
                                    Some(NetworkInfo {
                                        chain_id: chain_name.clone(),
                                        chain_name: chain_name.clone(),
                                        contract_address: None,
                                        decimals: *decimals,
                                        bridge: bridge.clone(),
                                    })
                                } else {
                                    None
                                }
                            }
                            TokenDeployment::Fungible {
                                address,
                                chain_name,
                                decimals,
                                bridge,
                                ..
                            } => {
                                // For fungible tokens, chainId could be the chain name
                                if chain_name == chain_id {
                                    Some(NetworkInfo {
                                        chain_id: chain_name.clone(),
                                        chain_name: chain_name.clone(),
                                        contract_address: Some(address.clone()),
                                        decimals: *decimals,
                                        bridge: bridge.clone(),
                                    })
                                } else {
                                    None
                                }
                            }
                        }
                    })
                } else {
                    None
                };

                return Some(TokenSearchResult {
                    defuse_asset_id: base_token.defuse_asset_id.clone(),
                    symbol: base_token.symbol.clone(),
                    name: base_token.name.clone(),
                    decimals: base_token.decimals,
                    icon: base_token.icon.clone(),
                    origin_chain_name: base_token.origin_chain_name.clone(),
                    unified_asset_id: unified_token.unified_asset_id.clone(),
                    network_info,
                });
            }
        }
    }

    None
}

/// Handler for searching intents tokens by symbol or name with network information
///
/// Query parameters:
/// - tokenIn: Optional token symbol or name to search for (input token)
/// - tokenOut: Optional token symbol or name to search for (output token)
/// - intentsTokenContractId: Contract ID to match for tokenIn network
/// - destinationNetwork: Chain ID to match for tokenOut network
///
/// Returns matching tokens with their defuse asset IDs, metadata, and network info
pub async fn search_tokens(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchTokensQuery>,
) -> Result<Json<SearchTokensResponse>, (StatusCode, String)> {
    // Build cache key from search params
    let cache_key = format!(
        "token-search:{}:{}:{}:{}",
        params.token_in.as_deref().unwrap_or(""),
        params.token_out.as_deref().unwrap_or(""),
        params.intents_token_contract_id.as_deref().unwrap_or(""),
        params.destination_network.as_deref().unwrap_or("")
    );

    let result = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Search for tokenIn if provided
            let token_in_result = params.token_in.as_ref().and_then(|query| {
                search_token_in(query, params.intents_token_contract_id.as_deref())
            });

            // Search for tokenOut if provided
            let token_out_result = params
                .token_out
                .as_ref()
                .and_then(|query| search_token_out(query, params.destination_network.as_deref()));

            Ok::<_, (StatusCode, String)>(SearchTokensResponse {
                token_in: token_in_result,
                token_out: token_out_result,
            })
        })
        .await?;

    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_search_token_in_by_symbol() {
        // Test searching for tokenIn by symbol
        let result = search_token_in(
            "USDC",
            Some("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
        );

        assert!(result.is_some(), "Should find USDC token by symbol");

        let token = result.unwrap();
        println!("Found token: {:?}", token);

        assert_eq!(token.symbol, "USDC", "Token symbol should be USDC");
        assert!(
            !token.defuse_asset_id.is_empty(),
            "Should have defuse asset ID"
        );
        assert!(
            token.network_info.is_some(),
            "Should have network info when contract ID provided"
        );

        if let Some(network) = &token.network_info {
            assert!(!network.chain_name.is_empty(), "Should have chain name");
            assert_eq!(network.decimals, 6, "USDC should have 6 decimals");
        }
    }

    #[test]
    fn test_search_token_in_by_name() {
        // Test searching for tokenIn by name
        let result = search_token_in(
            "USD Coin",
            Some("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
        );

        assert!(result.is_some(), "Should find USD Coin token by name");

        let token = result.unwrap();
        println!("Found token by name: {:?}", token);

        assert_eq!(token.name, "USD Coin", "Token name should be USD Coin");
        assert_eq!(token.symbol, "USDC", "Token symbol should be USDC");
        assert!(token.network_info.is_some(), "Should have network info");
    }

    #[test]
    fn test_search_token_out_by_symbol() {
        // Test searching for tokenOut by symbol with chain ID
        let result = search_token_out("NEAR", Some("near"));

        assert!(result.is_some(), "Should find NEAR token by symbol");

        let token = result.unwrap();
        println!("Found token: {:?}", token);

        assert_eq!(token.symbol, "NEAR", "Token symbol should be NEAR");
        assert!(token.network_info.is_some(), "Should have network info");

        if let Some(network) = &token.network_info {
            assert_eq!(network.chain_id, "near", "Chain ID should be 'near'");
            assert_eq!(network.chain_name, "near", "Chain name should be 'near'");
        }
    }

    #[test]
    fn test_search_token_out_by_name() {
        // Test searching for tokenOut by name
        let result = search_token_out("Near", Some("near"));

        assert!(result.is_some(), "Should find NEAR token by name");

        let token = result.unwrap();
        println!("Found token by name: {:?}", token);

        assert!(
            token.name.to_lowercase().contains("near"),
            "Token name should contain 'near'"
        );
        assert_eq!(token.symbol, "NEAR", "Token symbol should be NEAR");
    }

    #[test]
    fn test_search_token_in_without_network() {
        // Test searching without network info
        let result = search_token_in("USDC", None);

        assert!(
            result.is_some(),
            "Should find token even without network filter"
        );

        let token = result.unwrap();
        println!("Found token without network: {:?}", token);

        assert_eq!(token.symbol, "USDC", "Should still find USDC");
        assert!(
            token.network_info.is_none(),
            "Network info should be None when not provided"
        );
    }

    #[test]
    fn test_search_nonexistent_token() {
        // Test searching for a token that doesn't exist
        let result = search_token_in("NONEXISTENT", Some("some-contract"));

        assert!(result.is_none(), "Should not find nonexistent token");
    }

    #[test]
    fn test_case_insensitive_search() {
        // Test that search is case-insensitive
        let result1 = search_token_in(
            "usdc",
            Some("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
        );
        let result2 = search_token_in(
            "USDC",
            Some("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
        );
        let result3 = search_token_in(
            "UsDc",
            Some("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
        );

        assert!(result1.is_some(), "Should find token with lowercase");
        assert!(result2.is_some(), "Should find token with uppercase");
        assert!(result3.is_some(), "Should find token with mixed case");

        // All three should find the same token
        let t1 = result1.unwrap();
        let t2 = result2.unwrap();
        let t3 = result3.unwrap();

        assert_eq!(
            t1.defuse_asset_id, t2.defuse_asset_id,
            "Lowercase and uppercase should find same token"
        );
        assert_eq!(
            t2.defuse_asset_id, t3.defuse_asset_id,
            "All cases should find same token"
        );
        assert_eq!(t1.symbol, "USDC", "Symbol should be normalized to USDC");

        println!(
            "Case-insensitive search works correctly for: {}",
            t1.defuse_asset_id
        );
    }

    #[test]
    fn test_search_with_nep141_prefix() {
        // Test searching with nep141: prefix in contract ID
        let result = search_token_in(
            "USDC",
            Some("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
        );

        assert!(
            result.is_some(),
            "Should handle nep141: prefix in contract ID"
        );

        let token = result.unwrap();
        println!("Found token with nep141 prefix: {:?}", token);

        assert_eq!(token.symbol, "USDC", "Should find USDC with nep141 prefix");
        assert!(
            token.network_info.is_some(),
            "Should have network info with nep141 prefix"
        );
    }
}

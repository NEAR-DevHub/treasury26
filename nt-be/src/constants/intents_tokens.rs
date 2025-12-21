use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Represents the root of the tokens.json file
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokensJson {
    #[serde(rename = "$schema")]
    pub schema: Option<String>,
    pub tokens: Vec<TokenInfo>,
}

/// Represents either a unified token or a base token
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum TokenInfo {
    Unified(UnifiedTokenInfo),
    Base(BaseTokenInfo),
}

/// A virtual aggregation of the same token across multiple blockchains
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UnifiedTokenInfo {
    #[serde(rename = "unifiedAssetId")]
    pub unified_asset_id: String,
    pub symbol: String,
    pub name: String,
    pub icon: String,
    #[serde(rename = "groupedTokens")]
    pub grouped_tokens: Vec<BaseTokenInfo>,
    pub tags: Option<Vec<String>>,
}

/// One token recognized by NEAR Intents
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BaseTokenInfo {
    #[serde(rename = "defuseAssetId")]
    pub defuse_asset_id: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    pub icon: String,
    #[serde(rename = "originChainName")]
    pub origin_chain_name: String,
    pub deployments: Vec<TokenDeployment>,
    pub tags: Option<Vec<String>>,
}

/// Represents a deployment of a token on a specific chain
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum TokenDeployment {
    Native {
        #[serde(rename = "type")]
        kind: String, // "native"
        decimals: u8,
        #[serde(rename = "chainName")]
        chain_name: String,
        bridge: String,
    },
    Fungible {
        address: String,
        decimals: u8,
        #[serde(rename = "chainName")]
        chain_name: String,
        bridge: String,
        #[serde(rename = "stellarCode")]
        stellar_code: Option<String>,
    },
}

/// Flattened version of token information for easy use in the backend
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalTokenInfo {
    pub defuse_asset_id: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    pub icon: String,
    pub origin_chain_name: String,
    pub address: String,
    pub bridge: String,
    pub tags: Vec<String>,
    pub unified_asset_id: Option<String>,
}

/// Static map of tokens loaded from data/tokens.json for fast lookup
static TOKENS_MAP_CELL: OnceLock<HashMap<String, LocalTokenInfo>> = OnceLock::new();

/// Get the map of tokens, loading from JSON if not already loaded
pub fn get_tokens_map() -> &'static HashMap<String, LocalTokenInfo> {
    TOKENS_MAP_CELL.get_or_init(|| {
        let tokens = load_tokens_from_json().unwrap_or_else(|e| {
            eprintln!("Failed to load tokens from JSON: {}", e);
            vec![]
        });
        tokens
            .into_iter()
            .map(|t| (t.defuse_asset_id.to_lowercase(), t))
            .collect()
    })
}

/// Find a token by its defuse_asset_id
pub fn find_token_by_defuse_asset_id(defuse_asset_id: &str) -> Option<LocalTokenInfo> {
    get_tokens_map()
        .get(&defuse_asset_id.to_lowercase())
        .cloned()
}

/// Load tokens from the JSON file and flatten them
fn load_tokens_from_json() -> Result<Vec<LocalTokenInfo>, Box<dyn std::error::Error>> {
    let json_str = include_str!("../../data/tokens.json");
    let tokens_json: TokensJson = serde_json::from_str(json_str)?;

    let mut result = Vec::new();

    for token_info in tokens_json.tokens {
        match token_info {
            TokenInfo::Base(base) => {
                result.push(convert_base_to_local(base, None));
            }
            TokenInfo::Unified(unified) => {
                for base in unified.grouped_tokens {
                    result.push(convert_base_to_local(
                        base,
                        Some(unified.unified_asset_id.clone()),
                    ));
                }
            }
        }
    }

    Ok(result)
}

/// Convert BaseTokenInfo to LocalTokenInfo
fn convert_base_to_local(base: BaseTokenInfo, unified_asset_id: Option<String>) -> LocalTokenInfo {
    // We take the first deployment as the primary one for the backend simplified view
    let (address, bridge) = if let Some(deployment) = base.deployments.first() {
        match deployment {
            TokenDeployment::Native { .. } => ("native".to_string(), "poa".to_string()),
            TokenDeployment::Fungible {
                address, bridge, ..
            } => (address.clone(), bridge.clone()),
        }
    } else {
        ("native".to_string(), "direct".to_string())
    };

    LocalTokenInfo {
        defuse_asset_id: base.defuse_asset_id,
        symbol: base.symbol,
        name: base.name,
        decimals: base.decimals,
        icon: base.icon,
        origin_chain_name: base.origin_chain_name,
        address,
        bridge,
        tags: base.tags.unwrap_or_default(),
        unified_asset_id,
    }
}

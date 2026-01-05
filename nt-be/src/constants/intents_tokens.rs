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

/// Static map of unified tokens loaded from data/tokens.json for fast lookup
static TOKENS_MAP_CELL: OnceLock<HashMap<String, UnifiedTokenInfo>> = OnceLock::new();

/// Static map of base tokens by defuseAssetId for fast lookup
static DEFUSE_TOKENS_MAP_CELL: OnceLock<HashMap<String, BaseTokenInfo>> = OnceLock::new();

/// Get the map of unified tokens, loading from JSON if not already loaded
pub fn get_tokens_map() -> &'static HashMap<String, UnifiedTokenInfo> {
    TOKENS_MAP_CELL.get_or_init(|| {
        let tokens = load_tokens_from_json().unwrap_or_else(|e| {
            eprintln!("Failed to load tokens from JSON: {}", e);
            vec![]
        });
        tokens
            .into_iter()
            .map(|t| (t.unified_asset_id.to_lowercase(), t))
            .collect()
    })
}

/// Get the map of base tokens by defuseAssetId, loading from JSON if not already loaded
pub fn get_defuse_tokens_map() -> &'static HashMap<String, BaseTokenInfo> {
    DEFUSE_TOKENS_MAP_CELL.get_or_init(|| {
        let tokens = load_tokens_from_json().unwrap_or_else(|e| {
            eprintln!("Failed to load tokens from JSON: {}", e);
            vec![]
        });

        let mut map = HashMap::new();
        for unified_token in tokens {
            for base_token in unified_token.grouped_tokens {
                map.insert(base_token.defuse_asset_id.clone(), base_token);
            }
        }
        map
    })
}

/// Find a token by its defuse_asset_id
pub fn find_token_by_unified_asset_id(unified_asset_id: &str) -> Option<UnifiedTokenInfo> {
    get_tokens_map()
        .get(&unified_asset_id.to_lowercase())
        .cloned()
}

/// Find a base token by its defuseAssetId (e.g., "nep141:wrap.near" or "nep245:v2_1.omni.hot.tg:137_...")
pub fn find_token_by_defuse_asset_id(defuse_asset_id: &str) -> Option<&'static BaseTokenInfo> {
    get_defuse_tokens_map().get(defuse_asset_id)
}

/// Load tokens from the JSON file as unified tokens
fn load_tokens_from_json() -> Result<Vec<UnifiedTokenInfo>, Box<dyn std::error::Error>> {
    let json_str = include_str!("../../data/tokens.json");
    let tokens_json: TokensJson = serde_json::from_str(json_str)?;

    let mut result = Vec::new();

    for token_info in tokens_json.tokens {
        match token_info {
            TokenInfo::Base(base) => {
                // Create a single-entity unified token from a base token
                let unified = UnifiedTokenInfo {
                    unified_asset_id: base.symbol.to_lowercase(),
                    symbol: base.symbol.clone(),
                    name: base.name.clone(),
                    icon: base.icon.clone(),
                    grouped_tokens: vec![base],
                    tags: None,
                };
                result.push(unified);
            }
            TokenInfo::Unified(unified) => {
                // Use the existing unified token as-is
                result.push(unified);
            }
        }
    }

    Ok(result)
}

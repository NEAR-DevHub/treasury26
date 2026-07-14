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
#[serde(rename_all = "camelCase")]
pub struct UnifiedTokenInfo {
    pub unified_asset_id: String,
    pub symbol: String,
    pub name: String,
    pub icon: String,
    pub grouped_tokens: Vec<BaseTokenInfo>,
    pub tags: Option<Vec<String>>,
}

/// One token recognized by NEAR Intents
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BaseTokenInfo {
    pub defuse_asset_id: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    pub icon: String,
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

/// Static map of defuse_asset_id -> unified_asset_id for reverse lookup
static DEFUSE_TO_UNIFIED_MAP_CELL: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Static map of unified tokens by lowercase symbol for fast lookup
static SYMBOL_TOKENS_MAP_CELL: OnceLock<HashMap<String, UnifiedTokenInfo>> = OnceLock::new();

/// Static multi-map of base tokens by defuseAssetId (preserves duplicates)
static DEFUSE_TOKENS_MULTI_MAP_CELL: OnceLock<HashMap<String, Vec<BaseTokenInfo>>> =
    OnceLock::new();

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
                // or_insert so unified tokens (processed first) take priority
                // over synthetic standalone duplicates (e.g. "AURORA" wins over
                // "AURORA (omni)" when both share the same defuseAssetId).
                map.entry(base_token.defuse_asset_id.clone())
                    .or_insert(base_token);
            }
        }
        map
    })
}

/// Get the map of unified tokens by lowercase symbol, loading from JSON if not already loaded
pub fn get_symbol_tokens_map() -> &'static HashMap<String, UnifiedTokenInfo> {
    SYMBOL_TOKENS_MAP_CELL.get_or_init(|| {
        let tokens = load_tokens_from_json().unwrap_or_else(|e| {
            eprintln!("Failed to load tokens from JSON: {}", e);
            vec![]
        });
        tokens
            .into_iter()
            .map(|t| (t.symbol.to_lowercase(), t))
            .collect()
    })
}

/// Find a token by its lowercase symbol
pub fn find_token_by_symbol(symbol: &str) -> Option<UnifiedTokenInfo> {
    get_symbol_tokens_map().get(&symbol.to_lowercase()).cloned()
}

/// Find a base token by its defuseAssetId (e.g., "nep141:wrap.near" or "nep245:v2_1.omni.hot.tg:137_...")
pub fn find_token_by_defuse_asset_id(defuse_asset_id: &str) -> Option<&'static BaseTokenInfo> {
    get_defuse_tokens_map().get(defuse_asset_id)
}

/// Find all base tokens sharing the same defuseAssetId.
pub fn find_tokens_by_defuse_asset_id(defuse_asset_id: &str) -> Vec<&'static BaseTokenInfo> {
    get_defuse_tokens_multi_map()
        .get(defuse_asset_id)
        .map(|v| v.iter().collect())
        .unwrap_or_default()
}

/// Find the best base token for a defuseAssetId by matching deployment address.
///
/// If multiple entries share a defuseAssetId, this uses deployment addresses to disambiguate.
/// Falls back to the first entry when no address matches.
pub fn find_token_by_defuse_asset_id_and_address(
    defuse_asset_id: &str,
    address_candidates: &[String],
) -> Option<&'static BaseTokenInfo> {
    let tokens = get_defuse_tokens_multi_map().get(defuse_asset_id)?;
    if tokens.is_empty() {
        return None;
    }
    if address_candidates.is_empty() {
        return tokens.first();
    }

    for token in tokens {
        for deployment in &token.deployments {
            if let TokenDeployment::Fungible { address, .. } = deployment
                && address_candidates
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(address))
            {
                return Some(token);
            }
        }
    }

    tokens.first()
}

/// Get the map of defuse_asset_id -> unified_asset_id for reverse lookup
pub fn get_defuse_to_unified_map() -> &'static HashMap<String, String> {
    DEFUSE_TO_UNIFIED_MAP_CELL.get_or_init(|| {
        let tokens = load_tokens_from_json().unwrap_or_else(|e| {
            eprintln!("Failed to load tokens from JSON: {}", e);
            vec![]
        });

        let mut map = HashMap::new();
        for unified_token in tokens {
            for base_token in &unified_token.grouped_tokens {
                // or_insert so unified tokens (processed first) take priority
                // over synthetic entries from standalone base tokens
                map.entry(base_token.defuse_asset_id.clone())
                    .or_insert_with(|| unified_token.unified_asset_id.clone());
            }
        }
        map
    })
}

/// Get the multimap of defuseAssetId -> all matching base tokens.
pub fn get_defuse_tokens_multi_map() -> &'static HashMap<String, Vec<BaseTokenInfo>> {
    DEFUSE_TOKENS_MULTI_MAP_CELL.get_or_init(|| {
        let tokens = load_tokens_from_json().unwrap_or_else(|e| {
            eprintln!("Failed to load tokens from JSON: {}", e);
            vec![]
        });

        let mut map: HashMap<String, Vec<BaseTokenInfo>> = HashMap::new();
        for unified_token in tokens {
            for base_token in unified_token.grouped_tokens {
                map.entry(base_token.defuse_asset_id.clone())
                    .or_default()
                    .push(base_token);
            }
        }
        map
    })
}

/// Find the unified_asset_id for a given defuse_asset_id
pub fn find_unified_asset_id(defuse_asset_id: &str) -> Option<&'static str> {
    get_defuse_to_unified_map()
        .get(defuse_asset_id)
        .map(|s| s.as_str())
}

/// Load tokens from the JSON file as unified tokens.
/// Unified tokens are processed first so they take priority over standalone base tokens
/// that share the same defuse_asset_id.
fn load_tokens_from_json() -> Result<Vec<UnifiedTokenInfo>, Box<dyn std::error::Error>> {
    let json_str = include_str!("../../data/tokens.json");
    let tokens_json: TokensJson = serde_json::from_str(json_str)?;

    let mut unified_tokens = Vec::new();
    let mut base_tokens = Vec::new();

    for token_info in tokens_json.tokens {
        match token_info {
            TokenInfo::Unified(unified) => unified_tokens.push(unified),
            TokenInfo::Base(base) => base_tokens.push(base),
        }
    }

    // Unified tokens first so their defuse_asset_id mappings take priority
    let mut result: Vec<UnifiedTokenInfo> = unified_tokens;

    for base in base_tokens {
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

    Ok(result)
}

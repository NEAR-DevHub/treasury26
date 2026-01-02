use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const ICON_PREFIX: &str = "https://near-intents.org/static/icons/network/";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainIcons {
    pub dark: String,
    pub light: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainMetadata {
    pub name: String,
    pub icon: ChainIcons,
}

impl ChainIcons {
    pub fn new(dark_suffix: &str, light_suffix: &str) -> Self {
        Self {
            dark: format!("{}{}", ICON_PREFIX, dark_suffix),
            light: format!("{}{}", ICON_PREFIX, light_suffix),
        }
    }
}

impl ChainMetadata {
    pub fn new(name: &str, dark_suffix: &str, light_suffix: &str) -> Self {
        Self {
            name: name.to_string(),
            icon: ChainIcons::new(dark_suffix, light_suffix),
        }
    }
}

pub static CHAIN_METADATA: Lazy<HashMap<String, ChainMetadata>> = Lazy::new(|| {
    let mut metadata = HashMap::new();

    metadata.insert(
        "eth".to_string(),
        ChainMetadata::new("Ethereum", "ethereum_white.svg", "ethereum.svg"),
    );
    metadata.insert(
        "near".to_string(),
        ChainMetadata::new("Near Protocol", "near.svg", "near_dark.svg"),
    );
    metadata.insert(
        "base".to_string(),
        ChainMetadata::new("Base", "base.svg", "base.svg"),
    );
    metadata.insert(
        "arbitrum".to_string(),
        ChainMetadata::new("Arbitrum", "arbitrum.svg", "arbitrum.svg"),
    );
    metadata.insert(
        "bitcoin".to_string(),
        ChainMetadata::new("Bitcoin", "btc.svg", "btc.svg"),
    );
    metadata.insert(
        "solana".to_string(),
        ChainMetadata::new("Solana", "solana.svg", "solana.svg"),
    );
    metadata.insert(
        "dogecoin".to_string(),
        ChainMetadata::new("Dogecoin", "dogecoin.svg", "dogecoin.svg"),
    );
    metadata.insert(
        "turbochain".to_string(),
        ChainMetadata::new("TurboChain", "turbochain.png", "turbochain.png"),
    );
    metadata.insert(
        "tuxappchain".to_string(),
        ChainMetadata::new("TuxaChain", "tuxappchain.svg", "tuxappchain.svg"),
    );
    metadata.insert(
        "vertex".to_string(),
        ChainMetadata::new("Vertex", "vertex.svg", "vertex.svg"),
    );
    metadata.insert(
        "optima".to_string(),
        ChainMetadata::new("Optima", "optima.svg", "optima.svg"),
    );
    metadata.insert(
        "easychain".to_string(),
        ChainMetadata::new("EasyChain", "easychain.svg", "easychain.svg"),
    );
    metadata.insert(
        "aurora".to_string(),
        ChainMetadata::new("Aurora", "aurora.svg", "aurora.svg"),
    );
    metadata.insert(
        "aurora_devnet".to_string(),
        ChainMetadata::new("Aurora Devnet", "aurora_devnet.svg", "aurora_devnet.svg"),
    );
    metadata.insert(
        "xrpledger".to_string(),
        ChainMetadata::new("XRP Ledger", "xrpledger_white.svg", "xrpledger.svg"),
    );
    metadata.insert(
        "zcash".to_string(),
        ChainMetadata::new("Zcash", "zcash.svg", "zcash-icon-black.svg"),
    );
    metadata.insert(
        "gnosis".to_string(),
        ChainMetadata::new("Gnosis", "gnosis_white.svg", "gnosis.svg"),
    );
    metadata.insert(
        "berachain".to_string(),
        ChainMetadata::new("BeraChain", "berachain.svg", "berachain.svg"),
    );
    metadata.insert(
        "tron".to_string(),
        ChainMetadata::new("Tron", "tron.svg", "tron.svg"),
    );
    metadata.insert(
        "polygon".to_string(),
        ChainMetadata::new("Polygon", "polygon.svg", "polygon.svg"),
    );
    metadata.insert(
        "bsc".to_string(),
        ChainMetadata::new("BNB Smart Chain", "bsc.svg", "bsc.svg"),
    );
    metadata.insert(
        "hyperliquid".to_string(),
        ChainMetadata::new("Hyperliquid", "hyperliquid.svg", "hyperliquid.svg"),
    );
    metadata.insert(
        "ton".to_string(),
        ChainMetadata::new("TON", "ton.svg", "ton.svg"),
    );
    metadata.insert(
        "optimism".to_string(),
        ChainMetadata::new("Optimism", "optimism.svg", "optimism_dark.svg"),
    );
    metadata.insert(
        "avalanche".to_string(),
        ChainMetadata::new("Avalanche", "avalanche.svg", "avalanche.svg"),
    );
    metadata.insert(
        "sui".to_string(),
        ChainMetadata::new("Sui", "sui.svg", "sui_dark.svg"),
    );
    metadata.insert(
        "stellar".to_string(),
        ChainMetadata::new("Stellar", "stellar_white.svg", "stellar.svg"),
    );
    metadata.insert(
        "aptos".to_string(),
        ChainMetadata::new("Aptos", "aptos_white.svg", "aptos.svg"),
    );
    metadata.insert(
        "cardano".to_string(),
        ChainMetadata::new("Cardano", "cardano.svg", "cardano.svg"),
    );

    metadata
});

/// Get chain metadata by chain name (returns name and both dark/light icon variants)
pub fn get_chain_metadata_by_name(chain_name: &str) -> Option<ChainMetadata> {
    let normalized_name = chain_name.to_lowercase();
    CHAIN_METADATA.get(&normalized_name).cloned()
}

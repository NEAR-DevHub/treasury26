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
    /// If set, this key is an alias for another canonical key and should be
    /// excluded from the enumerated chains list.
    pub canonical_key: Option<String>,
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
            canonical_key: None,
        }
    }

    pub fn alias(canonical_key: &str, metadata: &ChainMetadata) -> Self {
        Self {
            name: metadata.name.clone(),
            icon: metadata.icon.clone(),
            canonical_key: Some(canonical_key.to_string()),
        }
    }
}

fn add_chain_alias(metadata: &mut HashMap<String, ChainMetadata>, alias: &str, canonical: &str) {
    if let Some(canonical_meta) = metadata.get(canonical).cloned() {
        metadata.insert(
            alias.to_string(),
            ChainMetadata::alias(canonical, &canonical_meta),
        );
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
    add_chain_alias(&mut metadata, "arb", "arbitrum");
    metadata.insert(
        "bitcoin".to_string(),
        ChainMetadata::new("Bitcoin", "btc.svg", "btc.svg"),
    );
    metadata.insert(
        "solana".to_string(),
        ChainMetadata::new("Solana", "solana.svg", "solana.svg"),
    );
    add_chain_alias(&mut metadata, "sol", "solana");
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
        "hako".to_string(),
        ChainMetadata::new("Hako", "hako-dark.svg", "hako-light.svg"),
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
    add_chain_alias(&mut metadata, "bera", "berachain");
    metadata.insert(
        "tron".to_string(),
        ChainMetadata::new("Tron", "tron.svg", "tron.svg"),
    );
    metadata.insert(
        "polygon".to_string(),
        ChainMetadata::new("Polygon", "polygon.svg", "polygon.svg"),
    );
    add_chain_alias(&mut metadata, "pol", "polygon");
    add_chain_alias(&mut metadata, "matic", "polygon");
    metadata.insert(
        "bsc".to_string(),
        ChainMetadata::new("BNB Smart Chain", "bsc.svg", "bsc.svg"),
    );
    add_chain_alias(&mut metadata, "bnb", "bsc");
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
    add_chain_alias(&mut metadata, "op", "optimism");
    metadata.insert(
        "avalanche".to_string(),
        ChainMetadata::new("Avalanche", "avalanche.svg", "avalanche.svg"),
    );
    add_chain_alias(&mut metadata, "avax", "avalanche");
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
    metadata.insert(
        "litecoin".to_string(),
        ChainMetadata::new("Litecoin", "litecoin_white.svg", "litecoin.svg"),
    );
    metadata.insert(
        "bitcoincash".to_string(),
        ChainMetadata::new("Bitcoin Cash", "bitcoincash.svg", "bitcoincash.svg"),
    );
    metadata.insert(
        "adi".to_string(),
        ChainMetadata::new("ADI", "adi.svg", "adi.svg"),
    );
    metadata.insert(
        "starknet".to_string(),
        ChainMetadata::new("StarkNet", "starknet.svg", "starknet.svg"),
    );
    metadata.insert(
        "plasma".to_string(),
        ChainMetadata::new("Plasma", "plasma-white.svg", "plasma.svg"),
    );
    metadata.insert(
        "scroll".to_string(),
        ChainMetadata::new("Scroll", "scroll.svg", "scroll.svg"),
    );
    metadata.insert(
        "aleo".to_string(),
        ChainMetadata::new("Aleo", "aleo-dark.svg", "aleo-white.svg"),
    );
    metadata.insert(
        "monad".to_string(),
        ChainMetadata::new("Monad", "monad_white.svg", "monad.svg"),
    );
    metadata.insert(
        "layerx".to_string(),
        ChainMetadata::new("LayerX", "layerx_white.svg", "layerx.svg"),
    );
    add_chain_alias(&mut metadata, "xlayer", "layerx");
    metadata.insert(
        "dash".to_string(),
        ChainMetadata::new("Dash", "dash.svg", "dash.svg"),
    );

    // Common long-form / shorthand aliases used by upstream providers
    add_chain_alias(&mut metadata, "ethereum", "eth");
    add_chain_alias(&mut metadata, "btc", "bitcoin");
    add_chain_alias(&mut metadata, "doge", "dogecoin");
    add_chain_alias(&mut metadata, "zec", "zcash");
    add_chain_alias(&mut metadata, "xrp", "xrpledger");
    add_chain_alias(&mut metadata, "nearprotocol", "near");
    add_chain_alias(&mut metadata, "near_protocol", "near");
    add_chain_alias(&mut metadata, "near protocol", "near");
    add_chain_alias(&mut metadata, "binance smart chain", "bsc");
    add_chain_alias(&mut metadata, "bnb smart chain", "bsc");

    metadata
});

/// Get chain metadata by chain name (returns name and both dark/light icon variants)
pub fn get_chain_metadata_by_name(chain_name: &str) -> Option<ChainMetadata> {
    let normalized_name = chain_name.to_lowercase();
    CHAIN_METADATA.get(&normalized_name).cloned()
}

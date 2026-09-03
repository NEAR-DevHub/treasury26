//! Deposit / swap asset catalogs.
//!
//! - **Deposit** (`/deposit-tokens`, alias `/bridge-tokens`): vendored near.com
//!   `production.json` only. Bridge RPC is fetched to fill mins / public-deposit
//!   flags on those rows — never to add Bridge-only tokens. Cached as one catalog.
//! - **Swap** (`/swap-tokens`): derived from the deposit catalog by filtering
//!   to assets present in 1Click `/v0/tokens` (no `?ondoTokens`).
//!
//! Each network exposes `balanceAssetId` (Intents ledger) and `quoteAssetId`
//! (1Click routing; may be a `1cs_v1:` id).

use crate::{
    constants::{
        intents_tokens::{
            BaseTokenInfo, TokenDeployment, UnifiedTokenInfo, find_unified_asset_id, get_tokens_map,
        },
        nearcom_ranking::{
            is_hidden_catalog_token, is_near_network, is_swap_excluded_symbol, network_volume_rank,
            token_sort_key,
        },
    },
    utils::cache::CacheTier,
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use crate::{
    AppState,
    constants::intents_chains::{ChainIcons, get_chain_metadata_by_name},
    handlers::intents::supported_tokens::fetch_supported_tokens_data,
    services::oneclick_asset_routing::{
        NBTC_BALANCE_ASSET_ID, is_one_click_routing_asset, price_lookup_asset_ids, quote_asset_id,
    },
    services::oneclick_tokens::fetch_oneclick_tokens,
};
use serde_json::Value;

const NEAR_MAINNET_NETWORK_ID: &str = "near:mainnet";

/// near.com `DEPRECATED_TOKENS` — keep out of the deposit catalog.
const DEPRECATED_BALANCE_ASSET_IDS: [&str; 3] = [
    "nep141:aurora",
    "nep141:btc.omft.near",
    "nep141:btc.stft.near",
];

fn chain_id_from_defuse_id(defuse_id: &str) -> String {
    if defuse_id.starts_with("1cs_v1:") {
        // `1cs_v1:<chain>:…` — origin chain is the second segment.
        let mut parts = defuse_id.split(':');
        let _ = parts.next();
        if let Some(chain) = parts.next() {
            return fallback_chain_id_for_name(chain);
        }
    }
    let parts: Vec<&str> = defuse_id.split(':').collect();
    if parts.len() >= 2 {
        format!("{}:{}", parts[0], parts[1])
    } else {
        parts.first().unwrap_or(&"").to_string()
    }
}

fn fallback_chain_id_for_name(chain_name: &str) -> String {
    let normalized = chain_name.to_lowercase();
    // Source of truth: Defuse `PoaBridgeNetworkReference` /
    // `BlockchainEnum` in `@defuse-protocol/internal-utils`
    // (packages/internal-utils/src/poaBridge/constants/blockchains.ts).
    // near.com maps UI chain names via `assetNetworkAdapter` → these ids
    // before calling POA `deposit_address`.
    match normalized.as_str() {
        "eth" | "ethereum" => "eth:1".to_string(),
        "base" => "eth:8453".to_string(),
        "arbitrum" | "arb" => "eth:42161".to_string(),
        "bitcoin" | "btc" => "btc:mainnet".to_string(),
        "bitcoincash" | "bch" => "bch:mainnet".to_string(),
        "solana" | "sol" => "sol:mainnet".to_string(),
        "near" => NEAR_MAINNET_NETWORK_ID.to_string(),
        "polygon" | "pol" | "matic" => "eth:137".to_string(),
        "bsc" | "bnb" => "eth:56".to_string(),
        "optimism" | "op" => "eth:10".to_string(),
        "avalanche" | "avax" => "eth:43114".to_string(),
        "gnosis" => "eth:100".to_string(),
        "berachain" | "bera" => "eth:80094".to_string(),
        "tron" => "tron:mainnet".to_string(),
        "ton" => "ton:mainnet".to_string(),
        "sui" => "sui:mainnet".to_string(),
        "aptos" => "aptos:mainnet".to_string(),
        "stellar" => "stellar:mainnet".to_string(),
        "starknet" => "starknet:mainnet".to_string(),
        "xrpledger" | "xrp" => "xrp:mainnet".to_string(),
        "zcash" | "zec" => "zec:mainnet".to_string(),
        "dogecoin" | "doge" => "doge:mainnet".to_string(),
        "cardano" => "cardano:mainnet".to_string(),
        "litecoin" | "ltc" => "ltc:mainnet".to_string(),
        "monad" => "eth:143".to_string(),
        "layerx" => "eth:196".to_string(),
        "plasma" => "eth:9745".to_string(),
        "scroll" => "eth:534352".to_string(),
        "aleo" => "aleo:mainnet".to_string(),
        "dash" => "dash:mainnet".to_string(),
        "movement" => "movement:mainnet".to_string(),
        "fogo" => "fogo:mainnet".to_string(),
        // Defuse: "Hyperliquid is only available as a withdrawal destination"
        // (not in PoaBridgeNetworkReference; no public POA deposit).
        "hyperliquid" | "hypercore" => "hyperliquid:999".to_string(),
        other => format!("{other}:mainnet"),
    }
}

/// Extract an EVM/SPL-style contract address from a defuse / 1cs asset id.
fn contract_address_from_asset_id(asset_id: &str) -> Option<String> {
    let last = asset_id.split(':').next_back()?.to_lowercase();
    if last.starts_with("0x") && last.len() >= 42 {
        return Some(last);
    }
    // nep141:base-0xabc….omft.near
    if let Some(idx) = last.find("0x") {
        let rest = &last[idx..];
        let addr: String = rest
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == 'x')
            .collect();
        if addr.starts_with("0x") && addr.len() >= 42 {
            return Some(addr);
        }
    }
    None
}

fn deployment_decimals(base: &BaseTokenInfo) -> u8 {
    base.deployments
        .first()
        .map(|d| match d {
            TokenDeployment::Native { decimals, .. } => *decimals,
            TokenDeployment::Fungible { decimals, .. } => *decimals,
        })
        .unwrap_or(base.decimals)
}

fn network_name_for_base(base: &BaseTokenInfo) -> String {
    get_chain_metadata_by_name(&base.origin_chain_name)
        .map(|m| m.name.to_lowercase())
        .unwrap_or_else(|| base.origin_chain_name.to_lowercase())
}

/// When our build produces multiple rows for the same intents balance or POA
/// `chain_id`, keep the first row we already pushed for that asset.
fn dedupe_asset_networks(networks: &mut Vec<NetworkOption>) {
    let mut seen_balance = HashSet::new();
    let mut seen_chain = HashSet::new();
    networks.retain(|network| {
        if !seen_balance.insert(network.balance_asset_id.clone()) {
            return false;
        }
        if !seen_chain.insert(network.chain_id.clone()) {
            return false;
        }
        true
    });
}

fn has_tag(tags: &Option<Vec<String>>, tag: &str) -> bool {
    tags.as_ref()
        .is_some_and(|t| t.iter().any(|x| x.eq_ignore_ascii_case(tag)))
}

fn collected_catalog_tags(unified: &UnifiedTokenInfo) -> Vec<String> {
    let mut tags = unified.tags.clone().unwrap_or_default();
    for base in &unified.grouped_tokens {
        for tag in base.tags.iter().flatten() {
            if !tags.iter().any(|existing| existing == tag) {
                tags.push(tag.clone());
            }
        }
    }
    tags
}

#[cfg(test)]
fn is_hidden_unified_token(unified: &UnifiedTokenInfo) -> bool {
    is_hidden_catalog_token(&collected_catalog_tags(unified))
}

static CATALOG_TAGS: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    get_tokens_map()
        .iter()
        .map(|(id, unified)| (id.clone(), collected_catalog_tags(unified)))
        .collect()
});

fn catalog_tags_for_asset(asset_id: &str) -> &[String] {
    CATALOG_TAGS
        .get(&asset_id.to_lowercase())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn catalog_token_in_oneclick(balance_id: &str, oneclick_ids: &HashSet<String>) -> bool {
    let quote_id = quote_asset_id(balance_id);
    if oneclick_ids.contains(quote_id) || oneclick_ids.contains(balance_id) {
        return true;
    }
    price_lookup_asset_ids(balance_id)
        .into_iter()
        .chain(price_lookup_asset_ids(quote_id))
        .any(|id| oneclick_ids.contains(&id))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOption {
    /// Back-compat: Intents balance / catalog asset id.
    pub id: String,
    pub name: String,
    pub symbol: String,
    pub chain_icons: Option<ChainIcons>,
    pub chain_id: String,
    pub decimals: u8,
    pub min_deposit_amount: Option<String>,
    pub min_withdrawal_amount: Option<String>,
    /// Intents ledger / balance id (`nep141:` / `nep245:` / catalog id).
    pub balance_asset_id: String,
    /// 1Click quote routing id (may be `1cs_v1:`).
    pub quote_asset_id: String,
    /// Whether Bridge/POA can mint a stable public deposit address for `chain_id`.
    #[serde(default = "default_true")]
    pub public_deposit_supported: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssetOption {
    pub id: String,
    pub asset_name: String,
    pub name: String,
    pub icon: Option<String>,
    pub networks: Vec<NetworkOption>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DepositAssetsResponse {
    pub assets: Vec<AssetOption>,
}

#[derive(Clone, Default)]
struct BridgeTokenExtras {
    chain_id: String,
    min_deposit_amount: Option<String>,
    min_withdrawal_amount: Option<String>,
}

/// Bridge RPC rows used only to enrich catalog networks. Never a token source.
#[derive(Default)]
struct BridgeLookup {
    by_intents: HashMap<String, Vec<BridgeTokenExtras>>,
    by_contract: HashMap<String, Vec<BridgeTokenExtras>>,
    supported_chains: HashSet<String>,
}

impl BridgeLookup {
    fn from_supported_tokens(supported: &Value) -> Self {
        let mut lookup = Self::default();
        let Some(tokens) = supported.get("tokens").and_then(|t| t.as_array()) else {
            return lookup;
        };
        for token in tokens {
            let Some(intents_id) = token.get("intents_token_id").and_then(|id| id.as_str()) else {
                continue;
            };
            let standard = token.get("standard").and_then(|s| s.as_str()).unwrap_or("");
            if standard != "nep141" && standard != "nep245" {
                continue;
            }
            let defuse_id = token
                .get("defuse_asset_identifier")
                .and_then(|d| d.as_str())
                .unwrap_or("");
            let extras = BridgeTokenExtras {
                chain_id: chain_id_from_defuse_id(defuse_id),
                min_deposit_amount: token
                    .get("min_deposit_amount")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                min_withdrawal_amount: token
                    .get("min_withdrawal_amount")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            };
            lookup.supported_chains.insert(extras.chain_id.clone());
            lookup
                .by_intents
                .entry(intents_id.to_string())
                .or_default()
                .push(extras.clone());
            if let Some(addr) = contract_address_from_asset_id(defuse_id) {
                lookup.by_contract.entry(addr).or_default().push(extras);
            }
        }
        lookup
    }

    fn resolve(&self, balance_id: &str, preferred_chain: &str) -> Option<&BridgeTokenExtras> {
        if let Some(entries) = self.by_intents.get(balance_id) {
            return entries.iter().find(|e| e.chain_id == preferred_chain);
        }
        let addr = contract_address_from_asset_id(balance_id)?;
        self.by_contract
            .get(&addr)
            .and_then(|entries| entries.iter().find(|e| e.chain_id == preferred_chain))
    }
}

/// Deposit catalog (near.com listing parity — no Bridge union, no 1Click ∩).
pub async fn get_deposit_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DepositAssetsResponse>, (StatusCode, String)> {
    Ok(Json(load_deposit_catalog(state).await?))
}

/// Swap / quote catalog: deposit catalog filtered to 1Click `/v0/tokens`,
/// excluding chain-only `1cs_v1:` networks (INTENTS holds nep141/nep245 only).
pub async fn get_swap_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DepositAssetsResponse>, (StatusCode, String)> {
    let state_clone = state.clone();
    state
        .cache
        .cached::<_, DepositAssetsResponse, (StatusCode, String)>(
            CacheTier::LongTerm,
            "swap-tokens".to_string(),
            async move {
                let deposit = load_deposit_catalog(state_clone.clone()).await?;
                let oneclick_tokens = fetch_oneclick_tokens(&state_clone)
                    .await
                    .unwrap_or_default();
                let oneclick_ids: HashSet<String> =
                    oneclick_tokens.into_iter().map(|t| t.asset_id).collect();
                Ok(filter_catalog_for_swap(deposit, &oneclick_ids))
            },
        )
        .await
        .map(Json)
}

/// Backward-compatible alias of [`get_deposit_tokens`].
pub async fn get_bridge_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DepositAssetsResponse>, (StatusCode, String)> {
    get_deposit_tokens(State(state)).await
}

async fn load_deposit_catalog(
    state: Arc<AppState>,
) -> Result<DepositAssetsResponse, (StatusCode, String)> {
    let state_clone = state.clone();
    state
        .cache
        .cached::<_, DepositAssetsResponse, (StatusCode, String)>(
            CacheTier::LongTerm,
            "deposit-tokens".to_string(),
            async move {
                let supported = fetch_supported_tokens_data(&state_clone).await?;
                Ok(build_deposit_catalog(&BridgeLookup::from_supported_tokens(
                    &supported,
                )))
            },
        )
        .await
}

/// Keep assets/networks whose balance or quote id is in 1Click.
fn filter_catalog_for_oneclick(
    deposit: DepositAssetsResponse,
    oneclick_ids: &HashSet<String>,
) -> DepositAssetsResponse {
    let mut assets = Vec::with_capacity(deposit.assets.len());
    for mut asset in deposit.assets {
        asset
            .networks
            .retain(|network| catalog_token_in_oneclick(&network.balance_asset_id, oneclick_ids));
        if !asset.networks.is_empty() {
            assets.push(asset);
        }
    }
    DepositAssetsResponse { assets }
}

/// Swap catalog = 1Click ∩ plus only INTENTS-holdable balance ids.
///
/// `1cs_v1:` rows are deposit/withdraw routing (e.g. CFI on Base, ZEC on
/// Solana). Exchange sell/receive must use `nep141`/`nep245` (nBTC stays:
/// balance id is `nep141:nbtc…`, only `quote_asset_id` is native BTC `1cs`).
fn filter_catalog_for_swap(
    deposit: DepositAssetsResponse,
    oneclick_ids: &HashSet<String>,
) -> DepositAssetsResponse {
    let mut filtered = filter_catalog_for_oneclick(deposit, oneclick_ids);
    for asset in &mut filtered.assets {
        asset
            .networks
            .retain(|network| !is_one_click_routing_asset(&network.balance_asset_id));
    }
    filtered
        .assets
        .retain(|asset| !asset.networks.is_empty() && !is_swap_excluded_symbol(&asset.asset_name));
    filtered
}

fn build_deposit_catalog(bridge: &BridgeLookup) -> DepositAssetsResponse {
    let mut asset_map: HashMap<String, AssetOption> = HashMap::new();

    for (unified_id, unified) in get_tokens_map().iter() {
        if is_hidden_catalog_token(unified.tags.as_deref().unwrap_or(&[])) {
            continue;
        }
        // near.com `swap:input-only` (e.g. BTC Legacy) — not a deposit target.
        if has_tag(&unified.tags, "swap:input-only") {
            continue;
        }
        for base in &unified.grouped_tokens {
            let balance_id = base.defuse_asset_id.as_str();
            if DEPRECATED_BALANCE_ASSET_IDS.contains(&balance_id) {
                continue;
            }
            if is_hidden_catalog_token(base.tags.as_deref().unwrap_or(&[])) {
                continue;
            }
            if has_tag(&base.tags, "swap:input-only") {
                continue;
            }

            let quote_id = quote_asset_id(balance_id).to_string();
            let group_key = find_unified_asset_id(balance_id)
                .map(String::from)
                .unwrap_or_else(|| unified_id.clone());

            let network_name = network_name_for_base(base);
            let chain_meta = get_chain_metadata_by_name(&base.origin_chain_name)
                .or_else(|| get_chain_metadata_by_name(&network_name));

            let preferred_chain = if balance_id == NBTC_BALANCE_ASSET_ID {
                fallback_chain_id_for_name("bitcoin")
            } else if is_one_click_routing_asset(balance_id) {
                chain_id_from_defuse_id(balance_id)
            } else {
                fallback_chain_id_for_name(&base.origin_chain_name)
            };
            let extras = bridge.resolve(balance_id, &preferred_chain);
            let chain_id = extras
                .map(|e| e.chain_id.clone())
                .unwrap_or(preferred_chain);
            let public_deposit_supported = bridge.supported_chains.contains(&chain_id);

            let asset = asset_map
                .entry(group_key.clone())
                .or_insert_with(|| AssetOption {
                    id: group_key.clone(),
                    asset_name: unified.symbol.clone(),
                    name: unified.name.clone(),
                    icon: Some(unified.icon.clone()),
                    networks: Vec::new(),
                });

            if asset
                .networks
                .iter()
                .any(|n| n.balance_asset_id == balance_id)
            {
                continue;
            }

            asset.networks.push(NetworkOption {
                id: balance_id.to_string(),
                name: network_name,
                symbol: base.symbol.clone(),
                chain_icons: chain_meta.map(|m| m.icon),
                chain_id,
                decimals: deployment_decimals(base),
                min_deposit_amount: extras.and_then(|e| e.min_deposit_amount.clone()),
                min_withdrawal_amount: extras.and_then(|e| e.min_withdrawal_amount.clone()),
                balance_asset_id: balance_id.to_string(),
                quote_asset_id: quote_id,
                public_deposit_supported,
            });
        }
    }

    let mut assets: Vec<AssetOption> = asset_map.into_values().collect();

    let near_chain_icons = get_chain_metadata_by_name("near")
        .map(|metadata| metadata.icon)
        .or_else(|| {
            Some(ChainIcons {
                icon: "https://near.com/static/icons/network/near.svg".to_string(),
            })
        });

    for asset in &mut assets {
        let existing_near_network = asset
            .networks
            .iter()
            .find(|network| {
                is_near_network(&network.name) || network.chain_id == NEAR_MAINNET_NETWORK_ID
            })
            .cloned();
        let Some(existing_near_network) = existing_near_network else {
            continue;
        };

        asset.networks.retain(|network| {
            !is_near_network(&network.name) && network.chain_id != NEAR_MAINNET_NETWORK_ID
        });

        asset.networks.push(NetworkOption {
            id: existing_near_network.id,
            name: "near".to_string(),
            symbol: asset.asset_name.clone(),
            chain_icons: near_chain_icons.clone(),
            chain_id: NEAR_MAINNET_NETWORK_ID.to_string(),
            decimals: existing_near_network.decimals,
            min_deposit_amount: existing_near_network.min_deposit_amount,
            min_withdrawal_amount: existing_near_network.min_withdrawal_amount,
            balance_asset_id: existing_near_network.balance_asset_id,
            quote_asset_id: existing_near_network.quote_asset_id,
            public_deposit_supported: existing_near_network.public_deposit_supported,
        });
    }

    for asset in &mut assets {
        dedupe_asset_networks(&mut asset.networks);
    }

    assets.sort_by_cached_key(|asset| {
        (
            token_sort_key(catalog_tags_for_asset(&asset.id)),
            asset.id.clone(),
        )
    });
    for asset in &mut assets {
        asset.networks.sort_by_cached_key(|network| {
            (
                !is_near_network(&network.name) && network.chain_id != NEAR_MAINNET_NETWORK_ID,
                network_volume_rank(&network.name),
                network.name.to_ascii_lowercase(),
            )
        });
    }

    DepositAssetsResponse { assets }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::intents_tokens::get_defuse_tokens_map;

    #[test]
    fn chain_id_from_1cs_uses_origin_chain() {
        assert_eq!(chain_id_from_defuse_id("1cs_v1:sol:spl:Abc"), "sol:mainnet");
        assert_eq!(
            chain_id_from_defuse_id("1cs_v1:btc:native:coin"),
            "btc:mainnet"
        );
        // Bridge depositAddressFetch expects eth:<id> for EVM L2s.
        assert_eq!(
            chain_id_from_defuse_id("1cs_v1:base:erc20:0x0382e3fee4a420bd446367d468a6f00225853420"),
            "eth:8453"
        );
        assert_eq!(
            chain_id_from_defuse_id("eth:8453:0x0382e3fee4a420bd446367d468a6f00225853420"),
            "eth:8453"
        );
    }

    #[test]
    fn contract_address_extracted_from_1cs_and_bridge_ids() {
        assert_eq!(
            contract_address_from_asset_id(
                "1cs_v1:base:erc20:0x0382e3fee4a420bd446367d468a6f00225853420"
            )
            .as_deref(),
            Some("0x0382e3fee4a420bd446367d468a6f00225853420")
        );
        assert_eq!(
            contract_address_from_asset_id("eth:8453:0x0382e3fee4a420bd446367d468a6f00225853420")
                .as_deref(),
            Some("0x0382e3fee4a420bd446367d468a6f00225853420")
        );
    }

    #[test]
    fn dedupe_keeps_first_catalog_row_per_chain_and_balance() {
        // Catalog order: native arb.omft before WETH wrap — first wins.
        let mut networks = vec![
            NetworkOption {
                id: "nep141:arb.omft.near".into(),
                name: "arbitrum".into(),
                symbol: "ETH".into(),
                chain_icons: None,
                chain_id: "eth:42161".into(),
                decimals: 18,
                min_deposit_amount: Some("1".into()),
                min_withdrawal_amount: Some("1".into()),
                balance_asset_id: "nep141:arb.omft.near".into(),
                quote_asset_id: "nep141:arb.omft.near".into(),
                public_deposit_supported: true,
            },
            NetworkOption {
                id: "nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near".into(),
                name: "arbitrum".into(),
                symbol: "wETH".into(),
                chain_icons: None,
                chain_id: "eth:42161".into(),
                decimals: 18,
                min_deposit_amount: Some("1".into()),
                min_withdrawal_amount: Some("1".into()),
                balance_asset_id: "nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near"
                    .into(),
                quote_asset_id: "nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near"
                    .into(),
                public_deposit_supported: true,
            },
        ];
        dedupe_asset_networks(&mut networks);
        assert_eq!(networks.len(), 1);
        assert_eq!(networks[0].balance_asset_id, "nep141:arb.omft.near");
    }

    #[test]
    fn catalog_match_accepts_btc_routing_alias() {
        let mut ids = HashSet::new();
        ids.insert(
            crate::services::oneclick_asset_routing::ONE_CLICK_BTC_NATIVE_ASSET_ID.to_string(),
        );
        assert!(catalog_token_in_oneclick(NBTC_BALANCE_ASSET_ID, &ids));
    }

    #[test]
    fn nearcom_catalog_loads_and_includes_curated_1cs_deployments() {
        let map = get_defuse_tokens_map();
        assert!(map.len() > 50, "expected vendored near.com catalog to load");
        assert!(
            map.contains_key("1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f")
                || map.keys().any(|k| k.starts_with("1cs_v1:hypercore:")),
            "expected Hyperliquid USDC 1cs deployment in catalog"
        );
        assert!(
            map.contains_key(NBTC_BALANCE_ASSET_ID),
            "expected nBTC balance id in catalog"
        );
        assert_eq!(
            quote_asset_id(NBTC_BALANCE_ASSET_ID),
            crate::services::oneclick_asset_routing::ONE_CLICK_BTC_NATIVE_ASSET_ID
        );
    }

    #[test]
    fn swap_catalog_drops_1cs_balance_networks_keeps_nbtc() {
        let cfi_near = "nep141:cfi.consumer-fi.near";
        let cfi_base = "1cs_v1:base:erc20:0x0382e3fee4a420bd446367d468a6f00225853420";
        let btc_quote = crate::services::oneclick_asset_routing::ONE_CLICK_BTC_NATIVE_ASSET_ID;
        let oneclick_ids: HashSet<String> = [cfi_near, cfi_base, NBTC_BALANCE_ASSET_ID, btc_quote]
            .into_iter()
            .map(str::to_string)
            .collect();

        let deposit = DepositAssetsResponse {
            assets: vec![
                AssetOption {
                    id: "cfi".into(),
                    asset_name: "CFI".into(),
                    name: "ConsumerFi".into(),
                    icon: None,
                    networks: vec![
                        NetworkOption {
                            id: cfi_near.into(),
                            name: "near".into(),
                            symbol: "CFI".into(),
                            chain_icons: None,
                            chain_id: "near:mainnet".into(),
                            decimals: 18,
                            min_deposit_amount: None,
                            min_withdrawal_amount: None,
                            balance_asset_id: cfi_near.into(),
                            quote_asset_id: cfi_near.into(),
                            public_deposit_supported: true,
                        },
                        NetworkOption {
                            id: cfi_base.into(),
                            name: "base".into(),
                            symbol: "CFI".into(),
                            chain_icons: None,
                            chain_id: "eth:8453".into(),
                            decimals: 18,
                            min_deposit_amount: None,
                            min_withdrawal_amount: None,
                            balance_asset_id: cfi_base.into(),
                            quote_asset_id: cfi_base.into(),
                            public_deposit_supported: true,
                        },
                    ],
                },
                AssetOption {
                    id: "btc".into(),
                    asset_name: "BTC".into(),
                    name: "Bitcoin".into(),
                    icon: None,
                    networks: vec![NetworkOption {
                        id: NBTC_BALANCE_ASSET_ID.into(),
                        name: "bitcoin".into(),
                        symbol: "BTC".into(),
                        chain_icons: None,
                        chain_id: "btc:mainnet".into(),
                        decimals: 8,
                        min_deposit_amount: None,
                        min_withdrawal_amount: None,
                        balance_asset_id: NBTC_BALANCE_ASSET_ID.into(),
                        quote_asset_id: btc_quote.into(),
                        public_deposit_supported: true,
                    }],
                },
            ],
        };

        let swap = filter_catalog_for_swap(deposit, &oneclick_ids);
        assert_eq!(swap.assets.len(), 2, "cfi + btc should remain");

        let cfi = swap
            .assets
            .iter()
            .find(|a| a.id == "cfi")
            .expect("cfi asset");
        assert_eq!(cfi.networks.len(), 1);
        assert_eq!(cfi.networks[0].balance_asset_id, cfi_near);

        let btc = swap
            .assets
            .iter()
            .find(|a| a.id == "btc")
            .expect("btc asset");
        assert_eq!(btc.networks.len(), 1);
        assert_eq!(btc.networks[0].balance_asset_id, NBTC_BALANCE_ASSET_ID);
        assert_eq!(btc.networks[0].quote_asset_id, btc_quote);
    }

    #[test]
    fn vendored_catalog_sorts_like_nearcom_picker() {
        let catalog = build_deposit_catalog(&BridgeLookup::default());
        let top: Vec<_> = catalog
            .assets
            .iter()
            .take(5)
            .map(|asset| asset.asset_name.as_str())
            .collect();
        assert_eq!(
            top,
            ["ZEC", "NEAR", "USDT", "USDC", "SOL"],
            "built catalog must match the near.com picker order"
        );
        assert!(
            catalog.assets.iter().all(|asset| {
                !asset.asset_name.contains("(omni)")
                    && !matches!(asset.asset_name.as_str(), "steakUSDC" | "gtUSDCp" | "TLO")
            }),
            "hidden tokens must not appear in the built catalog"
        );
    }

    #[test]
    fn empty_bridge_lookup_marks_public_deposit_unsupported() {
        let catalog = build_deposit_catalog(&BridgeLookup::default());
        let unsupported = catalog
            .assets
            .iter()
            .flat_map(|asset| asset.networks.iter())
            .filter(|network| !network.public_deposit_supported)
            .count();
        assert!(
            unsupported > 0,
            "a missing Bridge RPC must fail closed, not advertise public deposit on every chain"
        );
        assert!(
            catalog
                .assets
                .iter()
                .flat_map(|asset| asset.networks.iter())
                .all(|network| !network.public_deposit_supported),
            "every network must be unsupported when the lookup has no supported_chains"
        );
    }

    #[test]
    fn near_networks_collapse_to_one_mainnet_row() {
        let catalog = build_deposit_catalog(&BridgeLookup::default());
        let near = catalog
            .assets
            .iter()
            .find(|asset| asset.asset_name == "NEAR")
            .expect("NEAR stays in the catalog");
        let near_rows: Vec<_> = near
            .networks
            .iter()
            .filter(|network| {
                is_near_network(&network.name) || network.chain_id == NEAR_MAINNET_NETWORK_ID
            })
            .collect();
        assert_eq!(near_rows.len(), 1, "exactly one NEAR network must survive");
        assert_eq!(near_rows[0].chain_id, NEAR_MAINNET_NETWORK_ID);
        assert!(
            near_rows[0].balance_asset_id.starts_with("nep141:"),
            "NEAR must keep its intents balance id, got {}",
            near_rows[0].balance_asset_id
        );
        assert_eq!(
            near.networks[0].chain_id, NEAR_MAINNET_NETWORK_ID,
            "NEAR must be pinned first in the network list"
        );
    }

    #[test]
    fn usdc_networks_put_near_first_then_volume() {
        let catalog = build_deposit_catalog(&BridgeLookup::default());
        let usdc = catalog
            .assets
            .iter()
            .find(|asset| asset.asset_name == "USDC")
            .expect("USDC stays in the catalog");
        assert!(
            is_near_network(&usdc.networks[0].name)
                || usdc.networks[0].chain_id == NEAR_MAINNET_NETWORK_ID,
            "NEAR must be first, got {}",
            usdc.networks[0].name
        );
        let non_near: Vec<_> = usdc
            .networks
            .iter()
            .skip(1)
            .map(|network| network_volume_rank(&network.name))
            .collect();
        let mut sorted = non_near.clone();
        sorted.sort();
        assert_eq!(
            non_near, sorted,
            "USDC non-NEAR networks must be in ascending vol: rank"
        );
    }

    #[test]
    fn every_catalog_chain_has_a_volume_rank() {
        for base in get_defuse_tokens_map().values() {
            let name = network_name_for_base(base);
            assert_ne!(
                network_volume_rank(&name),
                999,
                "no vol: rank for chain {name}"
            );
        }
    }

    #[test]
    fn deposit_catalog_excludes_bridge_only_and_hidden_tokens() {
        let catalog = build_deposit_catalog(&BridgeLookup::default());
        let symbols: Vec<_> = catalog
            .assets
            .iter()
            .map(|asset| asset.asset_name.as_str())
            .collect();

        assert!(
            symbols.iter().any(|symbol| *symbol == "USDC"),
            "USDC should remain in the near.com catalog"
        );
        assert!(
            symbols.iter().any(|symbol| *symbol == "USDT"),
            "USDT should remain in the near.com catalog"
        );

        for extra in [
            "laUSDC",
            "mwUSDC",
            "sparkUSDC",
            "sUSDC",
            "COCA",
            "FMS",
            "FRAX",
            "hemiBTC",
            "stNEAR",
            "steakUSDC",
            "gtUSDCp",
            "TLO",
        ] {
            assert!(
                !symbols
                    .iter()
                    .any(|symbol| symbol.eq_ignore_ascii_case(extra)),
                "{extra} must not appear after dropping Bridge extras and hidden tokens"
            );
        }
        assert!(
            symbols.iter().all(|symbol| !symbol.contains("(omni)")),
            "feature-gated omni tokens must stay hidden"
        );
    }

    #[test]
    fn bridge_lookup_fills_mins_without_adding_tokens() {
        const USDC_ETH: &str = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
        let extras = BridgeTokenExtras {
            chain_id: "eth:1".into(),
            min_deposit_amount: Some("1000".into()),
            min_withdrawal_amount: Some("2000".into()),
        };
        let mut bridge = BridgeLookup::default();
        bridge.supported_chains.insert("eth:1".into());
        bridge
            .by_intents
            .insert(USDC_ETH.into(), vec![extras.clone()]);
        bridge.by_intents.insert(
            "nep141:la-usdc-bridge-only.omft.near".into(),
            vec![BridgeTokenExtras {
                chain_id: "eth:1".into(),
                min_deposit_amount: Some("1".into()),
                min_withdrawal_amount: Some("1".into()),
            }],
        );

        let catalog = build_deposit_catalog(&bridge);
        let usdc = catalog
            .assets
            .iter()
            .find(|asset| asset.asset_name == "USDC")
            .expect("USDC stays in the catalog");
        let eth = usdc
            .networks
            .iter()
            .find(|network| network.balance_asset_id == USDC_ETH)
            .expect("USDC Ethereum network");
        assert_eq!(eth.min_deposit_amount.as_deref(), Some("1000"));
        assert_eq!(eth.min_withdrawal_amount.as_deref(), Some("2000"));
        assert!(eth.public_deposit_supported);

        assert!(
            catalog
                .assets
                .iter()
                .all(|asset| !asset.asset_name.eq_ignore_ascii_case("laUSDC")
                    && asset.networks.iter().all(|network| network.balance_asset_id
                        != "nep141:la-usdc-bridge-only.omft.near")),
            "Bridge-only tokens must not be added from the mins lookup"
        );
    }

    #[test]
    fn standalone_catalog_tokens_keep_nearcom_tags() {
        let steak = get_tokens_map()
            .get("steakusdc")
            .expect("steakUSDC should load from the vendored catalog");
        assert!(
            is_hidden_unified_token(steak),
            "earn vault shares stay out of send/swap/deposit pickers"
        );

        let omni = get_tokens_map()
            .get("aurora (omni)")
            .expect("AURORA (omni) should load from the vendored catalog");
        assert!(
            is_hidden_unified_token(omni),
            "feature-gated omni variants stay hidden without a URL flag"
        );
    }

    fn network(id: &str, name: &str, symbol: &str) -> NetworkOption {
        NetworkOption {
            id: id.into(),
            name: name.into(),
            symbol: symbol.into(),
            chain_icons: None,
            chain_id: "near:mainnet".into(),
            decimals: 18,
            min_deposit_amount: None,
            min_withdrawal_amount: None,
            balance_asset_id: id.into(),
            quote_asset_id: id.into(),
            public_deposit_supported: true,
        }
    }

    #[test]
    fn swap_catalog_drops_ref_and_brrr() {
        let ref_id = "nep141:token.v2.ref-finance.near";
        let usdc_id = "nep141:usdc.near";
        let oneclick_ids: HashSet<String> =
            [ref_id, usdc_id].into_iter().map(str::to_string).collect();

        let deposit = DepositAssetsResponse {
            assets: vec![
                AssetOption {
                    id: "ref".into(),
                    asset_name: "REF".into(),
                    name: "Ref Finance".into(),
                    icon: None,
                    networks: vec![network(ref_id, "near", "REF")],
                },
                AssetOption {
                    id: "usdc".into(),
                    asset_name: "USDC".into(),
                    name: "USD Coin".into(),
                    icon: None,
                    networks: vec![network(usdc_id, "near", "USDC")],
                },
            ],
        };

        let swap = filter_catalog_for_swap(deposit, &oneclick_ids);
        assert_eq!(
            swap.assets
                .iter()
                .map(|asset| asset.asset_name.as_str())
                .collect::<Vec<_>>(),
            vec!["USDC"]
        );
    }
}

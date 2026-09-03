//! near.com send/swap picker ranking.
//!
//! Token order (`useTokenList.ts` `compareTokens`): `tvol:` first, then
//! `type:stablecoin`, then `mc:`. Network order (`blockchains.tsx` `vol:`),
//! with NEAR pinned first (`prioritizeNearNetwork`).

use std::cmp::Ordering;

pub fn is_hidden_catalog_tag(tag: &str) -> bool {
    let tag = tag.trim();
    tag.eq_ignore_ascii_case("category:earn-vault")
        || tag
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("feature:"))
}

pub fn is_hidden_catalog_token(tags: &[String]) -> bool {
    tags.iter().any(|tag| is_hidden_catalog_tag(tag))
}

pub fn is_swap_excluded_symbol(symbol: &str) -> bool {
    matches!(symbol.trim().to_ascii_uppercase().as_str(), "REF" | "BRRR")
}

fn tagged_rank(tags: &[String], prefix: &str) -> Option<i32> {
    tags.iter().find_map(|tag| {
        let tag = tag.trim();
        let rest = tag.strip_prefix(prefix)?;
        rest.parse().ok()
    })
}

pub fn compare_catalog_tokens(a_tags: &[String], b_tags: &[String]) -> Ordering {
    let a_vol = tagged_rank(a_tags, "tvol:");
    let b_vol = tagged_rank(b_tags, "tvol:");
    match (a_vol, b_vol) {
        (Some(a), Some(b)) if a != b => return a.cmp(&b),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        _ => {}
    }

    let a_stable = a_tags
        .iter()
        .any(|tag| tag.eq_ignore_ascii_case("type:stablecoin"));
    let b_stable = b_tags
        .iter()
        .any(|tag| tag.eq_ignore_ascii_case("type:stablecoin"));
    match (a_stable, b_stable) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }

    match (tagged_rank(a_tags, "mc:"), tagged_rank(b_tags, "mc:")) {
        (Some(a), Some(b)) if a != b => a.cmp(&b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

fn canonical_network_key(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "eth" | "ethereum" => "eth".to_string(),
        "sol" | "solana" => "solana".to_string(),
        "btc" | "bitcoin" => "bitcoin".to_string(),
        "doge" | "dogecoin" => "dogecoin".to_string(),
        "arb" | "arbitrum" => "arbitrum".to_string(),
        "zec" | "zcash" => "zcash".to_string(),
        "xrp" | "xrpledger" | "xrp ledger" => "xrpledger".to_string(),
        "pol" | "matic" | "polygon" => "polygon".to_string(),
        "bnb" | "bsc" | "bnb smart chain" => "bsc".to_string(),
        "op" | "optimism" => "optimism".to_string(),
        "avax" | "avalanche" => "avalanche".to_string(),
        "bera" | "berachain" => "berachain".to_string(),
        "hypercore" | "hyperliquid" => "hyperliquid".to_string(),
        "ltc" | "litecoin" => "litecoin".to_string(),
        "bch" | "bitcoincash" | "bitcoin cash" => "bitcoincash".to_string(),
        "near.com" | "nearcom" | "near_intents" => "near_intents".to_string(),
        "layerx" | "x layer" | "xlayer" => "layerx".to_string(),
        other => other.to_string(),
    }
}

/// near.com `vol:` ranks. Lower is shown first. Unknown chains go last.
pub fn network_volume_rank(name: &str) -> u32 {
    match canonical_network_key(name).as_str() {
        "zcash" => 1,
        "tron" => 2,
        "solana" => 3,
        "near" => 4,
        "gnosis" => 5,
        "eth" => 6,
        "dogecoin" => 7,
        "bitcoin" => 8,
        "base" => 9,
        "arbitrum" | "xrpledger" => 10,
        "berachain" => 11,
        "polygon" => 12,
        "bsc" => 13,
        "hyperliquid" => 14,
        "ton" => 15,
        "optimism" => 16,
        "avalanche" => 17,
        "sui" => 18,
        "stellar" => 19,
        "aptos" => 20,
        "cardano" => 21,
        "litecoin" => 22,
        "layerx" => 23,
        "monad" => 24,
        "bitcoincash" => 25,
        "starknet" => 26,
        "adi" => 27,
        "plasma" => 28,
        "aleo" => 29,
        "dash" => 30,
        "scroll" => 31,
        "movement" => 32,
        "fogo" => 33,
        "aurora" => 101,
        "turbochain" => 102,
        "tuxappchain" => 103,
        "vertex" => 104,
        "optima" => 105,
        "easychain" => 106,
        "hako" => 107,
        "aurora_devnet" => 200,
        _ => 999,
    }
}

pub fn is_near_network(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("near")
}

pub fn compare_catalog_networks(a: &str, b: &str) -> Ordering {
    match (is_near_network(a), is_near_network(b)) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => network_volume_rank(a)
            .cmp(&network_volume_rank(b))
            .then_with(|| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn hides_earn_vaults_and_feature_gated_tokens() {
        assert!(is_hidden_catalog_token(&tags(&["category:earn-vault"])));
        assert!(is_hidden_catalog_token(&tags(&["feature:omni", "mc:1"])));
        assert!(!is_hidden_catalog_token(&tags(&[
            "mc:7",
            "type:stablecoin",
            "tvol:4"
        ])));
    }

    #[test]
    fn swap_drops_ref_and_brrr_only() {
        assert!(is_swap_excluded_symbol("REF"));
        assert!(is_swap_excluded_symbol("brrr"));
        assert!(!is_swap_excluded_symbol("USDC"));
    }

    #[test]
    fn tokens_sort_by_tvol_then_stable_then_market_cap() {
        let zec = tags(&["tvol:1", "mc:120"]);
        let near = tags(&["tvol:2", "mc:31"]);
        let usdt = tags(&["tvol:3", "type:stablecoin", "mc:3"]);
        let usdc = tags(&["tvol:4", "type:stablecoin", "mc:7"]);
        let dai = tags(&["type:stablecoin", "mc:25"]);
        let wbtc = tags(&["mc:3"]);
        let public = tags(&["aid:public"]);

        let mut ranked = [
            ("WBTC", wbtc.as_slice()),
            ("PUBLIC", public.as_slice()),
            ("DAI", dai.as_slice()),
            ("USDC", usdc.as_slice()),
            ("NEAR", near.as_slice()),
            ("USDT", usdt.as_slice()),
            ("ZEC", zec.as_slice()),
        ];
        ranked.sort_by(|a, b| compare_catalog_tokens(a.1, b.1));

        assert_eq!(
            ranked.map(|(symbol, _)| symbol).to_vec(),
            vec!["ZEC", "NEAR", "USDT", "USDC", "DAI", "WBTC", "PUBLIC"]
        );
    }

    #[test]
    fn networks_put_near_first_then_volume() {
        let mut names = [
            "ethereum", "solana", "base", "near", "zcash", "tron", "aurora",
        ];
        names.sort_by(|a, b| compare_catalog_networks(a, b));
        assert_eq!(
            names,
            [
                "near", "zcash", "tron", "solana", "ethereum", "base", "aurora"
            ]
        );
    }

    #[test]
    fn network_aliases_share_a_volume_rank() {
        assert_eq!(network_volume_rank("eth"), network_volume_rank("Ethereum"));
        assert_eq!(
            network_volume_rank("bnb smart chain"),
            network_volume_rank("bsc")
        );
        assert_eq!(
            network_volume_rank("XRP Ledger"),
            network_volume_rank("xrpledger")
        );
    }
}

//! Dual-id helpers for 1Click / Intents asset routing.
//!
//! Some assets are held on Intents as `nep141:` / `nep245:` balance ids but must
//! be quoted via a different `1cs_v1:` routing id (notably native Bitcoin).

/// Intents-held nBTC balance / catalog id.
pub const NBTC_BALANCE_ASSET_ID: &str = "nep141:nbtc.bridge.near";

/// 1Click routing id for Bitcoin-network deposits and withdraws.
pub const ONE_CLICK_BTC_NATIVE_ASSET_ID: &str = "1cs_v1:btc:native:coin";

/// Map a catalog/balance defuse asset id to the id used as 1Click
/// `originAsset` / `destinationAsset` when the two differ.
pub fn quote_asset_id(balance_asset_id: &str) -> &str {
    if balance_asset_id == NBTC_BALANCE_ASSET_ID {
        ONE_CLICK_BTC_NATIVE_ASSET_ID
    } else {
        balance_asset_id
    }
}

/// Map a 1Click / history routing id back to the Intents balance/catalog id.
pub fn balance_asset_id_from_quote(quote_or_history_id: &str) -> &str {
    if quote_or_history_id == ONE_CLICK_BTC_NATIVE_ASSET_ID {
        NBTC_BALANCE_ASSET_ID
    } else {
        quote_or_history_id
    }
}

/// Candidate keys for looking up USD prices for a defuse / 1cs asset id.
///
/// Price APIs often omit the `1cs_v1:<chain>:` routing prefix used by derived
/// tokens, so we also try the stripped form (mirrors near.com `priceLookupAssetIds`).
pub fn price_lookup_asset_ids(defuse_asset_id: &str) -> Vec<String> {
    let mut ids = vec![defuse_asset_id.to_string()];
    if let Some(without_prefix) = defuse_asset_id.strip_prefix("1cs_v1:")
        && let Some((_chain, rest)) = without_prefix.split_once(':')
        && !rest.is_empty()
    {
        ids.push(rest.to_string());
    }
    // Also try the balance-side id for routing aliases (BTC native → nBTC).
    let balance = balance_asset_id_from_quote(defuse_asset_id);
    if balance != defuse_asset_id {
        ids.push(balance.to_string());
    }
    ids
}

/// True when the asset id is a 1Click Omni (`1cs_v1:`) routing id.
pub fn is_one_click_routing_asset(asset_id: &str) -> bool {
    asset_id.starts_with("1cs_v1:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn btc_quote_and_balance_round_trip() {
        assert_eq!(
            quote_asset_id(NBTC_BALANCE_ASSET_ID),
            ONE_CLICK_BTC_NATIVE_ASSET_ID
        );
        assert_eq!(
            balance_asset_id_from_quote(ONE_CLICK_BTC_NATIVE_ASSET_ID),
            NBTC_BALANCE_ASSET_ID
        );
        assert_eq!(quote_asset_id("nep141:wrap.near"), "nep141:wrap.near");
    }

    #[test]
    fn price_lookup_strips_1cs_prefix() {
        assert_eq!(
            price_lookup_asset_ids("1cs_v1:near:nep141:zec.omft.near"),
            vec![
                "1cs_v1:near:nep141:zec.omft.near".to_string(),
                "nep141:zec.omft.near".to_string(),
            ]
        );
        assert_eq!(
            price_lookup_asset_ids(ONE_CLICK_BTC_NATIVE_ASSET_ID),
            vec![
                ONE_CLICK_BTC_NATIVE_ASSET_ID.to_string(),
                // Strip `1cs_v1:<chain>:` → remainder after the chain segment.
                "native:coin".to_string(),
                NBTC_BALANCE_ASSET_ID.to_string(),
            ]
        );
    }
}

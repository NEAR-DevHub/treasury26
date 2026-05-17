export const NEAR_NETWORK_ID = "near";
export const WRAP_NEAR_TOKEN_ID = "wrap.near";
export const NEP141_WRAP_NEAR_ASSET_ID = `nep141:${WRAP_NEAR_TOKEN_ID}`;

export const NEAR_COM_NETWORK_ID = "near.com";
// UI-only network id used to represent direct treasury deposits (no intents/bridge route).
// Intentionally different from NEAR_COM_NETWORK_ID ("near.com"), which represents the intents route.
export const NEAR_COM_DIRECT_NETWORK_ID = "near.com:direct";
export const NEAR_COM_NETWORK_NAME = NEAR_COM_NETWORK_ID;

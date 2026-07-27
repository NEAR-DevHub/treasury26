import { Token } from "@/components/token-input";
import { ChainIcons } from "@/lib/api";
import {
    NEAR_NETWORK_ID,
    NEP141_WRAP_NEAR_ASSET_ID,
} from "@/constants/network-ids";

export const NEAR_CHAIN_ICONS: ChainIcons = {
    icon: "https://near.com/static/icons/network/near.svg",
};

export const NEAR_TOKEN_DECIMALS = 24;

export const NEAR_COM_ICON = "/near.com.svg";

/** Native USDC contract on NEAR (Circle). */
export const USDC_NEAR_CONTRACT_ID =
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEP141_USDC_NEAR_ASSET_ID = `nep141:${USDC_NEAR_CONTRACT_ID}`;

const USDC_ICON =
    "https://s2.coinmarketcap.com/static/img/coins/128x128/3408.png";

export const default_near_token = (isConfidential: boolean) => {
    return {
        symbol: "NEAR",
        address: isConfidential ? NEP141_WRAP_NEAR_ASSET_ID : NEAR_NETWORK_ID,
        network: NEAR_NETWORK_ID,
        decimals: 24,
        icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png",
        name: "NEAR",
        chainIcons: NEAR_CHAIN_ICONS,
        residency: isConfidential ? "Intents" : "Near",
    } satisfies Token;
};

/**
 * Fallback when treasury assets aren't cached yet — USDC on NEAR (Intents).
 * Same asset id/residency for confidential and public; matches the bridge
 * token picker selection (nep141:17208628… / Intents / near).
 */
export const default_usdc_near_token = (_isConfidential?: boolean) => {
    return {
        symbol: "USDC",
        address: NEP141_USDC_NEAR_ASSET_ID,
        network: NEAR_NETWORK_ID,
        decimals: 6,
        icon: USDC_ICON,
        name: "USD Coin",
        chainIcons: NEAR_CHAIN_ICONS,
        residency: "Intents",
        minWithdrawalAmount: "1",
        minDepositAmount: "1",
    } satisfies Token;
};

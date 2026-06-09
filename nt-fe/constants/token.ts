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

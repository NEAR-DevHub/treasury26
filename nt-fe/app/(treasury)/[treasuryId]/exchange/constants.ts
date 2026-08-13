import { Token } from "@/components/token-input";

export const DRY_QUOTE_REFRESH_INTERVAL = 30000; // 30 seconds
export const PROPOSAL_REFRESH_INTERVAL = 30000; // 30 seconds

export const ETH_TOKEN = {
    address: "nep141:eth.omft.near",
    symbol: "ETH",
    decimals: 18,
    name: "ETH",
    icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/1027.png",
    network: "eth",
    chainIcons: {
        icon: "https://near.com/static/icons/network/ethereum.svg",
    },
    residency: "Intents",
} satisfies Token;

/** Current near.com BTC (nBTC). Legacy `btc.omft.near` is input-only / deprecated. */
export const BTC_TOKEN = {
    address: "nep141:nbtc.bridge.near",
    symbol: "BTC",
    decimals: 8,
    name: "Bitcoin",
    icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/1.png",
    network: "bitcoin",
    chainIcons: {
        icon: "https://near.com/static/icons/network/btc.svg",
    },
    residency: "Intents",
    balanceAssetId: "nep141:nbtc.bridge.near",
    quoteAssetId: "1cs_v1:btc:native:coin",
} satisfies Token;

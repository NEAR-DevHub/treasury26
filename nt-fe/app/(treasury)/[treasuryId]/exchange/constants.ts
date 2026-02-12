import { Token } from "@/components/token-input";

export const DRY_QUOTE_REFRESH_INTERVAL = 15000; // 15 seconds
export const PROPOSAL_REFRESH_INTERVAL = 30000; // 30 seconds

export const ETH_TOKEN = {
    address: "nep141:eth.omft.near",
    symbol: "ETH",
    decimals: 18,
    name: "ETH",
    icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/1027.png",
    network: "eth",
    chainIcons: {
        dark: "https://near-intents.org/static/icons/network/ethereum_white.svg",
        light: "https://near-intents.org/static/icons/network/ethereum.svg"
    },
    residency: "Intents"
} satisfies Token;


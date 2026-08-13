import type { ChainIcons } from "@/lib/api";
import { NEAR_COM_ICON } from "@/constants/token";
import {
    NEAR_COM_DIRECT_NETWORK_ID,
    NEAR_COM_NETWORK_ID,
    NEAR_COM_NETWORK_NAME,
} from "@/constants/network-ids";

/**
 * Display labels aligned with near.com / defuse-frontend
 * `getBlockchainsOptions()` (DefuseSDK/constants/blockchains.tsx).
 * Keys are lowercased API / metadata names (short ids and full phrases).
 */
const NETWORK_DISPLAY_NAMES: Record<string, string> = {
    eth: "Ethereum",
    ethereum: "Ethereum",
    near: "NEAR",
    btc: "Bitcoin",
    bitcoin: "Bitcoin",
    sol: "Solana",
    solana: "Solana",
    arb: "Arbitrum",
    arbitrum: "Arbitrum",
    base: "Base",
    pol: "Polygon",
    polygon: "Polygon",
    bsc: "BNB Smart Chain",
    "bnb smart chain": "BNB Smart Chain",
    trx: "Tron",
    tron: "Tron",
    xlm: "Stellar",
    stellar: "Stellar",
    apt: "Aptos",
    aptos: "Aptos",
    ada: "Cardano",
    cardano: "Cardano",
    doge: "Dogecoin",
    dogecoin: "Dogecoin",
    zec: "Zcash",
    zcash: "Zcash",
    xrp: "XRP Ledger",
    xrpledger: "XRP Ledger",
    "xrp ledger": "XRP Ledger",
    bera: "BeraChain",
    berachain: "BeraChain",
    gnosis: "Gnosis",
    optimism: "Optimism",
    op: "Optimism",
    avalanche: "Avalanche",
    avax: "Avalanche",
    sui: "Sui",
    ton: "TON",
    hyperliquid: "Hyperliquid",
    hypercore: "Hyperliquid",
    litecoin: "Litecoin",
    ltc: "Litecoin",
    bitcoincash: "Bitcoin Cash",
    bch: "Bitcoin Cash",
    "bitcoin cash": "Bitcoin Cash",
    starknet: "Starknet",
    scroll: "Scroll",
    plasma: "Plasma",
    monad: "Monad",
    layerx: "X Layer",
    xlayer: "X Layer",
    aurora: "Aurora",
    turbochain: "TurboChain",
    tuxappchain: "TuxaChain",
    vertex: "Vertex",
    optima: "Optima",
    easychain: "EasyChain",
    hako: "Hako",
    aleo: "Aleo",
    dash: "Dash",
    adi: "ADI",
};

export function getNetworkDisplayName(name: string): string {
    return NETWORK_DISPLAY_NAMES[name.toLowerCase()] ?? name;
}

/**
 * Warning admin + bridge metadata sometimes disagree on short vs long chain
 * ids (`arb` vs `arbitrum`, `eth` vs `ethereum`). Treat them as the same when
 * they share a display name (or match exactly, case-insensitive).
 */
export function networksMatchForWarningScope(
    a?: string | null,
    b?: string | null,
): boolean {
    const left = a?.trim().toLowerCase();
    const right = b?.trim().toLowerCase();
    if (!left || !right) return false;
    if (left === right) return true;
    return (
        getNetworkDisplayName(left).toLowerCase() ===
        getNetworkDisplayName(right).toLowerCase()
    );
}

export function isNearComNetwork(value?: string | null): boolean {
    const normalized = value?.toLowerCase();
    return (
        normalized === NEAR_COM_NETWORK_ID ||
        normalized === NEAR_COM_DIRECT_NETWORK_ID
    );
}

/**
 * True only when the payment's receive network is exactly `near.com`
 * (intra-Intents). Cross-chain 1Click legs, `near.com:direct`, and bare
 * `near` are not near.com payment routes — so no `nearcom:` prefix.
 *
 * Accepts either a destination id string or a payment-shaped object with
 * `destinationAssetId`. Quote metadata fields on the object are ignored.
 */
export function isNearComPaymentRoute(
    destinationOrPayment?:
        | string
        | null
        | {
              destinationAssetId?: string;
              depositAddress?: string;
              quoteSignature?: string;
              networkFee?: string;
          },
): boolean {
    const destinationAssetId =
        typeof destinationOrPayment === "string" || destinationOrPayment == null
            ? destinationOrPayment
            : destinationOrPayment.destinationAssetId;
    return destinationAssetId?.trim().toLowerCase() === NEAR_COM_NETWORK_ID;
}

export function getNearComChainIcons(): ChainIcons {
    return {
        icon: NEAR_COM_ICON,
    };
}

export function formatNearComNetworkLabel({
    networkLabel,
}: {
    networkLabel: string;
}): string {
    return `NEAR (${NEAR_COM_NETWORK_NAME}) ${networkLabel}`;
}

export function getLocalizedNetworkDisplayName({
    networkName,
    networkLabel,
    fallbackName,
    expandNearComLabel = false,
}: {
    networkName: string;
    networkLabel: string;
    fallbackName: string;
    expandNearComLabel?: boolean;
}): string {
    if (isNearComNetwork(networkName)) {
        return expandNearComLabel
            ? formatNearComNetworkLabel({ networkLabel })
            : fallbackName;
    }
    return fallbackName;
}

export function getNetworkDisplayCaseClass(
    networkName: string,
    nonNearComCase: "capitalize" | "uppercase" = "capitalize",
): string {
    // near.com brand label + NEAR acronym: don't title-case via CSS.
    // Pair with `getNetworkDisplayName` so `near` renders as "NEAR".
    if (
        isNearComNetwork(networkName) ||
        networkName.trim().toLowerCase() === "near"
    ) {
        return "normal-case";
    }
    return nonNearComCase;
}

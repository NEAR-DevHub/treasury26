import { NEAR_NETWORK_ID } from "@/constants/network-ids";

/**
 * Maps chainName from backend to blockchain identifiers for address validation
 *
 * This utility helps determine which blockchain validation to use based on the
 * network/chainName provided by the token data
 */

export type BlockchainType =
    | typeof NEAR_NETWORK_ID
    | "bitcoin"
    | "bitcoincash"
    | "litecoin"
    | "dash"
    | "ethereum"
    | "starknet"
    | "aleo"
    | "solana"
    | "tron"
    | "ton"
    | "zcash"
    | "dogecoin"
    | "xrp"
    | "stellar"
    | "sui"
    | "aptos"
    | "cardano"
    | "unknown";

/**
 * Maps a chainName (from token data) to a blockchain type for validation
 */
export function getBlockchainType(chainName: string): BlockchainType {
    const chainLower = chainName.toLowerCase();

    // NEAR chains
    if (chainLower === NEAR_NETWORK_ID) {
        return NEAR_NETWORK_ID;
    }

    // Bitcoin
    if (chainLower === "bitcoin" || chainLower === "btc") {
        return "bitcoin";
    }

    // Bitcoin Cash
    if (chainLower === "bitcoincash" || chainLower === "bch") {
        return "bitcoincash";
    }

    // Litecoin
    if (chainLower === "litecoin" || chainLower === "ltc") {
        return "litecoin";
    }

    // Dash
    if (chainLower === "dash") {
        return "dash";
    }

    // Ethereum and EVM chains
    const evmChains = new Set([
        "eth",
        "ethereum",
        "arbitrum",
        "arb",
        "gnosis",
        "berachain",
        "bera",
        "base",
        "polygon",
        "pol",
        "bsc",
        "binance",
        "optimism",
        "op",
        "avalanche",
        "avax",
        "aurora",
        "turbochain",
        "vertex",
        "easychain",
        "hako",
        "optima",
        "tuxappchain",
        "aurora_devnet",
        "layerx",
        "xlayer",
        "monad",
        "scroll",
        "plasma",
        "adi",
    ]);
    if (evmChains.has(chainLower)) {
        return "ethereum";
    }

    // Solana
    if (chainLower === "solana" || chainLower === "sol") {
        return "solana";
    }

    // Tron
    if (chainLower === "tron" || chainLower === "trx") {
        return "tron";
    }

    // Zcash
    if (chainLower === "zcash" || chainLower === "zec") {
        return "zcash";
    }

    // Dogecoin
    if (chainLower === "dogecoin" || chainLower === "doge") {
        return "dogecoin";
    }

    // XRP/Ripple
    if (
        chainLower === "xrp" ||
        chainLower === "ripple" ||
        chainLower === "xrpledger"
    ) {
        return "xrp";
    }

    // Stellar
    if (chainLower === "stellar" || chainLower === "xlm") {
        return "stellar";
    }

    // Sui
    if (chainLower === "sui") {
        return "sui";
    }

    // Aptos
    if (chainLower === "aptos" || chainLower === "apt") {
        return "aptos";
    }

    // Cardano
    if (chainLower === "cardano" || chainLower === "ada") {
        return "cardano";
    }

    // TON
    if (chainLower === "ton") {
        return "ton";
    }

    // Starknet
    if (chainLower === "starknet") {
        return "starknet";
    }

    // Aleo
    if (chainLower === "aleo") {
        return "aleo";
    }

    // Hyperliquid (treat as EVM-compatible for now, though it may need special handling)
    if (chainLower === "hyperliquid") {
        return "ethereum";
    }

    console.log(
        `⚠️  UNKNOWN BLOCKCHAIN: "${chainName}" - No validation available!`,
    );
    return "unknown";
}

/**
 * Check if a token is on NEAR blockchain
 */
export function isNearToken(chainName?: string, residency?: string): boolean {
    if (!chainName) return true; // Default to NEAR if no chainName
    return getBlockchainType(chainName) === NEAR_NETWORK_ID;
}

/**
 * Check if a token requires cross-chain address validation
 */
export function requiresCrossChainValidation(
    chainName?: string,
    residency?: string,
): boolean {
    if (!chainName) return false;
    const blockchainType = getBlockchainType(chainName);
    return blockchainType !== NEAR_NETWORK_ID && blockchainType !== "unknown";
}

/**
 * Get the explorer URL for a given blockchain and address
 */
export function getExplorerAddressUrl(
    chainName: string,
    address: string,
): string | null {
    const blockchainType = getBlockchainType(chainName);
    const chainLower = chainName.toLowerCase();

    switch (blockchainType) {
        case NEAR_NETWORK_ID:
            return `https://nearblocks.io/address/${address}`;

        case "ethereum":
            // Map specific EVM chains to their explorers
            if (chainLower === "arbitrum" || chainLower === "arb") {
                return `https://arbiscan.io/address/${address}`;
            }
            if (chainLower === "polygon" || chainLower === "pol") {
                return `https://polygonscan.com/address/${address}`;
            }
            if (chainLower === "bsc" || chainLower === "binance") {
                return `https://bscscan.com/address/${address}`;
            }
            if (chainLower === "optimism" || chainLower === "op") {
                return `https://optimistic.etherscan.io/address/${address}`;
            }
            if (chainLower === "base") {
                return `https://basescan.org/address/${address}`;
            }
            if (chainLower === "avalanche" || chainLower === "avax") {
                return `https://snowtrace.io/address/${address}`;
            }
            if (chainLower === "gnosis") {
                return `https://gnosisscan.io/address/${address}`;
            }
            if (chainLower === "aurora") {
                return `https://explorer.aurora.dev/address/${address}`;
            }
            // Default to Ethereum mainnet for unspecified EVM chains
            return `https://etherscan.io/address/${address}`;

        case "bitcoin":
            return `https://blockchair.com/bitcoin/address/${address}`;

        case "bitcoincash":
            return `https://blockchair.com/bitcoin-cash/address/${address}`;

        case "litecoin":
            return `https://blockchair.com/litecoin/address/${address}`;

        case "dash":
            return `https://blockchair.com/dash/address/${address}`;

        case "starknet":
            return `https://starkscan.co/contract/${address}`;

        case "aleo":
            return `https://explorer.aleo.org/address/${address}`;

        case "ton":
            return `https://tonscan.org/address/${address}`;

        case "solana":
            return `https://solscan.io/address/${address}`;

        case "tron":
            return `https://tronscan.org/#/address/${address}`;

        case "zcash":
            return `https://blockchair.com/zcash/address/${address}`;

        case "dogecoin":
            return `https://blockchair.com/dogecoin/address/${address}`;

        case "xrp":
            return `https://xrpscan.com/account/${address}`;

        case "stellar":
            return `https://stellarchain.io/accounts/${address}`;

        case "sui":
            return `https://suiscan.xyz/mainnet/account/${address}`;

        case "aptos":
            return `https://aptoscan.com/account/${address}`;

        case "cardano":
            return `https://cardanoscan.io/address/${address}`;

        case "unknown":
        default:
            // Return null for unknown chains - no link will be shown
            return null;
    }
}

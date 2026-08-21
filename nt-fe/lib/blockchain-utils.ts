import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { getIntentsExplorerUrl } from "@/lib/utils";

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
 * Compact form of a chain label: lowercased, spaces/underscores/hyphens removed.
 * Backend `network_name_for_base` lowercases catalog *display* names
 * (e.g. "XRP Ledger" → "xrp ledger", "BNB Smart Chain" → "bnb smart chain"),
 * so matching must accept both keys and display variants.
 */
function compactChainKey(chainName: string): string {
    return chainName.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * EVM explorer origin for keys + catalog display names (shared by tx + address
 * links so they cannot diverge).
 */
function getEvmExplorerOrigin(chainName: string): string {
    const compact = compactChainKey(chainName);
    if (compact === "arbitrum" || compact === "arb") {
        return "https://arbiscan.io";
    }
    if (compact === "polygon" || compact === "pol" || compact === "matic") {
        return "https://polygonscan.com";
    }
    if (
        compact === "bsc" ||
        compact === "bnb" ||
        compact === "binance" ||
        compact === "bnbsmartchain" ||
        compact === "binancesmartchain"
    ) {
        return "https://bscscan.com";
    }
    if (compact === "optimism" || compact === "op") {
        return "https://optimistic.etherscan.io";
    }
    if (compact === "base") {
        return "https://basescan.org";
    }
    if (compact === "avalanche" || compact === "avax") {
        return "https://snowtrace.io";
    }
    if (compact === "gnosis") {
        return "https://gnosisscan.io";
    }
    if (compact === "berachain" || compact === "bera") {
        return "https://berascan.com";
    }
    if (compact === "scroll") {
        return "https://scrollscan.com";
    }
    if (compact === "aurora" || compact === "auroradevnet") {
        return "https://explorer.aurora.dev";
    }
    return "https://etherscan.io";
}

/**
 * Maps a chainName (from token data) to a blockchain type for validation
 */
export function getBlockchainType(chainName: string): BlockchainType {
    const chainLower = chainName.toLowerCase().trim();
    const compact = compactChainKey(chainName);

    // NEAR chains
    if (
        chainLower === NEAR_NETWORK_ID ||
        compact === "nearprotocol" ||
        compact === "near"
    ) {
        return NEAR_NETWORK_ID;
    }

    // Bitcoin
    if (compact === "bitcoin" || compact === "btc") {
        return "bitcoin";
    }

    // Bitcoin Cash — catalog display "Bitcoin Cash" → "bitcoin cash"
    if (compact === "bitcoincash" || compact === "bch") {
        return "bitcoincash";
    }

    // Litecoin
    if (compact === "litecoin" || compact === "ltc") {
        return "litecoin";
    }

    // Dash
    if (compact === "dash") {
        return "dash";
    }

    // Ethereum and EVM chains (keys + display-name compact forms)
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
        "matic",
        "bsc",
        "bnb",
        "binance",
        "bnbsmartchain",
        "binancesmartchain",
        "optimism",
        "op",
        "avalanche",
        "avax",
        "aurora",
        "auroradevnet",
        "turbochain",
        "vertex",
        "easychain",
        "hako",
        "optima",
        // key is tuxappchain; catalog display "TuxaChain" → "tuxachain"
        "tuxappchain",
        "tuxachain",
        "layerx",
        "xlayer",
        "monad",
        "scroll",
        "plasma",
        "adi",
        "hyperliquid",
        "hypercore",
    ]);
    if (evmChains.has(compact)) {
        return "ethereum";
    }

    // Solana
    if (compact === "solana" || compact === "sol") {
        return "solana";
    }

    // Tron
    if (compact === "tron" || compact === "trx") {
        return "tron";
    }

    // Zcash
    if (compact === "zcash" || compact === "zec") {
        return "zcash";
    }

    // Dogecoin
    if (compact === "dogecoin" || compact === "doge") {
        return "dogecoin";
    }

    // XRP/Ripple — catalog display "XRP Ledger" → "xrp ledger"
    if (compact === "xrp" || compact === "ripple" || compact === "xrpledger") {
        return "xrp";
    }

    // Stellar
    if (compact === "stellar" || compact === "xlm") {
        return "stellar";
    }

    // Sui
    if (compact === "sui") {
        return "sui";
    }

    // Aptos
    if (compact === "aptos" || compact === "apt") {
        return "aptos";
    }

    // Cardano
    if (compact === "cardano" || compact === "ada") {
        return "cardano";
    }

    // TON
    if (compact === "ton") {
        return "ton";
    }

    // Starknet
    if (compact === "starknet") {
        return "starknet";
    }

    // Aleo
    if (compact === "aleo") {
        return "aleo";
    }

    console.log(
        `⚠️  UNKNOWN BLOCKCHAIN: "${chainName}" - No validation available!`,
    );
    return "unknown";
}

/**
 * Get the explorer URL for a transaction hash, given the chain it occurred on.
 *
 * The chain comes from token/asset metadata.
 *
 * Returns null for unknown chains (no link shown).
 */
export function getExplorerTxUrl(
    chainName: string | null | undefined,
    txHash: string,
): string | null {
    if (!chainName) return null;

    const blockchainType = getBlockchainType(chainName);

    switch (blockchainType) {
        case NEAR_NETWORK_ID:
            return `https://nearblocks.io/txns/${txHash}`;

        case "ethereum":
            return `${getEvmExplorerOrigin(chainName)}/tx/${txHash}`;

        case "bitcoin":
            return `https://blockchair.com/bitcoin/transaction/${txHash}`;

        case "bitcoincash":
            return `https://blockchair.com/bitcoin-cash/transaction/${txHash}`;

        case "litecoin":
            return `https://blockchair.com/litecoin/transaction/${txHash}`;

        case "dash":
            return `https://blockchair.com/dash/transaction/${txHash}`;

        case "starknet":
            return `https://starkscan.co/tx/${txHash}`;

        case "aleo":
            return `https://explorer.aleo.org/transaction/${txHash}`;

        case "ton":
            return `https://tonscan.org/tx/${txHash}`;

        case "solana":
            return `https://solscan.io/tx/${txHash}`;

        case "tron":
            return `https://tronscan.org/#/transaction/${txHash}`;

        case "zcash":
            return `https://blockchair.com/zcash/transaction/${txHash}`;

        case "dogecoin":
            return `https://blockchair.com/dogecoin/transaction/${txHash}`;

        case "xrp":
            return `https://xrpscan.com/tx/${txHash}`;

        case "stellar":
            return `https://stellarchain.io/transactions/${txHash}`;

        case "sui":
            return `https://suiscan.xyz/mainnet/tx/${txHash}`;

        case "aptos":
            return `https://explorer.aptoslabs.com/txn/${txHash}`;

        case "cardano":
            return `https://cardanoscan.io/transaction/${txHash}`;

        case "unknown":
        default:
            return null;
    }
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
 * Get the explorer URL for a given blockchain and address.
 * EVM sub-chains use the same compact-key mapping as {@link getExplorerTxUrl}.
 */
export function getExplorerAddressUrl(
    chainName: string,
    address: string,
): string | null {
    const blockchainType = getBlockchainType(chainName);

    switch (blockchainType) {
        case NEAR_NETWORK_ID:
            return `https://nearblocks.io/address/${address}`;

        case "ethereum":
            return `${getEvmExplorerOrigin(chainName)}/address/${address}`;

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

export type TransactionExplorerLink = {
    url: string;
    source: "intents" | "chain";
};

/**
 * Universal explorer-link resolver for transaction rows.
 *
 * Intents-routed rows (any transfer, deposit or exchange carrying a 1Click
 * deposit address) link to the NEAR Intents explorer — `/mask/` for
 * confidential treasuries, `/transactions/` for public ones. Everything else
 * falls back to the per-chain tx explorer (nearblocks for NEAR). Rows whose
 * token metadata carries no chain are NEAR movements.
 */
export function getTransactionExplorerLink({
    depositAddress,
    isConfidential = false,
    transactionHash,
    chainName,
}: {
    depositAddress?: string | null;
    isConfidential?: boolean;
    transactionHash?: string | null;
    chainName?: string | null;
}): TransactionExplorerLink | null {
    const intentsUrl = getIntentsExplorerUrl(depositAddress, isConfidential);
    if (intentsUrl) return { url: intentsUrl, source: "intents" };
    if (!transactionHash) return null;
    const url = getExplorerTxUrl(chainName ?? NEAR_NETWORK_ID, transactionHash);
    return url ? { url, source: "chain" } : null;
}

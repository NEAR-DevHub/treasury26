/**
 * Centralized Address Validation for All Blockchains
 *
 * This module provides validation functions for cryptocurrency addresses
 * across multiple blockchains. All validation is regex-based for format checking.
 */

import { BlockchainType } from "./blockchain-utils";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

/**
 * Validation result with optional error message
 */
export interface ValidationResult {
    isValid: boolean;
    error?: string;
}

/**
 * Address validation patterns for each blockchain
 */
const ADDRESS_PATTERNS: Record<BlockchainType, RegExp | null> = {
    near: null, // NEAR has custom validation logic in near-validation.ts
    // Legacy P2PKH/P2SH (Base58), SegWit v0 (bech32) and Taproot (bech32m).
    // Bech32 data part excludes "1bio" and must not be mixed-case, so the
    // all-uppercase form is matched as a separate alternative.
    bitcoin:
        /^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{39,59}|BC1[AC-HJ-NP-Z02-9]{39,59})$/,
    bitcoincash:
        /^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bitcoincash:[qp][a-z0-9]{41})$/,
    litecoin: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
    dash: /^X[1-9A-HJ-NP-Za-km-z]{33}$/,
    ethereum: /^0x[a-fA-F0-9]{40}$/,
    starknet: /^0x[a-fA-F0-9]{1,64}$/,
    aleo: /^aleo1[a-z0-9]{58}$/,
    solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    ton: /^[UE][Qq][a-zA-Z0-9_-]{46}$/,
    zcash: /^(t1|t3)[a-zA-HJ-NP-Z0-9]{33}$|^zc[a-z0-9]{76}$/i,
    dogecoin: /^[DA][a-km-zA-HJ-NP-Z1-9]{33}$/,
    xrp: /^r[1-9A-HJ-NP-Za-km-z]{25,34}$/,
    stellar: /^G[A-Z2-7]{55}$/,
    sui: /^0x[a-fA-F0-9]{64}$/,
    aptos: /^0x[a-fA-F0-9]{1,64}$/,
    cardano: /^(addr1|stake1)[a-z0-9]{53,103}$/i,
    unknown: null,
};

/**
 * User-friendly blockchain names for error messages
 */
const BLOCKCHAIN_DISPLAY_NAMES: Record<BlockchainType, string> = {
    near: "NEAR",
    bitcoin: "Bitcoin",
    bitcoincash: "Bitcoin Cash",
    litecoin: "Litecoin",
    dash: "Dash",
    ethereum: "Ethereum",
    starknet: "Starknet",
    aleo: "Aleo",
    solana: "Solana",
    tron: "Tron",
    ton: "TON",
    zcash: "Zcash",
    dogecoin: "Dogecoin",
    xrp: "XRP",
    stellar: "Stellar",
    sui: "Sui",
    aptos: "Aptos",
    cardano: "Cardano",
    unknown: "Unknown",
};

/**
 * Address format examples for each blockchain
 */
export const ADDRESS_EXAMPLES: Record<BlockchainType, string> = {
    near: "alice.near, 0x..., or 64-char hex",
    bitcoin: "bc1...",
    bitcoincash: "1... or bitcoincash:q...",
    litecoin: "L... or M...",
    dash: "X...",
    ethereum: "0x...",
    starknet: "0x...",
    aleo: "aleo1...",
    solana: "7xKXtg...",
    tron: "T...",
    ton: "UQ... or EQ...",
    zcash: "t1...",
    dogecoin: "D...",
    xrp: "r...",
    stellar: "G...",
    sui: "0x...",
    aptos: "0x...",
    cardano: "addr1...",
    unknown: "",
};

/**
 * Helper function to generate placeholder text
 */
const placeholder = (example: string) =>
    example ? `Recipient address (e.g.: ${example})` : "Recipient address";

/**
 * Placeholder text for address inputs by blockchain
 */
export const ADDRESS_PLACEHOLDERS: Record<BlockchainType, string> = {
    near: placeholder(ADDRESS_EXAMPLES.near),
    bitcoin: placeholder(ADDRESS_EXAMPLES.bitcoin),
    bitcoincash: placeholder(ADDRESS_EXAMPLES.bitcoincash),
    litecoin: placeholder(ADDRESS_EXAMPLES.litecoin),
    dash: placeholder(ADDRESS_EXAMPLES.dash),
    ethereum: placeholder(ADDRESS_EXAMPLES.ethereum),
    starknet: placeholder(ADDRESS_EXAMPLES.starknet),
    aleo: placeholder(ADDRESS_EXAMPLES.aleo),
    solana: placeholder(ADDRESS_EXAMPLES.solana),
    tron: placeholder(ADDRESS_EXAMPLES.tron),
    ton: placeholder(ADDRESS_EXAMPLES.ton),
    zcash: placeholder(ADDRESS_EXAMPLES.zcash),
    dogecoin: placeholder(ADDRESS_EXAMPLES.dogecoin),
    xrp: placeholder(ADDRESS_EXAMPLES.xrp),
    stellar: placeholder(ADDRESS_EXAMPLES.stellar),
    sui: placeholder(ADDRESS_EXAMPLES.sui),
    aptos: placeholder(ADDRESS_EXAMPLES.aptos),
    cardano: placeholder(ADDRESS_EXAMPLES.cardano),
    unknown: placeholder(ADDRESS_EXAMPLES.unknown),
};

/**
 * Validate address format for a specific blockchain
 *
 * @param address - The address to validate
 * @param blockchain - The blockchain type
 * @returns ValidationResult with isValid flag and optional error message
 */
export function validateAddress(
    address: string,
    blockchain: BlockchainType,
): ValidationResult {
    // Empty address
    if (!address || address.trim() === "") {
        return {
            isValid: false,
            error: "Address is required",
        };
    }

    const trimmedAddress = address.trim();

    // NEAR addresses are handled by near-validation.ts
    if (blockchain === NEAR_NETWORK_ID) {
        // For synchronous validation, we can only check format
        // Full validation (including blockchain check) must be done async
        return {
            isValid: true, // Assume valid for now, actual validation happens in near-validation.ts
            error: undefined,
        };
    }

    // Unknown blockchain type - accept any non-empty address
    if (blockchain === "unknown") {
        console.warn(
            `[Address Validation] Unknown blockchain - accepting address without validation: "${trimmedAddress}"`,
        );
        return {
            isValid: true,
            error: undefined,
        };
    }

    // Get the regex pattern for this blockchain
    const pattern = ADDRESS_PATTERNS[blockchain];

    if (!pattern) {
        // No pattern available, but blockchain is known - accept any non-empty address
        console.warn(
            `[Address Validation] No pattern for ${BLOCKCHAIN_DISPLAY_NAMES[blockchain]} - accepting address without validation: "${trimmedAddress}"`,
        );
        return {
            isValid: true,
            error: undefined,
        };
    }

    // Test address against pattern
    const isValid = pattern.test(trimmedAddress);

    return {
        isValid,
        error: isValid
            ? undefined
            : `Invalid ${BLOCKCHAIN_DISPLAY_NAMES[blockchain]} address format`,
    };
}

/**
 * Get the regex pattern for a blockchain (useful for real-time validation)
 *
 * @param blockchain - The blockchain type
 * @returns RegExp pattern or null if not applicable
 */
export function getAddressPattern(blockchain: BlockchainType): RegExp | null {
    return ADDRESS_PATTERNS[blockchain];
}

/**
 * Get placeholder text for an address input
 *
 * @param blockchain - The blockchain type
 * @returns Placeholder text
 */
export function getAddressPlaceholder(blockchain: BlockchainType): string {
    return ADDRESS_PLACEHOLDERS[blockchain];
}

/**
 * Get the address format example for a blockchain (e.g. "bc1...", "0x...").
 * Returns "" for unknown chain.
 */
export function getAddressExample(blockchain: BlockchainType): string {
    return ADDRESS_EXAMPLES[blockchain] ?? "";
}

/**
 * Quick validation check (returns just boolean)
 *
 * @param address - The address to validate
 * @param blockchain - The blockchain type
 * @returns true if valid, false otherwise
 */
export function isValidAddress(
    address: string,
    blockchain: BlockchainType,
): boolean {
    return validateAddress(address, blockchain).isValid;
}

/**
 * Get user-friendly blockchain name
 *
 * @param blockchain - The blockchain type
 * @returns Display name
 */
export function getBlockchainDisplayName(blockchain: BlockchainType): string {
    return BLOCKCHAIN_DISPLAY_NAMES[blockchain];
}

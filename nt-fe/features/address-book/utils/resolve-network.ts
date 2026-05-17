import type { ChainInfo } from "../chains";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

/**
 * Build a case-insensitive lookup map from various network name aliases to chain keys.
 */
export function buildNetworkLookup(chains: ChainInfo[]): Map<string, string> {
    const map = new Map<string, string>();

    for (const chain of chains) {
        map.set(chain.key.toLowerCase(), chain.key);
        map.set(chain.name.toLowerCase(), chain.key);
    }

    // Common aliases not covered by key/name
    const aliases: Record<string, string> = {
        "near protocol": NEAR_NETWORK_ID,
        ethereum: "eth",
        ether: "eth",
        bnb: "bsc",
        "bnb smart chain": "bsc",
        binance: "bsc",
        btc: "bitcoin",
        sol: "solana",
        doge: "dogecoin",
        trx: "tron",
        pol: "polygon",
        matic: "polygon",
        arb: "arbitrum",
        op: "optimism",
        avax: "avalanche",
        xrp: "xrpledger",
        ripple: "xrpledger",
        "xrp ledger": "xrpledger",
    };

    for (const [alias, chainKey] of Object.entries(aliases)) {
        // Only add alias if the target chain actually exists
        if (chains.some((c) => c.key === chainKey)) {
            map.set(alias.toLowerCase(), chainKey);
        }
    }

    return map;
}

/**
 * Resolve a user-provided network string to a chain key.
 * Returns the chain key or null if not found.
 */
export function resolveNetworkName(
    networkInput: string,
    lookup: Map<string, string>,
): string | null {
    const normalized = networkInput.trim().toLowerCase();
    return lookup.get(normalized) ?? null;
}

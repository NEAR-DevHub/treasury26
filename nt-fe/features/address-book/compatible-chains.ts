import { getBlockchainType } from "@/lib/blockchain-utils";
import { getAddressPattern } from "@/lib/address-validation";
import { isValidNearAddressFormat } from "@/lib/near-validation";
import {
    isNearComRecipientAddress,
    parseNearComAddress,
} from "@/lib/nearcom-address";
import type { ChainInfo } from "./chains";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";

/**
 * Given a validated address, returns the subset of known chains that are
 * compatible with it.
 *
 * Rules:
 * - `nearcom:` + valid NEAR account → only `near.com` (same gate as payments).
 * - `nearcom:` without a valid NEAR account → no networks.
 * - If the address passes isValidNearAddressFormat → "near" chain is included.
 *   This covers native NEAR addresses AND 0x EVM addresses (which are valid on
 *   NEAR's EVM layer).
 * - Any other chain whose address pattern matches → included.
 * - `near.com` is never compatible without the prefix.
 * - Chains with no pattern (unknown) → excluded.
 */
export function getCompatibleChains(
    address: string,
    chains: ChainInfo[],
): ChainInfo[] {
    if (!address) return [];

    if (isNearComRecipientAddress(address)) {
        return chains.filter((chain) => chain.key === NEAR_COM_NETWORK_ID);
    }

    if (parseNearComAddress(address).hasPrefix) {
        return [];
    }

    const nearCompatible = isValidNearAddressFormat(address);

    return chains.filter((chain) => {
        if (chain.key === NEAR_COM_NETWORK_ID) return false;
        if (chain.key === NEAR_NETWORK_ID) return nearCompatible;

        const blockchainType = getBlockchainType(chain.key);
        if (blockchainType === "unknown") return false;

        const pattern = getAddressPattern(blockchainType);
        if (!pattern) return false;

        return pattern.test(address);
    });
}

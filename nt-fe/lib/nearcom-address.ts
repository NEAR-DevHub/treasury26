import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";

/** Prefix for confidential near.com deposit / payment recipients. */
export const NEAR_COM_ADDRESS_PREFIX = "nearcom:";

export function hasNearComAddressPrefix(
    address: string | null | undefined,
): boolean {
    return (address ?? "")
        .trim()
        .toLowerCase()
        .startsWith(NEAR_COM_ADDRESS_PREFIX);
}

/** Strip a leading `nearcom:` (case-insensitive). */
export function stripNearComAddressPrefix(address: string): string {
    const trimmed = address.trim();
    if (
        trimmed.length >= NEAR_COM_ADDRESS_PREFIX.length &&
        trimmed.slice(0, NEAR_COM_ADDRESS_PREFIX.length).toLowerCase() ===
            NEAR_COM_ADDRESS_PREFIX
    ) {
        return trimmed.slice(NEAR_COM_ADDRESS_PREFIX.length);
    }
    return trimmed;
}

/** Ensure address is stored/displayed with a `nearcom:` prefix. */
export function withNearComAddressPrefix(address: string): string {
    const bare = stripNearComAddressPrefix(address);
    return `${NEAR_COM_ADDRESS_PREFIX}${bare}`;
}

export function parseNearComAddress(address: string): {
    hasPrefix: boolean;
    accountId: string;
} {
    const hasPrefix = hasNearComAddressPrefix(address);
    return {
        hasPrefix,
        accountId: hasPrefix
            ? stripNearComAddressPrefix(address)
            : address.trim(),
    };
}

/**
 * Display-only: add `nearcom:` when the receive network is exactly `near.com`
 * (intra-Intents). Same rule for public/confidential payment + bulk request
 * details, receipts, and review UI. Never for `near`, `near.com:direct`,
 * bridge chains, or when destination is unknown. Explorer / profile / 1Click
 * must keep using the bare account.
 */
export function formatRecipientForNearComDestination(
    address: string,
    destinationNetwork?: string | null,
): string {
    const trimmed = address.trim();
    if (!trimmed) {
        return address;
    }
    if (destinationNetwork?.trim().toLowerCase() !== NEAR_COM_NETWORK_ID) {
        return trimmed;
    }
    return withNearComAddressPrefix(trimmed);
}

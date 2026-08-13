import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";

/** Prefix for near.com payment / deposit recipients (public + confidential). */
export const NEAR_COM_ADDRESS_PREFIX = "nearcom:";

/** Base URL for the near.com send flow (apps/defuse-near). */
export const NEAR_COM_SEND_URL = "https://near.com/send";

/**
 * Network id apps/defuse-near expects for near.com internal / intents
 * destinations (`nearcom:` recipients).
 */
export const NEAR_COM_SEND_INTERNAL_NETWORK = "near_intents";

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

export type NearComSendPrefill = {
    /** Token symbol to receive / destination asset. */
    token?: string | null;
    /** Destination chain (e.g. eth, near_intents). */
    network?: string | null;
    /** Recipient address (may include `nearcom:` for internal destinations). */
    recipient?: string | null;
    /**
     * Asset the payer sends. Deposit quotes use origin === destination, so
     * callers should pass the same value as `token`.
     */
    paymentToken?: string | null;
};

/**
 * Build a near.com/send deep link with the query params apps/defuse-near reads
 * (`token`, `network`, `recipient`, `paymentToken`).
 */
export function buildNearComSendHref(prefill: NearComSendPrefill): string {
    const url = new URL(NEAR_COM_SEND_URL);
    const entries: [keyof NearComSendPrefill, string | null | undefined][] = [
        ["token", prefill.token],
        ["network", prefill.network],
        ["recipient", prefill.recipient],
        ["paymentToken", prefill.paymentToken],
    ];
    for (const [key, value] of entries) {
        const trimmed = value?.trim();
        if (trimmed) url.searchParams.set(key, trimmed);
    }
    return url.toString();
}

import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { getBlockchainType, type BlockchainType } from "@/lib/blockchain-utils";
import {
    hasNearComAddressPrefix,
    parseNearComAddress,
    stripNearComAddressPrefix,
    withNearComAddressPrefix,
} from "@/lib/nearcom-address";

export type AddressBookLike = {
    address: string;
    networks?: readonly string[];
};

export function isNearComAddressBookEntry(entry: AddressBookLike): boolean {
    return (
        hasNearComAddressPrefix(entry.address) ||
        (entry.networks?.includes(NEAR_COM_NETWORK_ID) ?? false)
    );
}

/**
 * Resolve a saved contact for a typed/payment recipient.
 *
 * near.com vs NEAR are different contacts. A prefixed recipient only matches a
 * near.com row (prefix on the stored address and/or `networks` includes
 * `near.com`). A bare recipient only matches a non-near.com row. Same bare
 * account is not enough — that was the old strip-prefix fallback.
 */
export function findAddressBookEntry<T extends AddressBookLike>(
    entries: readonly T[],
    address: string | null | undefined,
): T | undefined {
    if (!address?.trim()) return undefined;
    const { hasPrefix, accountId } = parseNearComAddress(address);
    const bare = accountId.trim().toLowerCase();
    if (!bare) return undefined;

    return entries.find((entry) => {
        const entryBare = stripNearComAddressPrefix(entry.address)
            .trim()
            .toLowerCase();
        if (entryBare !== bare) return false;
        return hasPrefix === isNearComAddressBookEntry(entry);
    });
}

/** Recipients list / chips: show `nearcom:` for any near.com contact. */
export function formatAddressBookDisplayAddress(
    entry: AddressBookLike,
): string {
    if (isNearComAddressBookEntry(entry)) {
        return withNearComAddressPrefix(entry.address);
    }
    return entry.address;
}

/** Persist `nearcom:` when the contact is on near.com so storage matches display. */
export function persistAddressBookAddress(entry: AddressBookLike): string {
    return formatAddressBookDisplayAddress(entry);
}

/**
 * Bulk / locked-destination filter. Pair of getCompatibleChains: that maps an
 * address shape to networks; this maps a saved contact to a destination id.
 */
export function addressBookEntryMatchesNetwork(
    entry: AddressBookLike,
    selectedNetworkName: string,
    blockchainType: BlockchainType,
): boolean {
    const networks = entry.networks ?? [];
    if (networks.length === 0) return true;
    if (selectedNetworkName.trim().toLowerCase() === NEAR_COM_NETWORK_ID) {
        return networks.includes(NEAR_COM_NETWORK_ID);
    }
    return networks.some(
        (key) =>
            key !== NEAR_COM_NETWORK_ID &&
            getBlockchainType(key) === blockchainType,
    );
}

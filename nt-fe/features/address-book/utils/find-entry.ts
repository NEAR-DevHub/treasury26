import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import {
    hasNearComAddressPrefix,
    withNearComAddressPrefix,
} from "@/lib/nearcom-address";

type AddressBookLike = {
    address: string;
    networks?: readonly string[];
};

/** Exact address match, including a `nearcom:` prefix. Does not strip. */
export function findAddressBookEntry<T extends AddressBookLike>(
    entries: readonly T[],
    address: string | null | undefined,
): T | undefined {
    const normalized = address?.trim().toLowerCase();
    if (!normalized) return undefined;
    return entries.find(
        (entry) => entry.address.trim().toLowerCase() === normalized,
    );
}

/** Recipients list / chips: show `nearcom:` for near.com contacts. */
export function formatAddressBookDisplayAddress(
    entry: AddressBookLike,
): string {
    if (
        hasNearComAddressPrefix(entry.address) ||
        entry.networks?.includes(NEAR_COM_NETWORK_ID)
    ) {
        return withNearComAddressPrefix(entry.address);
    }
    return entry.address;
}

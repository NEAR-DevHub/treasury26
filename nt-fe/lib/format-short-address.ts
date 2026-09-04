/** Payment UI default: first 6 + "..." + last 6, matching the recipient modal. */
export const SHORT_ADDRESS_PREFIX_LENGTH = 6;
export const SHORT_ADDRESS_SUFFIX_LENGTH = 6;

/**
 * Collapse a long address to `start...end` so every send / bulk step shows
 * the same middle-ellipsis pattern as the recipient picker.
 */
export function formatShortAddress(
    address: string,
    prefixLength = SHORT_ADDRESS_PREFIX_LENGTH,
    suffixLength = SHORT_ADDRESS_SUFFIX_LENGTH,
): string {
    if (address.length <= prefixLength + suffixLength) return address;
    return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
}

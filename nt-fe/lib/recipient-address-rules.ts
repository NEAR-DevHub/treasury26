/**
 * Destination vs recipient address rules.
 *
 * - `checkRecipientAddressFormat` — authority for the address field (prefix +
 *   account / chain format). Use this to show input errors.
 * - `canAddressUseDestination` — authority for the network picker only. For
 *   near.com it accepts a valid prefix even when the account is still incomplete
 *   so the option does not vanish while the user types.
 */
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { isValidAddress } from "@/lib/address-validation";
import { type BlockchainType, getBlockchainType } from "@/lib/blockchain-utils";
import { isNearComNetwork } from "@/lib/intents-network";
import { isValidNearAddressFormat } from "@/lib/near-address-format";
import {
    hasNearComAddressPrefix,
    parseNearComAddress,
} from "@/lib/nearcom-address";

export type RecipientAddressIssue =
    | "nearComPrefixRequired"
    | "nearComPrefixNotAllowed"
    | "invalidFormat"
    /** No destination picked yet, so no address format to check against. */
    | "unknownDestination";

type DestinationInput = {
    /** Chain name or near.com destination id (e.g. "near", "near.com", "eth"). */
    network: string | null | undefined;
    /**
     * Overrides how the near.com route is detected. The network picker passes
     * the option id, which is what distinguishes near.com from bare NEAR.
     */
    isNearComDestination?: boolean;
};

/**
 * near.com destinations arrive as a UI-only network id, which
 * `getBlockchainType` reports as "unknown" because it is not a chain address
 * format. Their recipients are ordinary NEAR accounts.
 */
export function resolveRecipientBlockchain(
    network: string | null | undefined,
): BlockchainType {
    if (!network) return "unknown";
    if (isNearComNetwork(network)) return NEAR_NETWORK_ID;
    return getBlockchainType(network);
}

/**
 * The `nearcom:` prefix selects the near.com route rather than being part of
 * the address, so it is required for that destination and meaningless for any
 * other. Single source of truth for the network picker, the recipient modal
 * and the address input, which each used to decide this for themselves and
 * disagreed: an address like `nearcom:someone.near` was accepted for a bare
 * NEAR destination and then cleared by the picker as incompatible.
 *
 * Prefix presence only — a half-typed account still names the near.com route,
 * so callers can report format problems separately without the destination
 * flipping mid-typing.
 */
export function nearComPrefixIssue({
    address,
    isNearComDestination,
}: {
    address: string;
    isNearComDestination: boolean;
}): "nearComPrefixRequired" | "nearComPrefixNotAllowed" | null {
    const hasPrefix = hasNearComAddressPrefix(address);
    if (isNearComDestination) {
        return hasPrefix ? null : "nearComPrefixRequired";
    }
    return hasPrefix ? "nearComPrefixNotAllowed" : null;
}

const isNearCom = ({ network, isNearComDestination }: DestinationInput) =>
    isNearComDestination ?? isNearComNetwork(network);

/**
 * Full format check for recipient address fields. On-chain existence is the
 * caller's job — this stays synchronous.
 */
export function checkRecipientAddressFormat({
    address,
    ...destination
}: DestinationInput & { address: string }): RecipientAddressIssue | null {
    const trimmed = address.trim();
    if (!trimmed) return "invalidFormat";

    const nearComDestination = isNearCom(destination);
    const prefixIssue = nearComPrefixIssue({
        address: trimmed,
        isNearComDestination: nearComDestination,
    });
    if (prefixIssue) return prefixIssue;

    const blockchain = nearComDestination
        ? NEAR_NETWORK_ID
        : resolveRecipientBlockchain(destination.network);
    if (blockchain === "unknown") return "unknownDestination";

    const { accountId } = parseNearComAddress(trimmed);
    if (blockchain === NEAR_NETWORK_ID) {
        return isValidNearAddressFormat(accountId) ? null : "invalidFormat";
    }
    return isValidAddress(accountId, blockchain) ? null : "invalidFormat";
}

/**
 * Whether an address is allowed to route to a destination — used to section
 * and filter the network picker.
 *
 * Deliberately more forgiving than `checkRecipientAddressFormat` for near.com:
 * the prefix alone settles the route, so a partially typed account keeps the
 * option on screen instead of making it vanish while the user types. The
 * address field is what reports the format error.
 */
export function canAddressUseDestination({
    address,
    ...destination
}: DestinationInput & { address: string }): boolean {
    const trimmed = address.trim();
    if (!trimmed) return true;

    const nearComDestination = isNearCom(destination);
    if (
        nearComPrefixIssue({
            address: trimmed,
            isNearComDestination: nearComDestination,
        })
    ) {
        return false;
    }
    if (nearComDestination) return true;

    return (
        checkRecipientAddressFormat({ ...destination, address: trimmed }) ===
        null
    );
}

import type { ChainIcons } from "@/lib/api";
import { NEAR_COM_ICON } from "@/constants/token";
import {
    NEAR_COM_DIRECT_NETWORK_ID,
    NEAR_COM_NETWORK_ID,
    NEAR_COM_NETWORK_NAME,
} from "@/constants/network-ids";

export function isNearComNetwork(value?: string | null): boolean {
    const normalized = value?.toLowerCase();
    return (
        normalized === NEAR_COM_NETWORK_ID ||
        normalized === NEAR_COM_DIRECT_NETWORK_ID
    );
}

/**
 * True only when the payment's receive network is exactly `near.com`
 * (intra-Intents). Cross-chain 1Click legs, `near.com:direct`, and bare
 * `near` are not near.com payment routes — so no `nearcom:` prefix.
 *
 * Accepts either a destination id string or a payment-shaped object with
 * `destinationAssetId`. Quote metadata fields on the object are ignored.
 */
export function isNearComPaymentRoute(
    destinationOrPayment?:
        | string
        | null
        | {
              destinationAssetId?: string;
              depositAddress?: string;
              quoteSignature?: string;
              networkFee?: string;
          },
): boolean {
    const destinationAssetId =
        typeof destinationOrPayment === "string" || destinationOrPayment == null
            ? destinationOrPayment
            : destinationOrPayment.destinationAssetId;
    return destinationAssetId?.trim().toLowerCase() === NEAR_COM_NETWORK_ID;
}

export function getNearComChainIcons(): ChainIcons {
    return {
        icon: NEAR_COM_ICON,
    };
}

export function formatNearComNetworkLabel({
    networkLabel,
}: {
    networkLabel: string;
}): string {
    return `NEAR (${NEAR_COM_NETWORK_NAME}) ${networkLabel}`;
}

export function getLocalizedNetworkDisplayName({
    networkName,
    networkLabel,
    fallbackName,
    expandNearComLabel = false,
}: {
    networkName: string;
    networkLabel: string;
    fallbackName: string;
    expandNearComLabel?: boolean;
}): string {
    if (isNearComNetwork(networkName)) {
        return expandNearComLabel
            ? formatNearComNetworkLabel({ networkLabel })
            : fallbackName;
    }
    return fallbackName;
}

export function getNetworkDisplayCaseClass(
    networkName: string,
    nonNearComCase: "capitalize" | "uppercase" = "capitalize",
): string {
    return isNearComNetwork(networkName) ? "normal-case" : nonNearComCase;
}

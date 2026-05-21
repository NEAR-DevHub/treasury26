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
 * Detect near.com payment routes from decoded proposal metadata.
 */
export function isNearComPaymentRoute({
    destinationAssetId,
    depositAddress,
    quoteSignature,
    networkFee,
}: {
    destinationAssetId?: string;
    depositAddress?: string;
    quoteSignature?: string;
    networkFee?: string;
}): boolean {
    if (isNearComNetwork(destinationAssetId)) {
        return true;
    }

    return (
        !destinationAssetId &&
        !!(depositAddress || quoteSignature || networkFee)
    );
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

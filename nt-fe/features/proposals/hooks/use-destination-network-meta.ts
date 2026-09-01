import { useMemo } from "react";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useToken } from "@/hooks/use-treasury-queries";
import type { ChainIcons } from "@/lib/api";
import {
    getNearComChainIcons,
    isNearComPaymentRoute,
} from "@/lib/intents-network";

export type DestinationNetworkMeta = {
    name: string;
    chainIcons: ChainIcons | null;
};

/**
 * Resolve receive-network display metadata for payment request details.
 * Used by single transfer and confidential/public bulk expanded views.
 */
export function useDestinationNetworkMeta({
    destinationAssetId,
    originTokenId,
    originNetwork,
    originChainIcons,
}: {
    destinationAssetId?: string;
    /** Send/origin asset id — used for amount-row token when destination is near.com. */
    originTokenId: string;
    originNetwork: string;
    originChainIcons?: ChainIcons | null;
}) {
    // Exact `near.com` only — not `near.com:direct`, not inferred from quotes.
    const isNearComDestination = isNearComPaymentRoute(destinationAssetId);

    const shouldFetchDestinationToken =
        !!destinationAssetId && !isNearComDestination;

    const { data: destinationTokenData, isLoading: isLoadingDestinationToken } =
        useToken(shouldFetchDestinationToken ? destinationAssetId : undefined);

    const recipientChainName = isNearComDestination
        ? NEAR_NETWORK_ID
        : destinationTokenData?.network ||
          (!shouldFetchDestinationToken ? destinationAssetId : undefined) ||
          originNetwork;

    const destinationNetworkMeta = useMemo((): DestinationNetworkMeta => {
        if (isNearComDestination) {
            return {
                name: NEAR_COM_NETWORK_ID,
                chainIcons: getNearComChainIcons(),
            };
        }
        if (!destinationAssetId || destinationAssetId === originNetwork) {
            return {
                name: originNetwork,
                chainIcons: originChainIcons ?? null,
            };
        }
        if (shouldFetchDestinationToken && destinationTokenData?.network) {
            return {
                name: destinationTokenData.network,
                chainIcons: destinationTokenData.chainIcons ?? null,
            };
        }
        return {
            name: destinationAssetId,
            chainIcons: null,
        };
    }, [
        destinationAssetId,
        destinationTokenData?.chainIcons,
        destinationTokenData?.network,
        isNearComDestination,
        originChainIcons,
        originNetwork,
        shouldFetchDestinationToken,
    ]);

    return {
        isNearComDestination,
        destinationTokenData,
        recipientChainName,
        destinationNetworkMeta,
        shouldShowDestinationNetworkSkeleton:
            shouldFetchDestinationToken && isLoadingDestinationToken,
        /** Amount row token: destination bridge asset, else origin (incl. near.com). */
        amountTokenId:
            destinationAssetId && !isNearComDestination
                ? destinationAssetId
                : originTokenId,
        amountNetwork: destinationAssetId
            ? destinationNetworkMeta.name
            : undefined,
    };
}

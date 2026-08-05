"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchDepositAddress } from "@/lib/bridge-api";

export type ConfidentialBridgeAddressState = {
    address: string | null;
    memo: string | null;
    hasFetched: boolean;
};

const IDLE: ConfidentialBridgeAddressState = {
    address: null,
    memo: null,
    hasFetched: false,
};

/**
 * Resolve the chain deposit address for a confidential quote id.
 * Quote id is not a DAO — POST deposit-address only runs the bridge lookup.
 */
export function useConfidentialBridgeAddress(options: {
    enabled: boolean;
    quoteDepositAddress: string | null | undefined;
    bridgeChainId: string | null | undefined;
}): ConfidentialBridgeAddressState {
    const { enabled, quoteDepositAddress, bridgeChainId } = options;

    const query = useQuery({
        queryKey: [
            "confidential-bridge-deposit-address",
            quoteDepositAddress,
            bridgeChainId,
        ],
        queryFn: async () => {
            const result = await fetchDepositAddress(
                quoteDepositAddress!,
                bridgeChainId!,
            );
            return {
                address: result?.address ?? null,
                memo: result?.memo ?? null,
            };
        },
        enabled: enabled && !!quoteDepositAddress && !!bridgeChainId,
        staleTime: 1000 * 60 * 5,
        retry: 1,
    });

    if (!enabled || !quoteDepositAddress || !bridgeChainId) {
        return IDLE;
    }

    if (!query.isFetched && !query.isError) {
        return IDLE;
    }

    return {
        address: query.data?.address ?? null,
        memo: query.data?.memo ?? null,
        hasFetched: true,
    };
}

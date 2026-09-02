"use client";

import { useMemo } from "react";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import type { TreasuryAsset } from "@/lib/api";
import { canonicalizeTokenIdForMatch } from "@/lib/utils";
import {
    extractPublicToConfidentialTransfer,
    publicAssetKey,
} from "../utils/public-to-confidential";

/**
 * In-progress public-to-confidential move requests keyed by `publicAssetKey`
 * (residency + contract — one request per asset row). Lets the banner / list
 * offer "View request" instead of a second move for the same asset.
 */
export function usePendingMoveRequests(
    tokens: readonly TreasuryAsset[] | undefined,
): ReadonlyMap<string, number> {
    const { treasuryId, isConfidential } = useTreasury();
    const { data } = useProposals(
        treasuryId,
        { statuses: ["InProgress"], proposal_types: ["FunctionCall"] },
        Boolean(isConfidential),
    );

    return useMemo(() => {
        const pending = new Map<string, number>();
        if (!tokens?.length) return pending;
        for (const proposal of data?.proposals ?? []) {
            const transfer = extractPublicToConfidentialTransfer(proposal);
            if (!transfer) continue;
            const tokenId = canonicalizeTokenIdForMatch(transfer.tokenId);
            for (const asset of tokens) {
                const key = publicAssetKey(asset);
                if (
                    key === `${transfer.residency}:${tokenId}` &&
                    !pending.has(key)
                ) {
                    pending.set(key, proposal.id);
                }
            }
        }
        return pending;
    }, [data?.proposals, tokens]);
}

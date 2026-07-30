import type { TreasuryAsset } from "@/lib/api";
import { canonicalizeTokenIdForMatch } from "@/lib/utils";

/**
 * Match a selected token (form / picker) to a treasury asset row for
 * live balance and price. Accepts nep141: vs bare contract IDs.
 */
export function findMatchingTreasuryAsset(
    tokens: readonly TreasuryAsset[] | undefined,
    token: { address?: string | null; network?: string | null } | null,
): TreasuryAsset | null {
    if (!tokens?.length || !token?.address) return null;

    const tokenId = canonicalizeTokenIdForMatch(token.address);
    const tokenNetwork = token.network?.trim().toLowerCase();

    return (
        tokens.find((asset) => {
            const assetId = canonicalizeTokenIdForMatch(
                asset.contractId ?? asset.id,
            );
            const assetIdAlt = canonicalizeTokenIdForMatch(asset.id);
            const idMatch = assetId === tokenId || assetIdAlt === tokenId;
            const networkMatch =
                !tokenNetwork ||
                !asset.network ||
                asset.network.trim().toLowerCase() === tokenNetwork;
            return idMatch && networkMatch;
        }) ?? null
    );
}

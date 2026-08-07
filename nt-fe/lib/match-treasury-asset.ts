import type { TreasuryAsset } from "@/lib/api";
import { canonicalizeTokenIdForMatch } from "@/lib/utils";

/**
 * Match a selected token (form / picker) to a treasury asset row for
 * live balance and price. Accepts nep141: vs bare contract IDs.
 * When `residency` is set (Ft vs Intents/near.com), it must match too.
 */
export function findMatchingTreasuryAsset(
    tokens: readonly TreasuryAsset[] | undefined,
    token: {
        address?: string | null;
        network?: string | null;
        residency?: string | null;
    } | null,
): TreasuryAsset | null {
    if (!tokens?.length || !token?.address) return null;

    const tokenId = canonicalizeTokenIdForMatch(token.address);
    const tokenNetwork = token.network?.trim().toLowerCase();
    const tokenResidency = token.residency?.trim().toLowerCase();

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
            const residencyMatch =
                !tokenResidency ||
                !asset.residency ||
                asset.residency.trim().toLowerCase() === tokenResidency;
            return idMatch && networkMatch && residencyMatch;
        }) ?? null
    );
}

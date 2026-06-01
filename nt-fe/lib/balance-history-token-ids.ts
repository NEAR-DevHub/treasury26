import type { TreasuryAsset } from "@/lib/api";

const INTENTS_TOKEN_PREFIX = "intents.near:";

export function getBalanceHistoryTokenIds(token: TreasuryAsset): string[] {
    if (token.residency === "Intents") {
        const tokenId = token.contractId ?? token.id;
        if (!tokenId) return [];

        return [
            tokenId.startsWith(INTENTS_TOKEN_PREFIX)
                ? tokenId
                : `${INTENTS_TOKEN_PREFIX}${tokenId}`,
        ];
    }

    if (token.residency === "Staked" && token.balance.type === "Staked") {
        return token.balance.staking.pools.map(
            (pool) => `staking:${pool.poolId}`,
        );
    }

    return [token.contractId ?? token.id].filter(Boolean);
}

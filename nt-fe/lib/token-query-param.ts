type TokenQueryShape = {
    address: string;
    contractId?: string;
    id?: string;
    balanceAssetId?: string;
    quoteAssetId?: string;
};

export function buildTokenQueryParam(token: {
    symbol: string;
    network: string;
    decimals: number;
    icon: string;
    name: string;
    residency?: string;
    chainIcons?: unknown;
    contractId?: string;
    id?: string;
    balanceAssetId?: string;
    quoteAssetId?: string;
}): string {
    const address = token.contractId ?? token.id;

    return encodeURIComponent(
        JSON.stringify({
            symbol: token.symbol,
            address,
            network: token.network,
            decimals: token.decimals,
            residency: token.residency,
            icon: token.icon,
            name: token.name,
            chainIcons: token.chainIcons,
            balanceAssetId: token.balanceAssetId,
            quoteAssetId: token.quoteAssetId,
        }),
    );
}

export function parseTokenQueryParam<T extends TokenQueryShape>(
    param: string | null,
    fallback: T,
): T {
    if (!param) return fallback;

    try {
        const parsed = JSON.parse(decodeURIComponent(param)) as Record<
            string,
            unknown
        >;

        const address =
            (typeof parsed.address === "string" && parsed.address) ||
            (typeof parsed.contractId === "string" && parsed.contractId) ||
            (typeof parsed.id === "string" && parsed.id) ||
            "";

        if (!address) return fallback;

        // Routing ids identify the asset sent to 1Click. The fallback's must
        // never leak onto a different asset (#1463), so only the link's own
        // values are kept; consumers fall back to `address` when absent.
        const {
            balanceAssetId: _balanceAssetId,
            quoteAssetId: _quoteAssetId,
            ...fallbackDefaults
        } = fallback;

        return {
            ...fallbackDefaults,
            ...(parsed as Partial<T>),
            address,
        } as T;
    } catch {
        return fallback;
    }
}

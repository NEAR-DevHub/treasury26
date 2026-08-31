type TokenQueryShape = {
    address: string;
    contractId?: string;
    id?: string;
    balanceAssetId?: string;
    quoteAssetId?: string;
    minWithdrawalAmount?: string;
    minDepositAmount?: string;
    balance?: string;
    price?: number;
};

/**
 * Per-asset fields that must never cross from the fallback onto a different
 * asset (#1463): routing ids, min amounts, balance, price. Present in the
 * result only when the link itself carries them.
 */
type PerAssetKeys =
    | "balanceAssetId"
    | "quoteAssetId"
    | "minWithdrawalAmount"
    | "minDepositAmount"
    | "balance"
    | "price";

type ParsedTokenQueryParam<T extends TokenQueryShape> = Omit<T, PerAssetKeys> &
    Pick<TokenQueryShape, PerAssetKeys> & { address: string };

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
): ParsedTokenQueryParam<T> {
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

        const {
            balanceAssetId: _balanceAssetId,
            quoteAssetId: _quoteAssetId,
            minWithdrawalAmount: _minWithdrawalAmount,
            minDepositAmount: _minDepositAmount,
            balance: _balance,
            price: _price,
            ...fallbackDefaults
        } = fallback;

        return {
            ...fallbackDefaults,
            ...(parsed as Partial<T>),
            address,
        } as ParsedTokenQueryParam<T>;
    } catch {
        return fallback;
    }
}

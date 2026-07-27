import type { SelectedTokenData } from "@/components/token-select";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { default_usdc_near_token } from "@/constants/token";
import type { MergedNetwork, MergedToken } from "@/hooks/use-merged-tokens";
import Big from "@/lib/big";

export type DefaultTokenFilter = (token: {
    address: string;
    symbol: string;
    network: string;
    residency?: string;
}) => boolean;

function networkHasBalance(network: MergedNetwork): boolean {
    if (network.balance == null) return false;
    try {
        return Big(network.balance).gt(0);
    } catch {
        return false;
    }
}

function toSelected(
    token: MergedToken,
    network: MergedNetwork,
): SelectedTokenData {
    return {
        address: network.id,
        symbol: network.symbol,
        decimals: network.decimals,
        name: token.name || network.symbol,
        icon: token.icon || "",
        network: network.name,
        chainIcons: network.chainIcons || undefined,
        residency: network.residency,
        minWithdrawalAmount: network.minWithdrawalAmount,
        minDepositAmount: network.minDepositAmount,
        // Seed balance/price so TokenInput can show them immediately.
        balance: network.balance,
        price: network.price,
    };
}

function isDisabled(
    network: MergedNetwork,
    disableTokens?: DefaultTokenFilter,
): boolean {
    return (
        disableTokens?.({
            address: network.id,
            symbol: network.symbol,
            network: network.name,
            residency: network.residency,
        }) ?? false
    );
}

function isNearNetworkName(name: string): boolean {
    return name.trim().toLowerCase() === NEAR_NETWORK_ID;
}

function isUsdcSymbol(symbol: string): boolean {
    return symbol.trim().toUpperCase() === "USDC";
}

/**
 * Highest USD-value owned network across cached treasury assets.
 */
export function pickHighestUsdOwnedToken(
    tokens: MergedToken[],
    disableTokens?: DefaultTokenFilter,
): SelectedTokenData | null {
    let best: {
        token: MergedToken;
        network: MergedNetwork;
        usd: number;
    } | null = null;

    for (const token of tokens) {
        for (const network of token.networks) {
            if (
                !networkHasBalance(network) ||
                isDisabled(network, disableTokens)
            ) {
                continue;
            }
            const usd = network.balanceUSD ?? 0;
            if (!best || usd > best.usd) {
                best = { token, network, usd };
            }
        }
    }

    return best ? toSelected(best.token, best.network) : null;
}

/** Prefer USDC on the NEAR network from the merged token list. */
export function pickUsdcNearFromTokens(
    tokens: MergedToken[],
    disableTokens?: DefaultTokenFilter,
): SelectedTokenData | null {
    for (const token of tokens) {
        for (const network of token.networks) {
            if (!isUsdcSymbol(network.symbol)) continue;
            if (!isNearNetworkName(network.name)) continue;
            if (isDisabled(network, disableTokens)) continue;
            return toSelected(token, network);
        }
    }
    return null;
}

/**
 * Default token for Payments / Bulk / TokenSelect (not Exchange, not Deposit):
 * 1) most USD-valuable owned network from cached assets
 * 2) USDC on NEAR from the available list
 * 3) static USDC-on-NEAR fallback
 */
export function pickDefaultSelectedToken(
    tokens: MergedToken[],
    options?: {
        disableTokens?: DefaultTokenFilter;
    },
): SelectedTokenData {
    const owned = pickHighestUsdOwnedToken(tokens, options?.disableTokens);
    if (owned) return owned;

    const usdcNear = pickUsdcNearFromTokens(tokens, options?.disableTokens);
    if (usdcNear) return usdcNear;

    return default_usdc_near_token();
}

/**
 * Default deposit asset only (network stays empty for the user to pick):
 * 1) first of yourAssets (caller must USD-sort)
 * 2) USDC in allAssets
 * 3) first available
 */
export function pickDefaultDepositAsset<T extends { id: string }>(
    yourAssets: readonly T[],
    allAssets: readonly T[],
): T | undefined {
    if (yourAssets[0]) return yourAssets[0];
    const usdc = allAssets.find((asset) => asset.id.toLowerCase() === "usdc");
    if (usdc) return usdc;
    return allAssets[0];
}

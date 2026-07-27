import type { SelectedTokenData } from "@/components/token-select";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import {
    default_usdc_near_token,
    NEP141_USDC_NEAR_ASSET_ID,
    USDC_NEAR_CONTRACT_ID,
} from "@/constants/token";
import type { MergedNetwork, MergedToken } from "@/hooks/use-merged-tokens";
import Big from "@/lib/big";
import { canonicalizeTokenIdForMatch } from "@/lib/utils";

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
 * Tokens should already be sorted by totalBalanceUSD desc when from useMergedTokens.
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
 * Default token for Deposit / Payments / Bulk (not Exchange):
 * 1) most USD-valuable owned network from cached assets
 * 2) USDC on NEAR from the available list
 * 3) static USDC-on-NEAR fallback
 */
export function pickDefaultSelectedToken(
    tokens: MergedToken[],
    options?: {
        disableTokens?: DefaultTokenFilter;
        isConfidential?: boolean;
    },
): SelectedTokenData {
    const owned = pickHighestUsdOwnedToken(tokens, options?.disableTokens);
    if (owned) return owned;

    const usdcNear = pickUsdcNearFromTokens(tokens, options?.disableTokens);
    if (usdcNear) return usdcNear;

    return default_usdc_near_token(options?.isConfidential ?? false);
}

/** True when the selection matches the static USDC-on-NEAR fallback. */
export function isDefaultUsdcNearSelection(
    token:
        | Pick<SelectedTokenData, "address" | "symbol" | "network">
        | null
        | undefined,
    isConfidential: boolean,
): boolean {
    if (!token) return false;
    if (!isUsdcSymbol(token.symbol) || !isNearNetworkName(token.network)) {
        return false;
    }
    const fallback = default_usdc_near_token(isConfidential);
    const a = canonicalizeTokenIdForMatch(token.address);
    const b = canonicalizeTokenIdForMatch(fallback.address);
    // Also accept either public or intents form of the same USDC contract.
    const accepted = new Set([
        b,
        canonicalizeTokenIdForMatch(USDC_NEAR_CONTRACT_ID),
        canonicalizeTokenIdForMatch(NEP141_USDC_NEAR_ASSET_ID),
    ]);
    return accepted.has(a);
}

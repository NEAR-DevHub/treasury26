import Big from "@/lib/big";
import { isNearChainFtToken, isNearChainNativeToken } from "@/lib/intents-fee";
import {
    NEAR_NETWORK_ID,
    NEP141_WRAP_NEAR_ASSET_ID,
    WRAP_NEAR_TOKEN_ID,
} from "@/constants/network-ids";

/**
 * Checks if a token is native NEAR
 * If residency is provided, it must be "Near"
 * If residency is not provided, just check address
 */
export function isNativeNEAR(address: string, residency?: string): boolean {
    return isNearChainNativeToken({
        address,
        network: NEAR_NETWORK_ID,
        residency,
    });
}

/**
 * Checks if a token is FT NEAR (wrap.near)
 * If residency is provided, it must be "Ft"
 * If residency is not provided, just check address
 */
export function isFTNEAR(address: string, residency?: string): boolean {
    return (
        address === WRAP_NEAR_TOKEN_ID &&
        isNearChainFtToken({
            address,
            network: NEAR_NETWORK_ID,
            residency,
        })
    );
}

/**
 * Checks if this is a NEAR deposit conversion (native NEAR → FT NEAR)
 */
export function isNEARDeposit(
    sellToken: { address: string; residency?: string },
    receiveToken: { address: string; residency?: string },
): boolean {
    return (
        isNativeNEAR(sellToken.address, sellToken.residency) &&
        isFTNEAR(receiveToken.address, receiveToken.residency)
    );
}

/**
 * Checks if this is a NEAR withdraw conversion (FT NEAR → native NEAR)
 */
export function isNEARWithdraw(
    sellToken: { address: string; residency?: string },
    receiveToken: { address: string; residency?: string },
): boolean {
    return (
        isFTNEAR(sellToken.address, sellToken.residency) &&
        isNativeNEAR(receiveToken.address, receiveToken.residency)
    );
}

/**
 * Checks if this is a NEAR wrap/unwrap conversion (1:1 exchange)
 */
export function isNEARWrapConversion(
    sellToken: { address: string; residency?: string },
    receiveToken: { address: string; residency?: string },
): boolean {
    return (
        isNEARDeposit(sellToken, receiveToken) ||
        isNEARWithdraw(sellToken, receiveToken)
    );
}

/**
 * Formats an asset address for the 1Click Intents API
 * Native NEAR uses "wrap.near", other tokens use their address as-is
 */
export function formatAssetForIntentsAPI(tokenAddress: string): string {
    return tokenAddress.startsWith("nep")
        ? tokenAddress
        : tokenAddress === NEAR_NETWORK_ID
          ? NEP141_WRAP_NEAR_ASSET_ID
          : `nep141:${tokenAddress}`;
}

/**
 * Determines deposit and refund type based on the origin asset's network
 * - If residency === "Intents": Token is on Intents → INTENTS
 * - Otherwise: Token is on NEAR: FT or Native NEAR → ORIGIN_CHAIN
 */
export function getDepositAndRefundType(
    residency: string,
    isConfidential?: boolean,
): "INTENTS" | "CONFIDENTIAL_INTENTS" | "ORIGIN_CHAIN" {
    return residency === "Intents"
        ? isConfidential
            ? "CONFIDENTIAL_INTENTS"
            : "INTENTS"
        : "ORIGIN_CHAIN";
}

export function getRecipientType(
    residency: string,
    isConfidential?: boolean,
): "INTENTS" | "CONFIDENTIAL_INTENTS" | "DESTINATION_CHAIN" {
    return residency === "Intents"
        ? isConfidential
            ? "CONFIDENTIAL_INTENTS"
            : "INTENTS"
        : "DESTINATION_CHAIN";
}

/**
 * Calculates quote outcome difference as output USD vs input USD.
 * Positive means favorable (more USD out than in), negative means unfavorable.
 * @param amountInUsd - USD value of input amount from quote
 * @param amountOutUsd - USD value of output amount from quote
 * @returns Object with percentage difference and whether it's favorable
 */
export function calculateMarketPriceDifference(
    amountInUsd: string,
    amountOutUsd: string,
): {
    percentDifference: string;
    usdDifference: string;
    isFavorable: boolean;
    hasMarketData: boolean;
} {
    try {
        const inputUsd = Big(amountInUsd);
        const outputUsd = Big(amountOutUsd);

        if (inputUsd.lte(0)) {
            return {
                percentDifference: "N/A",
                usdDifference: "N/A",
                isFavorable: false,
                hasMarketData: false,
            };
        }

        // Compare actual quote outcome directly: output value relative to input value.
        const usdDifference = outputUsd.minus(inputUsd);
        const percentDifference = outputUsd
            .minus(inputUsd)
            .div(inputUsd)
            .mul(100);

        return {
            percentDifference: percentDifference.toFixed(4),
            usdDifference: usdDifference.toString(),
            isFavorable: percentDifference.gte(0),
            hasMarketData: true,
        };
    } catch (error) {
        console.error("Error calculating market price difference:", error);
        return {
            percentDifference: "N/A",
            usdDifference: "N/A",
            isFavorable: false,
            hasMarketData: false,
        };
    }
}

export type ExchangeErrorCode =
    | "noRoute"
    | "amountTooLow"
    | "insufficientBalance"
    | "networkError"
    | "unknown";

/**
 * Classifies API errors into a translation-friendly code.
 * Caller is responsible for translating the code into a user message.
 */
export function classifyExchangeError(errorMessage: string): {
    code: ExchangeErrorCode;
    raw: string;
    minAmountRaw?: string;
} {
    const lowerError = errorMessage.toLowerCase();

    if (
        lowerError.includes("no route") ||
        lowerError.includes("no swap") ||
        lowerError.includes("no quote") ||
        lowerError.includes("no liquidity") ||
        lowerError.includes("insufficient liquidity") ||
        lowerError.includes("liquidity unavailable") ||
        lowerError.includes("not supported") ||
        lowerError.includes("tokenin is not valid") ||
        lowerError.includes("tokenout is not valid")
    ) {
        return { code: "noRoute", raw: errorMessage };
    }
    if (lowerError.includes("amount") && lowerError.includes("low")) {
        const match = errorMessage.match(/at least\s+([0-9]+(?:\.[0-9]+)?)/i);
        return {
            code: "amountTooLow",
            raw: errorMessage,
            minAmountRaw: match?.[1],
        };
    }
    if (lowerError.includes("insufficient") || lowerError.includes("balance")) {
        return { code: "insufficientBalance", raw: errorMessage };
    }
    if (lowerError.includes("timeout") || lowerError.includes("network")) {
        return { code: "networkError", raw: errorMessage };
    }
    return { code: "unknown", raw: errorMessage };
}

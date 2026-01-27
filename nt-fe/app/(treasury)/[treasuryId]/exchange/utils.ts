import Big from "big.js";

/**
 * Formats an asset address for the 1Click Intents API
 * Native NEAR uses "wrap.near", other tokens use their address as-is
 */
export function formatAssetForIntentsAPI(
  tokenAddress: string
): string {
  return tokenAddress === "near" ? "wrap.near" : tokenAddress;
}

/**
 * Determines deposit and refund type based on the origin asset's network
 * Returns the same value for both deposit and refund
 * - If network === "near": Token is on NEAR chain → ORIGIN_CHAIN
 * - Otherwise: Token is on intents → INTENTS
 */
export function getDepositAndRefundType(network: string): "INTENTS" | "ORIGIN_CHAIN" {
  return network === "near" ? "ORIGIN_CHAIN" : "INTENTS";
}

/**
 * Calculates the exchange rate between two tokens
 * Returns a formatted rate string with USD value
 */
export function calculateExchangeRate(
  amountIn: string,
  amountOut: string,
  amountInUsd: string,
  amountOutUsd: string,
  sellTokenDecimals: number,
  receiveTokenDecimals: number,
  sellTokenSymbol: string,
  receiveTokenSymbol: string,
  isReversed: boolean = false
): string {
  const sellAmount = Big(amountIn).div(Big(10).pow(sellTokenDecimals));
  const receiveAmount = Big(amountOut).div(Big(10).pow(receiveTokenDecimals));
  
  if (sellAmount.lte(0) || receiveAmount.lte(0)) {
    return "N/A";
  }

  if (isReversed) {
    // Show: 1 ReceiveToken ($X) ≈ Y SellToken
    const usdPerReceiveToken = Big(amountOutUsd).div(receiveAmount).toFixed(2);
    const sellPerReceive = sellAmount.div(receiveAmount).toFixed(2);
    return `1 ${receiveTokenSymbol} ($${usdPerReceiveToken}) ≈ ${sellPerReceive} ${sellTokenSymbol}`;
  } else {
    // Show: 1 SellToken ($X) ≈ Y ReceiveToken
    const usdPerSellToken = Big(amountInUsd).div(sellAmount).toFixed(2);
    const receivePerSell = receiveAmount.div(sellAmount).toFixed(2);
    return `1 ${sellTokenSymbol} ($${usdPerSellToken}) ≈ ${receivePerSell} ${receiveTokenSymbol}`;
  }
}

/**
 * Calculates price difference percentage
 */
export function calculatePriceDifference(
  amountOut: string,
  minAmountOut: string
): string {
  const difference =
    ((Number(amountOut) - Number(minAmountOut)) / Number(amountOut)) * 100;
  return difference.toFixed(8);
}

/**
 * Calculates the price difference between expected market rate and quote rate
 * Compares the USD values to determine if the rate is favorable or not
 * @param amountInUsd - USD value of input amount from quote
 * @param amountOutUsd - USD value of output amount from quote
 * @param amountIn - Raw amount in (smallest units)
 * @param amountOut - Raw amount out (smallest units)
 * @param sellTokenDecimals - Decimals for sell token
 * @param receiveTokenDecimals - Decimals for receive token
 * @param sellTokenPrice - Market price per token (from metadata/price feed)
 * @param receiveTokenPrice - Market price per token (from metadata/price feed)
 * @returns Object with percentage difference and whether it's favorable
 */
export function calculateMarketPriceDifference(
  amountInUsd: string,
  amountOutUsd: string,
  amountIn: string,
  amountOut: string,
  sellTokenDecimals: number,
  receiveTokenDecimals: number,
  sellTokenPrice?: number,
  receiveTokenPrice?: number
): {
  percentDifference: string;
  isFavorable: boolean;
  hasMarketData: boolean;
} {
  // If we don't have market prices, we can't calculate market difference
  if (!sellTokenPrice || !receiveTokenPrice) {
    return {
      percentDifference: "N/A",
      isFavorable: false,
      hasMarketData: false,
    };
  }

  try {
    // Calculate actual token amounts
    const sellAmount = Big(amountIn).div(Big(10).pow(sellTokenDecimals));
    const receiveAmount = Big(amountOut).div(Big(10).pow(receiveTokenDecimals));

    // Calculate expected USD value based on market prices
    const expectedSellUSD = sellAmount.mul(sellTokenPrice);
    const expectedReceiveUSD = receiveAmount.mul(receiveTokenPrice);

    // Get actual USD values from quote
    const actualSellUSD = Big(amountInUsd);
    const actualReceiveUSD = Big(amountOutUsd);

    // Calculate the rate difference
    // Positive means you're getting more USD value than expected (favorable)
    // Negative means you're getting less USD value than expected (unfavorable)
    const usdValueDifference = actualReceiveUSD.minus(expectedReceiveUSD);
    const percentDifference = usdValueDifference
      .div(expectedReceiveUSD)
      .mul(100);

    return {
      percentDifference: percentDifference.toFixed(4),
      isFavorable: percentDifference.gte(0),
      hasMarketData: true,
    };
  } catch (error) {
    console.error("Error calculating market price difference:", error);
    return {
      percentDifference: "N/A",
      isFavorable: false,
      hasMarketData: false,
    };
  }
}

/**
 * Provides user-friendly error messages for common API errors
 */
export function getUserFriendlyErrorMessage(errorMessage: string): string {
  const lowerError = errorMessage.toLowerCase();
  
  if (
    lowerError.includes("no route") ||
    lowerError.includes("no swap") ||
    lowerError.includes("not supported") ||
    lowerError.includes("tokenin is not valid") ||
    lowerError.includes("tokenout is not valid")
  ) {
    return "No exchange found. Try a smaller amount or different token.";
  } else if (lowerError.includes("amount") && lowerError.includes("low")) {
    return "Amount too low for swap. Cross-chain swaps require a higher minimum to cover network fees.";
  } else if (
    lowerError.includes("insufficient") ||
    lowerError.includes("balance")
  ) {
    return "Insufficient balance for this swap.";
  } else if (
    lowerError.includes("timeout") ||
    lowerError.includes("network")
  ) {
    return "Network error. Please check your connection and try again.";
  }
  
  return errorMessage;
}

/**
 * Calculates the detailed exchange rate for the review screen
 * Returns a formatted rate string with both token amounts and USD values
 */
export function calculateDetailedExchangeRate(
  amountIn: string,
  amountOut: string,
  amountInUsd: string,
  amountOutUsd: string,
  sellTokenDecimals: number,
  receiveTokenDecimals: number,
  sellTokenSymbol: string,
  receiveTokenSymbol: string,
  isReversed: boolean = false
): string {
  const sellAmount = Big(amountIn).div(Big(10).pow(sellTokenDecimals));
  const receiveAmount = Big(amountOut).div(Big(10).pow(receiveTokenDecimals));
  
  if (sellAmount.lte(0) || receiveAmount.lte(0)) {
    return "N/A";
  }

  if (isReversed) {
    // Show: 1 ReceiveToken ($X) ≈ Y SellToken
    const usdPerReceiveToken = parseFloat(amountOut) > 0
      ? Big(amountOutUsd).div(receiveAmount).toFixed(2)
      : "0";
    const sellPerReceive = receiveAmount.gt(0)
      ? sellAmount.div(receiveAmount).toFixed(2)
      : "0";
    return `1 ${receiveTokenSymbol} ($${usdPerReceiveToken}) ≈ ${sellPerReceive} ${sellTokenSymbol}`;
  } else {
    // Show: 1 SellToken ($X) ≈ Y ReceiveToken
    const usdPerSellToken = parseFloat(amountIn) > 0
      ? Big(amountInUsd).div(sellAmount).toFixed(2)
      : "0";
    const receivePerSell = sellAmount.gt(0)
      ? receiveAmount.div(sellAmount).toFixed(2)
      : "0";
    return `1 ${sellTokenSymbol} ($${usdPerSellToken}) ≈ ${receivePerSell} ${receiveTokenSymbol}`;
  }
}


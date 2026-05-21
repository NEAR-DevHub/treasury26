import type { TokenMetadata } from "@/lib/api";
import type { SwapQuoteResponse } from "@/lib/proposals-api";
import { formatCurrency, formatTokenDisplayAmount } from "@/lib/utils";

export interface AsyncValue<T> {
    value: T | null;
    isLoading: boolean;
}

interface ReceiptNetworkMetadata {
    name: string | null;
    chainIcons: { icon?: string | null } | null;
}

interface ReceiptAssetMetadata {
    tokenId?: string;
    symbol?: string;
    name?: string;
    icon?: string;
    network?: ReceiptNetworkMetadata | null;
}

export interface TokenReceiptInfo {
    metadata: AsyncValue<ReceiptAssetMetadata>;
    amount: string;
    usd: AsyncValue<string>;
}

function toAsyncValue<T>(value: T | null, isLoading: boolean): AsyncValue<T> {
    return { value, isLoading };
}

export function buildReceiptAmountModel({
    isExchangeReceipt,
    hasDepositAddress,
    quote,
    sourceToken,
    destinationToken,
}: {
    isExchangeReceipt: boolean;
    hasDepositAddress: boolean;
    quote?: SwapQuoteResponse | null;
    sourceToken: {
        normalizedAmount: string;
        formattedAmount: string;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
    destinationToken: {
        amountWithDecimals?: string;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
}) {
    const sourceAmountValue = Number(
        quote?.amountInFormatted ?? sourceToken.normalizedAmount,
    );
    const destinationAmountValue = Number(
        quote?.amountOutFormatted ?? destinationToken.amountWithDecimals ?? "0",
    );
    const sourceAmountDisplay = isExchangeReceipt
        ? (quote?.amountInFormatted ?? sourceToken.formattedAmount)
        : sourceToken.formattedAmount;
    const destinationAmountDisplay =
        quote?.amountOutFormatted ||
        formatTokenDisplayAmount(destinationToken.amountWithDecimals || "0");

    let sourceUnitPriceUsd: number | null = null;
    if (sourceAmountValue > 0 && Number(quote?.amountInUsd) > 0) {
        sourceUnitPriceUsd = Number(quote?.amountInUsd) / sourceAmountValue;
    } else if (hasDepositAddress) {
        sourceUnitPriceUsd = sourceToken.tokenPrice;
    } else {
        sourceUnitPriceUsd = sourceToken.historicalPriceUsd;
    }

    let sourceAmountUsd: string | null = null;
    if (quote?.amountInUsd) {
        sourceAmountUsd = formatCurrency(Number(quote.amountInUsd));
    } else if (!hasDepositAddress && sourceUnitPriceUsd != null) {
        sourceAmountUsd = formatCurrency(
            Number(sourceToken.normalizedAmount) * sourceUnitPriceUsd,
        );
    } else if (hasDepositAddress && sourceToken.tokenPrice != null) {
        sourceAmountUsd = formatCurrency(
            Number(sourceToken.normalizedAmount) * sourceToken.tokenPrice,
        );
    }

    const destinationUnitPriceUsd = hasDepositAddress
        ? destinationToken.tokenPrice
        : destinationToken.historicalPriceUsd;
    const destinationAmountRawForUsd = Number(
        destinationToken.amountWithDecimals ?? "0",
    );
    const destinationPerSourceRate =
        sourceAmountValue > 0 && destinationAmountValue > 0
            ? destinationAmountValue / sourceAmountValue
            : null;

    let destinationAmountUsd: string | null = null;
    if (quote?.amountOutUsd) {
        destinationAmountUsd = formatCurrency(Number(quote.amountOutUsd));
    } else if (!hasDepositAddress) {
        if (destinationUnitPriceUsd != null) {
            destinationAmountUsd = formatCurrency(
                destinationAmountRawForUsd * destinationUnitPriceUsd,
            );
        }
    } else if (
        destinationToken.tokenPrice != null &&
        quote?.amountOutFormatted
    ) {
        destinationAmountUsd = formatCurrency(
            Number(quote.amountOutFormatted) * destinationToken.tokenPrice,
        );
    } else {
        destinationAmountUsd = sourceAmountUsd;
    }

    let rateLabel: string | null = null;
    if (
        sourceUnitPriceUsd &&
        destinationPerSourceRate &&
        sourceToken.symbol &&
        destinationToken.symbol
    ) {
        rateLabel = `1 ${sourceToken.symbol} (${formatCurrency(sourceUnitPriceUsd)}) ≈ ${formatTokenDisplayAmount(destinationPerSourceRate)} ${destinationToken.symbol}`;
    } else if (sourceUnitPriceUsd && sourceToken.symbol) {
        rateLabel = `1 ${sourceToken.symbol} = ${formatCurrency(sourceUnitPriceUsd)}`;
    }

    return {
        sourceAmountDisplay,
        destinationAmountDisplay,
        sourceAmountUsd,
        destinationAmountUsd,
        rateLabel,
    };
}

export function buildTokenReceiptInfo({
    tokenId,
    token,
    amount,
    usdValue,
    usdLoading = false,
}: {
    tokenId?: string;
    token?: Partial<TokenMetadata> | null;
    amount: string;
    usdValue: string | null;
    usdLoading?: boolean;
}): TokenReceiptInfo {
    return {
        metadata: toAsyncValue(
            {
                tokenId,
                symbol: token?.symbol,
                name: token?.name,
                icon: token?.icon,
                network: {
                    name: token?.network ?? tokenId ?? null,
                    chainIcons: token?.chainIcons ?? null,
                },
            },
            !token,
        ),
        amount,
        usd: toAsyncValue(usdValue, usdLoading),
    };
}

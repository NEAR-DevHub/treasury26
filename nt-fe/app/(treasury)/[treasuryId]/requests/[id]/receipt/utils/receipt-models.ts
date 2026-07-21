import type { ChainIcons, TokenMetadata } from "@/lib/api";
import type { SwapQuoteResponse } from "@/lib/proposals-api";
import {
    formatCurrencyWithSubCent,
    formatTokenDisplayAmount,
} from "@/lib/utils";

export interface AsyncValue<T> {
    value: T | null;
    isLoading: boolean;
}

interface ReceiptNetworkMetadata {
    name: string | null;
    chainIcons: ChainIcons | null;
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
        amountDecimal: string;
        amountDisplay: string;
        amountUsd?: number | null;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
    destinationToken: {
        amountDecimal?: string;
        amountUsd?: number | null;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
}) {
    const sourceAmountRaw =
        quote?.amountInFormatted ?? sourceToken.amountDecimal;
    const destinationAmountRaw =
        quote?.amountOutFormatted ?? destinationToken.amountDecimal ?? "0";
    const sourceAmountValue = Number(sourceAmountRaw);
    const destinationAmountValue = Number(destinationAmountRaw);
    const quoteSourceAmountUsd = quote?.amountInUsd
        ? Number(quote.amountInUsd)
        : null;
    const explicitSourceAmountUsd = sourceToken.amountUsd;
    const explicitDestinationAmountUsd = destinationToken.amountUsd;
    const sourceAmountDisplay = isExchangeReceipt
        ? (quote?.amountInFormatted ?? sourceToken.amountDisplay)
        : sourceToken.amountDisplay;
    const destinationAmountDisplay =
        quote?.amountOutFormatted ||
        formatTokenDisplayAmount(destinationToken.amountDecimal || "0");

    let sourceUnitPriceUsd: number | null = null;
    if (explicitSourceAmountUsd !== undefined) {
        sourceUnitPriceUsd =
            explicitSourceAmountUsd != null && sourceAmountValue > 0
                ? explicitSourceAmountUsd / sourceAmountValue
                : null;
    } else if (
        sourceAmountValue > 0 &&
        quoteSourceAmountUsd != null &&
        quoteSourceAmountUsd > 0
    ) {
        sourceUnitPriceUsd = quoteSourceAmountUsd / sourceAmountValue;
    } else if (!hasDepositAddress) {
        sourceUnitPriceUsd = sourceToken.historicalPriceUsd;
    }

    let sourceAmountUsd: string | null = null;
    if (explicitSourceAmountUsd !== undefined) {
        sourceAmountUsd =
            explicitSourceAmountUsd != null
                ? formatCurrencyWithSubCent(explicitSourceAmountUsd)
                : null;
    } else if (quote?.amountInUsd) {
        sourceAmountUsd = formatCurrencyWithSubCent(Number(quote.amountInUsd));
    } else if (!hasDepositAddress && sourceUnitPriceUsd != null) {
        sourceAmountUsd = formatCurrencyWithSubCent(
            Number(sourceToken.amountDecimal) * sourceUnitPriceUsd,
        );
    }

    let destinationUnitPriceUsd: number | null = null;
    if (explicitDestinationAmountUsd !== undefined) {
        destinationUnitPriceUsd =
            explicitDestinationAmountUsd != null && destinationAmountValue > 0
                ? explicitDestinationAmountUsd / destinationAmountValue
                : null;
    } else if (!hasDepositAddress) {
        destinationUnitPriceUsd = destinationToken.historicalPriceUsd;
    }

    let destinationAmountUsd: string | null = null;
    if (explicitDestinationAmountUsd !== undefined) {
        destinationAmountUsd =
            explicitDestinationAmountUsd != null
                ? formatCurrencyWithSubCent(explicitDestinationAmountUsd)
                : null;
    } else if (quote?.amountOutUsd) {
        destinationAmountUsd = formatCurrencyWithSubCent(
            Number(quote.amountOutUsd),
        );
    } else if (!hasDepositAddress && destinationUnitPriceUsd != null) {
        destinationAmountUsd = formatCurrencyWithSubCent(
            Number(destinationToken.amountDecimal ?? "0") *
                destinationUnitPriceUsd,
        );
    } else {
        destinationAmountUsd = sourceAmountUsd;
    }
    const destinationPerSourceRate =
        sourceAmountValue > 0 && destinationAmountValue > 0
            ? destinationAmountValue / sourceAmountValue
            : null;

    let rateLabel: string | null = null;
    if (
        sourceUnitPriceUsd &&
        destinationPerSourceRate &&
        sourceToken.symbol &&
        destinationToken.symbol
    ) {
        rateLabel = `1 ${sourceToken.symbol} (${formatCurrencyWithSubCent(sourceUnitPriceUsd)}) ≈ ${formatTokenDisplayAmount(destinationPerSourceRate)} ${destinationToken.symbol}`;
    } else if (sourceUnitPriceUsd && sourceToken.symbol) {
        rateLabel = `1 ${sourceToken.symbol} = ${formatCurrencyWithSubCent(sourceUnitPriceUsd)}`;
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
    token,
    amount,
    usdValue,
    usdLoading = false,
}: {
    token?: Partial<TokenMetadata> | null;
    amount: string;
    usdValue: string | null;
    usdLoading?: boolean;
}): TokenReceiptInfo {
    const tokenId = token?.tokenId;

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

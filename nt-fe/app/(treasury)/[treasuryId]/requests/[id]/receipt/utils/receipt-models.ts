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
        amountDecimal: string;
        amountDisplay: string;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
    destinationToken: {
        amountDecimal?: string;
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
    const sourceAmountDisplay = isExchangeReceipt
        ? (quote?.amountInFormatted ?? sourceToken.amountDisplay)
        : sourceToken.amountDisplay;
    const destinationAmountDisplay =
        quote?.amountOutFormatted ||
        formatTokenDisplayAmount(destinationToken.amountDecimal || "0");

    const sourceUnitPriceUsd =
        sourceAmountValue > 0 && Number(quote?.amountInUsd) > 0
            ? Number(quote?.amountInUsd) / sourceAmountValue
            : hasDepositAddress
              ? sourceToken.tokenPrice
              : sourceToken.historicalPriceUsd;

    const sourceAmountUsd = quote?.amountInUsd
        ? formatCurrency(Number(quote.amountInUsd))
        : !hasDepositAddress && sourceUnitPriceUsd != null
          ? formatCurrency(
                Number(sourceToken.amountDecimal) * sourceUnitPriceUsd,
            )
          : hasDepositAddress && sourceToken.tokenPrice != null
            ? formatCurrency(
                  Number(sourceToken.amountDecimal) * sourceToken.tokenPrice,
              )
            : null;

    const destinationUnitPriceUsd = hasDepositAddress
        ? destinationToken.tokenPrice
        : destinationToken.historicalPriceUsd;
    const destinationAmountUsd = quote?.amountOutUsd
        ? formatCurrency(Number(quote.amountOutUsd))
        : !hasDepositAddress && destinationUnitPriceUsd != null
          ? formatCurrency(
                Number(destinationToken.amountDecimal ?? "0") *
                    destinationUnitPriceUsd,
            )
          : hasDepositAddress &&
              destinationToken.tokenPrice != null &&
              quote?.amountOutFormatted
            ? formatCurrency(
                  Number(quote.amountOutFormatted) *
                      destinationToken.tokenPrice,
              )
            : sourceAmountUsd;
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

import {
    decimalOrNull,
    formatFiatValue,
    formatRate,
    formatTokenQuantity,
    formatUnitPrice,
} from "@/lib/amount-format";
import type { ChainIcons, TokenMetadata } from "@/lib/api";
import type Big from "@/lib/big";
import type { SwapQuoteResponse } from "@/lib/proposals-api";

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
    locale = "en-US",
}: {
    isExchangeReceipt: boolean;
    hasDepositAddress: boolean;
    quote?: SwapQuoteResponse | null;
    sourceToken: {
        amountDecimal: string | null;
        amountDisplay: string;
        amountUsd?: number;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
    destinationToken: {
        amountDecimal?: string | null;
        amountUsd?: number;
        symbol: string;
        tokenPrice: number | null;
        historicalPriceUsd: number | null;
    };
    locale?: string;
}) {
    const sourceAmountValue =
        decimalOrNull(quote?.amountInFormatted) ??
        decimalOrNull(sourceToken.amountDecimal);
    const destinationAmountValue =
        decimalOrNull(quote?.amountOutFormatted) ??
        decimalOrNull(destinationToken.amountDecimal);
    const quoteSourceAmountUsd = decimalOrNull(quote?.amountInUsd);
    const quoteDestinationAmountUsd = decimalOrNull(quote?.amountOutUsd);
    // A recorded amountUsd is authoritative and suppresses the quote/historical
    // fallbacks; only an absent one enables them. Extraction already collapses
    // an unrecorded figure to absent, so those are the only two states here.
    const hasExplicitSourceUsd = sourceToken.amountUsd !== undefined;
    const hasExplicitDestinationUsd = destinationToken.amountUsd !== undefined;
    const explicitSourceAmountUsd = decimalOrNull(sourceToken.amountUsd);
    const explicitDestinationAmountUsd = decimalOrNull(
        destinationToken.amountUsd,
    );
    const historicalSourcePrice = decimalOrNull(sourceToken.historicalPriceUsd);
    const historicalDestinationPrice = decimalOrNull(
        destinationToken.historicalPriceUsd,
    );
    const sourceAmountDisplay = isExchangeReceipt
        ? formatTokenQuantity(sourceAmountValue, {
              locale,
              profile: "standard",
              unitPriceUsd: sourceToken.tokenPrice,
          }).display
        : sourceToken.amountDisplay;
    const destinationAmountDisplay = formatTokenQuantity(
        destinationAmountValue,
        {
            locale,
            profile: "standard",
            unitPriceUsd: destinationToken.tokenPrice,
        },
    ).display;

    let sourceUnitPriceUsd: Big | null = null;
    if (hasExplicitSourceUsd) {
        sourceUnitPriceUsd =
            explicitSourceAmountUsd && sourceAmountValue?.gt(0)
                ? explicitSourceAmountUsd.div(sourceAmountValue)
                : null;
    } else if (
        sourceAmountValue?.gt(0) &&
        quoteSourceAmountUsd != null &&
        quoteSourceAmountUsd.gt(0)
    ) {
        sourceUnitPriceUsd = quoteSourceAmountUsd.div(sourceAmountValue);
    } else if (!hasDepositAddress) {
        sourceUnitPriceUsd = historicalSourcePrice;
    }

    let sourceAmountUsd: string | null = null;
    if (hasExplicitSourceUsd) {
        sourceAmountUsd = explicitSourceAmountUsd
            ? formatFiatValue(explicitSourceAmountUsd, { locale }).display
            : null;
    } else if (quoteSourceAmountUsd) {
        sourceAmountUsd = formatFiatValue(quoteSourceAmountUsd, {
            locale,
        }).display;
    } else if (
        !hasDepositAddress &&
        sourceUnitPriceUsd != null &&
        sourceAmountValue
    ) {
        sourceAmountUsd = formatFiatValue(
            sourceAmountValue.mul(sourceUnitPriceUsd),
            { locale },
        ).display;
    }

    let destinationUnitPriceUsd: Big | null = null;
    if (hasExplicitDestinationUsd) {
        destinationUnitPriceUsd =
            explicitDestinationAmountUsd && destinationAmountValue?.gt(0)
                ? explicitDestinationAmountUsd.div(destinationAmountValue)
                : null;
    } else if (!hasDepositAddress) {
        destinationUnitPriceUsd = historicalDestinationPrice;
    }

    let destinationAmountUsd: string | null = null;
    if (hasExplicitDestinationUsd) {
        destinationAmountUsd = explicitDestinationAmountUsd
            ? formatFiatValue(explicitDestinationAmountUsd, { locale }).display
            : null;
    } else if (quoteDestinationAmountUsd) {
        destinationAmountUsd = formatFiatValue(quoteDestinationAmountUsd, {
            locale,
        }).display;
    } else if (
        !hasDepositAddress &&
        destinationUnitPriceUsd != null &&
        destinationAmountValue
    ) {
        destinationAmountUsd = formatFiatValue(
            destinationAmountValue.mul(destinationUnitPriceUsd),
            { locale },
        ).display;
    } else {
        destinationAmountUsd = sourceAmountUsd;
    }
    const destinationPerSourceRate =
        sourceAmountValue?.gt(0) && destinationAmountValue?.gt(0)
            ? destinationAmountValue.div(sourceAmountValue)
            : null;

    let rateLabel: string | null = null;
    if (
        sourceUnitPriceUsd &&
        destinationPerSourceRate &&
        sourceToken.symbol &&
        destinationToken.symbol
    ) {
        rateLabel = `1 ${sourceToken.symbol} (${formatUnitPrice(sourceUnitPriceUsd, { locale }).display}) ≈ ${formatRate(destinationPerSourceRate, { locale }).display} ${destinationToken.symbol}`;
    } else if (sourceUnitPriceUsd && sourceToken.symbol) {
        rateLabel = `1 ${sourceToken.symbol} = ${formatUnitPrice(sourceUnitPriceUsd, { locale }).display}`;
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

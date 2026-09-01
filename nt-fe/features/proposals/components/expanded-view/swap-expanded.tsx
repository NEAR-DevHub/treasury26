import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { Address } from "@/components/address";
import { FormattedAmount } from "@/components/formatted-amount";
import { FormattedDate } from "@/components/formatted-date";
import { InfoDisplay, type InfoItem } from "@/components/info-display";
import { Rate } from "@/components/rate";
import { Skeleton } from "@/components/ui/skeleton";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import { useQuoteByDepositAddress } from "@/hooks/use-proposals";
import { useSearchIntentsTokens, useToken } from "@/hooks/use-treasury-queries";
import { decimalFromBaseUnitsOrNull, decimalOrNull } from "@/lib/amount-format";
import {
    calculateExchangeFeeAmount,
    EXCHANGE_FEE_PERCENTAGE,
} from "@/lib/exchange-fee";
import { formatDurationSeconds } from "@/lib/utils";
import type { SwapRequestData } from "../../types/index";
import { Amount } from "../amount";

interface SwapExpandedProps {
    data: SwapRequestData;
    isExecuted?: boolean;
}

interface NearWrapSwapExpandedProps {
    data: SwapRequestData;
}

function IntentsSwapExpanded({ data, isExecuted = false }: SwapExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const tExchange = useTranslations("exchange");
    const locale = useLocale();
    // For new proposals: use token addresses from description
    // For old proposals: use search hook with symbols as fallback
    const hasAddresses = !!(data.tokenInAddress && data.tokenOutAddress);

    // Legacy fallback: use search hook for old proposals without addresses
    const { data: legacyTokensData } = useSearchIntentsTokens(
        {
            tokenIn: data.tokenIn,
            tokenOut: data.tokenOut,
            intentsTokenContractId: data.intentsTokenContractId,
            destinationNetwork: data.destinationNetwork,
        },
        !hasAddresses,
    );

    // Use addresses if available, otherwise fall back to legacy search
    const finalTokenInId =
        data.tokenInAddress ||
        legacyTokensData?.tokenIn?.defuseAssetId ||
        data.tokenIn;
    const finalTokenOutId =
        data.tokenOutAddress ||
        legacyTokensData?.tokenOut?.defuseAssetId ||
        data.tokenOut;
    const shouldLoadQuoteUsd =
        isExecuted &&
        !!data.depositAddress &&
        (data.amountInUsd === undefined || data.amountOutUsd === undefined);
    const { data: quoteByDepositAddress } = useQuoteByDepositAddress(
        data.depositAddress || null,
        undefined,
        shouldLoadQuoteUsd,
    );
    const sourceAmountUsdRaw =
        data.amountInUsd != null
            ? String(data.amountInUsd)
            : quoteByDepositAddress?.amountInUsd;
    const destinationAmountUsdRaw =
        data.amountOutUsd != null
            ? String(data.amountOutUsd)
            : quoteByDepositAddress?.amountOutUsd;
    const sourceAmountUsd =
        sourceAmountUsdRaw && !Number.isNaN(Number(sourceAmountUsdRaw))
            ? Number(sourceAmountUsdRaw)
            : undefined;
    const destinationAmountUsd =
        destinationAmountUsdRaw &&
        !Number.isNaN(Number(destinationAmountUsdRaw))
            ? Number(destinationAmountUsdRaw)
            : undefined;
    const { data: tokenInData, isLoading: isTokenInLoading } =
        useToken(finalTokenInId);

    const minimumReceived = useMemo(() => {
        const amountOut = decimalOrNull(data.amountOut);
        const slippage = decimalOrNull(data.slippage ?? "0");
        if (!amountOut || !slippage) return null;
        return amountOut.minus(amountOut.mul(slippage).div(100));
    }, [data.amountOut, data.slippage]);
    const exchangeFeeAmount = useMemo(() => {
        const amountIn = decimalFromBaseUnitsOrNull(
            data.amountIn,
            tokenInData?.decimals || 24,
        );
        return amountIn ? calculateExchangeFeeAmount(amountIn.toFixed()) : null;
    }, [data.amountIn, tokenInData?.decimals]);

    const infoItems: InfoItem[] = [
        {
            label: t("send"),
            value: (
                <Amount
                    amount={data.amountIn}
                    showUSDValue={data.amountInUsd !== null}
                    usdValue={sourceAmountUsd}
                    showNetworkTooltip
                    tokenId={finalTokenInId}
                />
            ),
        },
        {
            label: t("receive"),
            value: (
                <Amount
                    amountWithDecimals={data.amountOut}
                    showUSDValue={data.amountOutUsd !== null}
                    usdValue={destinationAmountUsd}
                    showNetworkTooltip
                    tokenId={finalTokenOutId}
                />
            ),
        },
        {
            label: t("rate"),
            value: (
                <Rate
                    tokenIn={finalTokenInId}
                    tokenOut={finalTokenOutId}
                    amountIn={data.amountIn}
                    amountInUsd={data.amountInUsd}
                    amountOutWithDecimals={data.amountOut}
                />
            ),
        },
    ];

    const expandableItems: InfoItem[] = [];

    if (data.slippage) {
        expandableItems.push({
            label: t("priceSlippageLimit"),
            value: <FormattedAmount kind="percent" value={data.slippage} />,
            info: t("slippageTooltip"),
        });
    }

    if (data.timeEstimate) {
        const estimatedSeconds = Number(data.timeEstimate);
        const formattedDuration = formatDurationSeconds(
            estimatedSeconds,
            locale,
        );
        expandableItems.push({
            label: t("estimatedTime"),
            value: <span>{formattedDuration}</span>,
            info: t("estimatedTimeTooltip"),
        });
    }

    expandableItems.push({
        label: t("minReceive"),
        value: (
            <Amount
                amountWithDecimals={minimumReceived?.toString()}
                showNetworkTooltip
                tokenId={finalTokenOutId}
            />
        ),
        info: t("minReceiveTooltip"),
    });

    if (data.depositAddress) {
        expandableItems.push({
            label: t("depositAddress"),
            value: <Address address={data.depositAddress} copyable={true} />,
            info: t("depositAddressTooltip"),
        });
    }

    if (data.quoteSignature) {
        expandableItems.push({
            label: t("quoteSignature"),
            value: (
                <Address
                    address={data.quoteSignature}
                    copyable={true}
                    prefixLength={16}
                />
            ),
            info: t("quoteSignatureTooltip"),
        });
    }

    if (data.quoteDeadline) {
        expandableItems.push({
            label: t("quoteDeadline"),
            value: <FormattedDate date={data.quoteDeadline} />,
            info: t("quoteDeadlineTooltip"),
        });
    }

    expandableItems.push({
        label: tExchange("info.exchangeFee"),
        value: isTokenInLoading ? (
            <Skeleton className="h-5 w-24" />
        ) : (
            <span>
                <FormattedAmount
                    kind="percent"
                    value={EXCHANGE_FEE_PERCENTAGE}
                />{" "}
                /{" "}
                <FormattedAmount
                    kind="token"
                    value={exchangeFeeAmount}
                    symbol={tokenInData?.symbol || ""}
                    tokenDecimals={tokenInData?.decimals}
                    unitPriceUsd={tokenInData?.price}
                    profile="standard"
                    rounding="up"
                />
            </span>
        ),
        info: tExchange("info.exchangeFeeTooltip"),
    });

    return <InfoDisplay items={infoItems} expandableItems={expandableItems} />;
}

function NearWrapSwapExpanded({ data }: NearWrapSwapExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const locale = useLocale();
    const infoItems: InfoItem[] = [
        {
            label: t("send"),
            value: (
                <Amount
                    amountWithDecimals={data.amountIn}
                    showNetworkTooltip
                    tokenId={data.tokenIn}
                />
            ),
        },
        {
            label: t("receive"),
            value: (
                <Amount
                    amountWithDecimals={data.amountOut}
                    showNetworkTooltip
                    tokenId={data.tokenOut}
                />
            ),
        },
        {
            label: t("rate"),
            value: (
                <Rate
                    tokenIn={data.tokenIn}
                    tokenOut={data.tokenOut}
                    amountInWithDecimals={data.amountIn}
                    amountOutWithDecimals={data.amountOut}
                />
            ),
        },
    ];

    const expandableItems: InfoItem[] = [];

    if (data.slippage) {
        expandableItems.push({
            label: t("priceSlippageLimit"),
            value: <FormattedAmount kind="percent" value={data.slippage} />,
            info: t("slippageTooltip"),
        });
    }

    if (data.timeEstimate) {
        const estimatedSeconds = Number(data.timeEstimate);
        const formattedDuration = formatDurationSeconds(
            estimatedSeconds,
            locale,
        );
        expandableItems.push({
            label: t("estimatedTime"),
            value: <span>{formattedDuration}</span>,
            info: t("estimatedTimeTooltip"),
        });
    }

    expandableItems.push({
        label: t("minimumReceived"),
        value: (
            <Amount
                amountWithDecimals={data.amountOut}
                showNetworkTooltip
                tokenId={data.tokenOut}
            />
        ),
        info: t("minReceiveTooltip"),
    });

    if (data.depositAddress) {
        expandableItems.push({
            label: t("depositAddress"),
            value: <Address address={data.depositAddress} copyable={true} />,
            info: t("depositAddressTooltip"),
        });
    }

    if (data.quoteSignature) {
        expandableItems.push({
            label: t("quoteSignature"),
            value: (
                <Address
                    address={data.quoteSignature}
                    copyable={true}
                    prefixLength={16}
                />
            ),
            info: t("quoteSignatureTooltip"),
        });
    }

    if (data.quoteDeadline) {
        expandableItems.push({
            label: t("quoteDeadline"),
            value: <FormattedDate date={data.quoteDeadline} />,
            info: t("quoteDeadlineTooltip"),
        });
    }
    return <InfoDisplay items={infoItems} expandableItems={expandableItems} />;
}

export function SwapExpanded({ data, isExecuted = false }: SwapExpandedProps) {
    switch (data.source) {
        case "exchange":
            return <IntentsSwapExpanded data={data} isExecuted={isExecuted} />;
        case WRAP_NEAR_TOKEN_ID:
            return <NearWrapSwapExpanded data={data} />;
        default:
            return null;
    }
}

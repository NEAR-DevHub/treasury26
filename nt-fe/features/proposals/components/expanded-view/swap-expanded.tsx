import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { SwapRequestData } from "../../types/index";
import {
    formatCurrency,
    formatBalance,
    formatDurationSeconds,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { useMemo } from "react";
import Big from "@/lib/big";
import { Address } from "@/components/address";
import { Rate } from "@/components/rate";
import { useToken, useSearchIntentsTokens } from "@/hooks/use-treasury-queries";
import { useQuoteByDepositAddress } from "@/hooks/use-proposals";
import { FormattedDate } from "@/components/formatted-date";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import {
    calculateExchangeFeeAmount,
    EXCHANGE_FEE_PERCENTAGE,
} from "@/lib/exchange-fee";
import { Skeleton } from "@/components/ui/skeleton";

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
        !(data.quoteAmountInUsd && data.quoteAmountOutUsd);
    const { data: quoteByDepositAddress } = useQuoteByDepositAddress(
        data.depositAddress || null,
        undefined,
        shouldLoadQuoteUsd,
    );
    const sourceAmountUsdRaw =
        data.quoteAmountInUsd ?? quoteByDepositAddress?.amountInUsd;
    const destinationAmountUsdRaw =
        data.quoteAmountOutUsd ?? quoteByDepositAddress?.amountOutUsd;
    const sourceAmountUsdOverride =
        sourceAmountUsdRaw && !Number.isNaN(Number(sourceAmountUsdRaw))
            ? formatCurrency(Number(sourceAmountUsdRaw))
            : null;
    const destinationAmountUsdOverride =
        destinationAmountUsdRaw &&
        !Number.isNaN(Number(destinationAmountUsdRaw))
            ? formatCurrency(Number(destinationAmountUsdRaw))
            : null;
    const { data: tokenInData, isLoading: isTokenInLoading } =
        useToken(finalTokenInId);

    const minimumReceived = useMemo(() => {
        return Big(data.amountOut)
            .mul(Big(100 - Number(data.slippage || 0)))
            .div(100);
    }, [data.amountOut, data.slippage]);
    const exchangeFeeAmount = useMemo(() => {
        return calculateExchangeFeeAmount(
            formatBalance(data.amountIn, tokenInData?.decimals || 24),
        );
    }, [data.amountIn, tokenInData?.decimals]);

    const infoItems: InfoItem[] = [
        {
            label: t("send"),
            value: (
                <Amount
                    amount={data.amountIn}
                    showNetworkTooltip
                    tokenId={finalTokenInId}
                    usdTextOverride={sourceAmountUsdOverride}
                />
            ),
        },
        {
            label: t("receive"),
            value: (
                <Amount
                    amountWithDecimals={data.amountOut}
                    showNetworkTooltip
                    tokenId={finalTokenOutId}
                    usdTextOverride={destinationAmountUsdOverride}
                />
            ),
        },
        {
            label: t("rate"),
            value: (
                <Rate
                    tokenIn={finalTokenInId}
                    tokenOut={finalTokenOutId}
                    amountIn={Big(data.amountIn)}
                    amountOutWithDecimals={data.amountOut}
                />
            ),
        },
    ];

    let expandableItems: InfoItem[] = [];

    if (data.slippage) {
        expandableItems.push({
            label: t("priceSlippageLimit"),
            value: <span>{data.slippage}%</span>,
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
                amountWithDecimals={minimumReceived.toString()}
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
            `${EXCHANGE_FEE_PERCENTAGE}% / ${formatTokenDisplayAmount(
                exchangeFeeAmount,
            )} ${tokenInData?.symbol || ""}`.trim()
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
                    amount={data.amountIn}
                    showNetworkTooltip
                    tokenId={data.tokenIn}
                />
            ),
        },
        {
            label: t("receive"),
            value: (
                <Amount
                    amount={data.amountOut}
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
                    amountIn={Big(data.amountIn)}
                    amountOut={Big(data.amountOut)}
                />
            ),
        },
    ];

    let expandableItems: InfoItem[] = [];

    if (data.slippage) {
        expandableItems.push({
            label: t("priceSlippageLimit"),
            value: <span>{data.slippage}%</span>,
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
                amount={data.amountOut}
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

"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { FormattedAmount } from "@/components/formatted-amount";
import { getNetworkDisplayName } from "@/components/token-display";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Tooltip } from "@/components/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useToken } from "@/hooks/use-treasury-queries";
import {
    type AmountRounding,
    decimalFromBaseUnitsOrNull,
    decimalOrNull,
} from "@/lib/amount-format";
import { getLocalizedNetworkDisplayName } from "@/lib/intents-network";
import { getNearTokenTypeLabel } from "@/lib/utils";
import { useRequestDisplayContext } from "./expanded-view/common/request-display-context";

interface AmountProps {
    amount?: string;
    amountWithDecimals?: string;
    tokenId: string;
    showUSDValue?: boolean;
    showNetwork?: boolean;
    showNetworkTooltip?: boolean;
    expandNearComLabel?: boolean;
    usdValue?: number;
    network?: string; // Optional override for network display
    textOnly?: boolean;
    iconSize?: "sm" | "md" | "lg";
    usdTextOverride?: React.ReactNode;
    /** Enable NearBlocks FT metadata fallback for native NEAR tokens */
    nearFt?: boolean;
    rounding?: AmountRounding;
}

function resolveAmountNetworkLabel({
    tokenId,
    tokenNetwork,
    networkOverride,
    networkLabelText,
    expandNearComLabel,
}: {
    tokenId: string;
    tokenNetwork?: string;
    networkOverride?: string;
    networkLabelText: string;
    expandNearComLabel: boolean;
}): string | undefined {
    const normalizedTokenId = tokenId.trim().toLowerCase();
    const isNativeNearToken =
        normalizedTokenId.length === 0 || normalizedTokenId === NEAR_NETWORK_ID;
    const resolvedNetwork = isNativeNearToken
        ? NEAR_NETWORK_ID
        : (networkOverride ?? tokenNetwork);

    const nearTypeLabel = getNearTokenTypeLabel(
        isNativeNearToken ? NEAR_NETWORK_ID : tokenId,
        resolvedNetwork,
        { expandNearComLabel },
    );

    if (nearTypeLabel) {
        return nearTypeLabel;
    }

    if (!resolvedNetwork) {
        return undefined;
    }

    return getLocalizedNetworkDisplayName({
        networkName: resolvedNetwork,
        networkLabel: networkLabelText,
        fallbackName: getNetworkDisplayName(resolvedNetwork),
        expandNearComLabel,
    });
}

export function Amount({
    amount,
    amountWithDecimals,
    textOnly = false,
    tokenId,
    showUSDValue = true,
    showNetwork = false,
    showNetworkTooltip = false,
    expandNearComLabel = false,
    usdValue,
    network,
    iconSize = "lg",
    usdTextOverride,
    nearFt,
    rounding,
}: AmountProps) {
    const tCommon = useTranslations("common");
    const tAmount = useTranslations("amount");
    const tAddressBookTable = useTranslations("addressBookTable");
    const requestDisplayContext = useRequestDisplayContext();
    const effectiveShowUSDValue =
        showUSDValue &&
        ((requestDisplayContext?.showUSDValue ?? true) ||
            usdValue !== undefined);
    const tokenOpts = nearFt ? { nearFt: true } : undefined;
    const { data: tokenData, isLoading } = useToken(tokenId, tokenOpts);
    const decimalAmount = useMemo(() => {
        return amount
            ? decimalFromBaseUnitsOrNull(amount, tokenData?.decimals || 24)
            : decimalOrNull(amountWithDecimals);
    }, [amount, amountWithDecimals, tokenData?.decimals]);
    const estimatedUSDValue = useMemo(() => {
        if (usdValue !== undefined) {
            return decimalOrNull(usdValue);
        }

        const price = decimalOrNull(tokenData?.price);
        if (!price?.gt(0) || !decimalAmount) return null;

        return decimalAmount.mul(price);
    }, [tokenData?.price, decimalAmount, usdValue]);
    const amountDisplay = (
        <FormattedAmount
            kind="token"
            value={decimalAmount}
            symbol={tokenData?.symbol ?? ""}
            tokenDecimals={tokenData?.decimals}
            unitPriceUsd={tokenData?.price}
            profile="standard"
            rounding={rounding}
        />
    );
    const usdDisplay = (
        <>
            ≈{" "}
            {usdTextOverride ??
                (estimatedUSDValue ? (
                    <FormattedAmount kind="fiat" value={estimatedUSDValue} />
                ) : (
                    tCommon("notAvailable")
                ))}
        </>
    );
    const networkLabel = resolveAmountNetworkLabel({
        tokenId,
        tokenNetwork: tokenData?.network,
        networkOverride: network,
        networkLabelText: tAddressBookTable("network"),
        expandNearComLabel,
    });
    const networkTooltipContent = networkLabel
        ? tAmount("network", { network: networkLabel })
        : null;

    if (isLoading) {
        if (textOnly) {
            return <Skeleton className="h-5 w-24" />;
        }
        return (
            <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <Skeleton className="h-5 w-20" />
                    {effectiveShowUSDValue && <Skeleton className="h-4 w-16" />}
                </div>
                {showNetwork && <Skeleton className="h-3 w-24" />}
            </div>
        );
    }

    if (textOnly) {
        const textOnlyAmount = (
            <div className="flex flex-col items-end gap-0.5">
                <p className="text-sm font-semibold">{amountDisplay}</p>
                {effectiveShowUSDValue && (
                    <span className="text-muted-foreground text-xs">
                        {usdDisplay}
                    </span>
                )}
            </div>
        );

        if (showNetworkTooltip && networkTooltipContent) {
            return (
                <Tooltip content={networkTooltipContent}>
                    <span>{textOnlyAmount}</span>
                </Tooltip>
            );
        }

        return textOnlyAmount;
    }

    const amountContent = (
        <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
                {tokenData && (
                    <TokenDisplay
                        symbol={tokenData.symbol}
                        icon={tokenData.icon ?? ""}
                        chainIcons={tokenData.chainIcons}
                        iconSize={iconSize}
                    />
                )}
                {tokenData && (
                    <span className="font-medium">{amountDisplay}</span>
                )}
            </div>
            {effectiveShowUSDValue && (
                <span className="text-muted-foreground text-xs">
                    {usdDisplay}
                </span>
            )}
            {showNetwork &&
                (networkLabel ? (
                    <span className="text-muted-foreground text-xs">
                        {tAmount("network", { network: networkLabel })}
                    </span>
                ) : null)}
        </div>
    );

    if (showNetworkTooltip && networkTooltipContent) {
        return (
            <Tooltip content={networkTooltipContent}>
                <div>{amountContent}</div>
            </Tooltip>
        );
    }

    return amountContent;
}

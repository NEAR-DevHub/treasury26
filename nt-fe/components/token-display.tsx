"use client";

import { useTranslations } from "next-intl";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import type { ChainIcons, TreasuryAsset } from "@/lib/api";
import type Big from "@/lib/big";
import {
    getLocalizedNetworkDisplayName,
    getNetworkDisplayCaseClass,
    getNetworkDisplayName,
    networksMatchAliased,
} from "@/lib/intents-network";
import { cn, formatCurrencyWithSubCent, formatSmartAmount } from "@/lib/utils";
import { MaskedBalance } from "./balance-mask";
import { TokenDisplay as TokenWithNetworkDisplay } from "./token-display-with-network";
import { TokenIconImage } from "./token-icon-image";

// Re-export network label helpers so existing `@/components/token-display` imports keep working.
export { getNetworkDisplayName, networksMatchAliased };

interface NetworkIconDisplayProps {
    chainIcons: ChainIcons | null;
    networkName: string;
    residency?: string;
    networkNameClassName?: string;
    expandNearComLabel?: boolean;
    className?: string;
    iconClassName?: string;
}

const useResidencyLabel = () => {
    const t = useTranslations("residency");
    return (residency?: string): string => {
        switch (residency) {
            case "Lockup":
                return t("vestedToken");
            case "Staked":
                return t("staked");
            case "Ft":
                return t("fungibleToken");
            case "Intents":
                return t("intentsToken");
            case "Near":
                return t("nativeToken");
            default:
                return t("intentsToken");
        }
    };
};

export const NetworkIconDisplay = ({
    chainIcons,
    networkName,
    residency,
    networkNameClassName,
    expandNearComLabel = false,
    className,
    iconClassName,
}: NetworkIconDisplayProps) => {
    const getResidencyLabel = useResidencyLabel();
    const tAddressBookTable = useTranslations("addressBookTable");

    const isNEAR = networkName.toLowerCase() === NEAR_NETWORK_ID;
    const displayName = getLocalizedNetworkDisplayName({
        networkName,
        networkLabel: tAddressBookTable("network"),
        fallbackName: getNetworkDisplayName(networkName),
        expandNearComLabel,
    });

    return (
        <div className={cn("flex items-center gap-3", className)}>
            <TokenIconImage
                icon={chainIcons?.icon}
                alt={`${networkName} network`}
                className={cn("size-6", iconClassName)}
                gradient="bg-brand-blue"
            />
            <div className="flex flex-col gap-0 items-baseline text-left">
                <span
                    className={cn(
                        "font-semibold",
                        getNetworkDisplayCaseClass(networkName),
                        networkNameClassName,
                    )}
                >
                    {displayName}
                </span>
                {isNEAR && residency && (
                    <span className="text-xs text-muted-foreground">
                        {getResidencyLabel(residency)}
                    </span>
                )}
            </div>
        </div>
    );
};

export const NetworkDisplay = ({
    asset,
    subLabel,
}: {
    asset: TreasuryAsset;
    subLabel?: string;
}) => {
    const tRes = useTranslations("residency");
    const tAddressBookTable = useTranslations("addressBookTable");

    let type;
    switch (asset.residency) {
        case "Lockup":
            type = tRes("vestedToken");
            break;
        case "Staked":
            type = tRes("staked");
            break;
        case "Ft":
            type = tRes("fungibleToken");
            break;
        case "Intents":
            type = getLocalizedNetworkDisplayName({
                networkName: "near.com",
                networkLabel: tAddressBookTable("network"),
                fallbackName: "near.com",
            });
            break;
        case "Near":
            type = tRes("nativeToken");
            break;
    }

    const image = asset.chainIcons ? asset.chainIcons.icon : asset.icon;

    return (
        <div className="flex items-center gap-3 min-w-0">
            <TokenIconImage
                icon={image}
                alt={`${asset.chainName} network`}
                className="size-6"
            />
            <div className="flex min-w-0 flex-col text-left">
                <span className="truncate font-semibold capitalize">
                    {asset.chainName}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                    {subLabel ?? type}
                </span>
            </div>
        </div>
    );
};

export const BalanceCell = ({
    balance,
    symbol,
    balanceUSD,
    amountFirst = false,
    hideSymbol = false,
    size = "sm",
}: {
    balance: Big;
    symbol: string;
    balanceUSD: number;
    /** Show the token amount as the primary line and the USD value below it. */
    amountFirst?: boolean;
    /** Drop the symbol suffix when it is already visible in the same row. */
    hideSymbol?: boolean;
    size?: "sm" | "md";
}) => {
    const amount = hideSymbol
        ? formatSmartAmount(balance)
        : `${formatSmartAmount(balance)} ${symbol}`;
    const usd = formatCurrencyWithSubCent(balanceUSD);
    const primaryClass =
        size === "md"
            ? "font-semibold text-base/5 text-gray-900 dark:text-white"
            : "font-medium text-sm";
    const secondaryClass =
        size === "md"
            ? "font-medium text-gray-500 text-sm/5 dark:text-gray-400"
            : "text-muted-foreground text-xxs";

    return (
        <div className="min-w-0 max-w-full overflow-hidden text-right">
            <div className={cn("truncate", primaryClass)}>
                <MaskedBalance>{amountFirst ? amount : usd}</MaskedBalance>
            </div>
            <div className={cn("truncate", secondaryClass)}>
                <MaskedBalance>{amountFirst ? usd : amount}</MaskedBalance>
            </div>
        </div>
    );
};

export const TokenAmountDisplay = ({
    icon,
    chainIcons,
    symbol,
    amount,
    className,
}: {
    icon?: string;
    chainIcons?: ChainIcons;
    symbol: string;
    amount: string;
    className?: string;
}) => {
    return (
        <div className="flex items-center gap-2">
            {(icon || chainIcons) && (
                <TokenWithNetworkDisplay
                    symbol={symbol}
                    icon={icon || ""}
                    chainIcons={chainIcons}
                    iconSize="lg"
                />
            )}
            <div className={className}>
                {amount} {symbol}
            </div>
        </div>
    );
};

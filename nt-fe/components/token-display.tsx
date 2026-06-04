import { useTranslations } from "next-intl";
import { ChainIcons, TreasuryAsset } from "@/lib/api";
import { cn, formatCurrency, formatSmartAmount } from "@/lib/utils";
import Big from "@/lib/big";
import {
    getNetworkDisplayCaseClass,
    getLocalizedNetworkDisplayName,
} from "@/lib/intents-network";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { TokenDisplay as TokenWithNetworkDisplay } from "./token-display-with-network";

interface NetworkIconDisplayProps {
    chainIcons: ChainIcons | null;
    networkName: string;
    residency?: string;
    networkNameClassName?: string;
    expandNearComLabel?: boolean;
}

const NETWORK_DISPLAY_NAMES: Record<string, string> = {
    eth: "Ethereum",
    ethereum: "Ethereum",
    btc: "Bitcoin",
    bitcoin: "Bitcoin",
    sol: "Solana",
    solana: "Solana",
    arb: "Arbitrum",
    arbitrum: "Arbitrum",
    pol: "Polygon",
    polygon: "Polygon",
    bsc: "BNB Chain",
    trx: "Tron",
    tron: "Tron",
    xlm: "Stellar",
    stellar: "Stellar",
    apt: "Aptos",
    aptos: "Aptos",
    ada: "Cardano",
    cardano: "Cardano",
    doge: "Dogecoin",
    dogecoin: "Dogecoin",
    zec: "Zcash",
    zcash: "Zcash",
    xrp: "XRP",
    bera: "Berachain",
    berachain: "Berachain",
    near: "NEAR",
};

export const getNetworkDisplayName = (name: string): string => {
    return NETWORK_DISPLAY_NAMES[name.toLowerCase()] ?? name;
};

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
}: {
    chainIcons: ChainIcons | null;
    networkName: string;
    residency?: string;
    networkNameClassName?: string;
    expandNearComLabel?: boolean;
    className?: string;
}) => {
    const getResidencyLabel = useResidencyLabel();
    const tAddressBookTable = useTranslations("addressBookTable");

    const iconUrl = chainIcons?.icon ?? null;

    const isNEAR = networkName.toLowerCase() === NEAR_NETWORK_ID;
    const displayName = getLocalizedNetworkDisplayName({
        networkName,
        networkLabel: tAddressBookTable("network"),
        fallbackName: getNetworkDisplayName(networkName),
        expandNearComLabel,
    });

    return (
        <div className={cn("flex items-center gap-3", className)}>
            {iconUrl ? (
                <img
                    src={iconUrl}
                    alt={`${networkName} network`}
                    className="size-6 rounded-full object-cover"
                />
            ) : (
                <div className="size-6 rounded-full bg-gradient-cyan-blue flex items-center justify-center text-white text-xs font-bold">
                    {networkName.charAt(0)}
                </div>
            )}
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
        <div className="flex items-center gap-3">
            <img
                src={image}
                alt={`${asset.chainName} network`}
                className="size-6"
            />
            <div className="flex flex-col text-left">
                <span className="font-semibold capitalize">
                    {asset.chainName}
                </span>
                <span className="text-xs text-muted-foreground">
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
}: {
    balance: Big;
    symbol: string;
    balanceUSD: number;
}) => {
    return (
        <div className="text-right">
            <div className="font-medium text-sm">
                {formatCurrency(balanceUSD)}
            </div>
            <div className="text-xxs text-muted-foreground">
                {formatSmartAmount(balance)} {symbol}
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

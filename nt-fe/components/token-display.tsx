import { ChainIcons, TreasuryAsset } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme-store";
import Big from "@/lib/big";

interface NetworkIconDisplayProps {
    chainIcons: ChainIcons | null;
    networkName: string;
    residency?: string;
}

const getResidencyLabel = (residency?: string): string => {
    switch (residency) {
        case "Lockup":
            return "Vested Token";
        case "Staked":
            return "Staked";
        case "Ft":
            return "Fungible Token";
        case "Intents":
            return "Intents Token";
        case "Near":
            return "Native Token";
        default:
            return "Intents Token";
    }
};

export const NetworkIconDisplay = ({
    chainIcons,
    networkName,
    residency,
}: NetworkIconDisplayProps) => {
    const { theme } = useThemeStore();

    const iconUrl = chainIcons
        ? theme === "dark"
            ? chainIcons.dark
            : chainIcons.light
        : null;

    return (
        <div className="flex items-center gap-3">
            {iconUrl ? (
                <img
                    src={iconUrl}
                    alt={`${networkName} network`}
                    className="size-6"
                />
            ) : (
                <div className="size-6 rounded-full bg-gradient-cyan-blue flex items-center justify-center text-white text-xs font-bold">
                    {networkName.charAt(0)}
                </div>
            )}
            <div className="flex flex-col text-left">
                <span className="font-semibold capitalize">{networkName}</span>
                <span className="text-xs text-muted-foreground">
                    {getResidencyLabel(residency)}
                </span>
            </div>
        </div>
    );
};

export const NetworkDisplay = ({ asset }: { asset: TreasuryAsset }) => {
    const { theme } = useThemeStore();

    let type;
    switch (asset.residency) {
        case "Lockup":
            type = "Vested Token";
            break;
        case "Staked":
            type = "Staked";
            break;
        case "Ft":
            type = "Fungible Token";
            break;
        case "Intents":
            type = "Intents Token";
            break;
        case "Near":
            type = "Native Token";
            break;
    }

    const image = asset.chainIcons
        ? theme === "light"
            ? asset.chainIcons.light
            : asset.chainIcons.dark
        : asset.icon;

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
                <span className="text-xs text-muted-foreground">{type}</span>
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
                {balance.toString()} {symbol}
            </div>
        </div>
    );
};

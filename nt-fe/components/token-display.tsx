import { TreasuryAsset } from "@/lib/api";
import { useThemeStore } from "@/stores/theme-store";
import Big from "big.js";

export const NetworkDisplay = ({ asset }: { asset: TreasuryAsset }) => {
    const { theme } = useThemeStore();

    let type;
    switch (asset.residency) {
        case "Lockup":
            type = "Lockup";
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

    const image = asset.chainIcons ?
        theme === "light" ? asset.chainIcons.light
            : asset.chainIcons.dark
        : asset.icon;

    return (
        <div className="flex items-center gap-3">
            <img src={image} alt={`${asset.chainName} network`} className="size-6" />
            <div className="flex flex-col text-left">
                <span className="font-semibold capitalize">{asset.chainName}</span>
                <span className="text-xs text-muted-foreground">
                    {type}
                </span>
            </div>
        </div>
    );
};

export const BalanceCell = ({ balance, symbol, balanceUSD }: { balance: Big; symbol: string; balanceUSD: number }) => {
    return (
        <div className="text-right">
            <div className="font-semibold">
                ${balanceUSD.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">
                {balance.toString()} {symbol}
            </div>
        </div>
    );
};

import { TreasuryAsset } from "@/lib/api";
import Big from "big.js";

export const NetworkDisplay = ({ asset }: { asset: TreasuryAsset }) => {
    let network;
    let type;
    switch (asset.residency) {
        case "Ft":
            network = asset.network;
            type = "Fungible Token";
            break;
        case "Intents":
            network = asset.network;
            type = "Intents Token";
            break;
        case "Near":
            network = asset.network;
            type = "Native Token";
            break;
    }

    return (
        <div className="flex items-center gap-3">
            <img src={asset.icon} alt={asset.symbol} className="size-6 rounded-full" />
            <div className="flex flex-col text-left">
                <span className="font-semibold capitalize">{network}</span>
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

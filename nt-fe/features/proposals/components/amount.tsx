import { TokenDisplay } from "@/components/token-display-with-network";
import { useToken } from "@/hooks/use-treasury-queries";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import { useMemo } from "react";

interface AmountProps {
    amount?: string;
    amountWithDecimals?: string;
    tokenId: string;
    showUSDValue?: boolean;
    showNetwork?: boolean;
    network?: string; // Optional override for network display
    textOnly?: boolean;
    iconSize?: "sm" | "md" | "lg";
}


export function Amount({ amount, amountWithDecimals, textOnly = false, tokenId, showUSDValue = true, showNetwork = false, network, iconSize = "lg" }: AmountProps) {
    const { data: tokenData } = useToken(tokenId);
    const amountValue = amount ? formatBalance(amount, tokenData?.decimals || 24) : Number(amountWithDecimals).toFixed(6);
    const estimatedUSDValue = useMemo(() => {
        const isPriceAvailable = tokenData?.price;
        if (!isPriceAvailable || !amountValue || isNaN(Number(amountValue))) {
            return "N/A";
        }

        const price = tokenData?.price;
        return `≈ ${formatCurrency(Number(amountValue) * price!)}`;
    }, [tokenData, amountValue]);
    if (textOnly) {
        return (
            <p className="text-sm font-semibold">
                {amountValue} {tokenData?.symbol}
                {showUSDValue && (
                    <span className="text-muted-foreground text-xs">({estimatedUSDValue})</span>
                )}
            </p>);
    }
    return (
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
                    <span className="font-medium">{amountValue} {tokenData?.symbol}</span>
                )}
                {showUSDValue && <span className="text-muted-foreground text-xs">({estimatedUSDValue})</span>}
            </div>
            {showNetwork && (network || tokenData?.network) && (
                <span className="text-muted-foreground text-xs">
                    Network: {(network || tokenData?.network)?.toUpperCase()}
                </span>
            )}
        </div>
    );
}
``
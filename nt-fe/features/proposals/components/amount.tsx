import { useToken } from "@/hooks/use-treasury-queries";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import { useMemo } from "react";

interface AmountProps {
    amount?: string;
    amountWithDecimals?: string;
    tokenId: string;
    network?: string;
    showUSDValue?: boolean;
    showNetwork?: boolean;
    textOnly?: boolean;
    iconSize?: "sm" | "md" | "lg";
}

const iconSizeClasses = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
}

export function Amount({ amount, amountWithDecimals, textOnly = false, tokenId, network = "near", showUSDValue = true, showNetwork = false, iconSize = "lg" }: AmountProps) {
    const { data: tokenData } = useToken(tokenId, network);
    const amountValue = amount ? formatBalance(amount, tokenData?.decimals || 24) : Number(amountWithDecimals).toFixed(6);
    const estimatedUSDValue = useMemo(() => {
        const isPriceAvailable = tokenData?.price;
        if (!isPriceAvailable || !amountValue || isNaN(Number(amountValue))) {
            return "N/A";
        }

        const price = tokenData?.price;
        return `≈ ${formatCurrency(Number(amountValue) * price!)}`;
    }, [tokenData, amountValue]);
    const iconClass = iconSizeClasses[iconSize];
    if (textOnly) {
        return (
            <p className="text-sm font-medium">
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
                    <img src={tokenData?.icon} className={cn("rounded-full shrink-0", iconClass)} alt={tokenData?.name} />
                )}
                {tokenData && (
                    <span className="font-medium">{amountValue} {tokenData?.symbol}</span>
                )}
                {showUSDValue && <span className="text-muted-foreground text-xs">({estimatedUSDValue})</span>}
            </div>
            {showNetwork && tokenData?.chain_name && (
                <span className="text-muted-foreground text-xs">
                    Network: {tokenData.chain_name.toUpperCase()}
                </span>
            )}
        </div>
    );
}

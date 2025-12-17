import { useToken, useTokenPrice } from "@/hooks/use-treasury-queries";
import { formatBalance } from "@/lib/utils";
import { useMemo } from "react";

export function Amount({ amount, tokenId }: { amount: string, tokenId: string }) {
    const { data: tokenData } = useToken(tokenId, "NEAR");
    const { data: tokenPriceData } = useTokenPrice(tokenId, "NEAR");
    const amountValue = formatBalance(amount, tokenData?.decimals || 24);

    const estimatedUSDValue = useMemo(() => {
        if (!tokenPriceData?.price || !amountValue || isNaN(Number(amountValue))) {
            return 0;
        }
        return Number(amountValue) * tokenPriceData.price;
    }, [tokenPriceData?.price, amount]);
    return (
        <div className="flex items-center gap-2">
            {tokenData && (
                <img src={tokenData?.icon} alt={tokenData?.name} width={20} height={20} />
            )}
            {tokenData && (
                <span>{amountValue} </span>
            )}
            <span className="text-muted-foreground text-xs">(${estimatedUSDValue.toFixed(2)})</span>
        </div>
    );
}

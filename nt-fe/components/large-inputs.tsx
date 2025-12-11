"use client";

import { Dispatch, SetStateAction, useMemo } from "react";
import { Input } from "./ui/input";
import { useTokenBalance, useTokenPrice } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { formatBalance } from "@/lib/utils";

interface TokenInputProps {
    amount: number;
    token: string;
    setAmount: Dispatch<SetStateAction<number>>;
    setToken: Dispatch<SetStateAction<string>>;
}

export function TokenInput({ amount, token, setAmount, setToken }: TokenInputProps) {
    const { selectedTreasury } = useTreasury();
    const { data: tokenPriceData, isLoading: isPriceLoading } = useTokenPrice(token);
    const { data: tokenBalanceData, isLoading: isBalanceLoading } = useTokenBalance(selectedTreasury, token);
    const estimatedUSDValue = useMemo(() => {
        if (!tokenPriceData?.price || !amount || isNaN(amount) || amount <= 0) {
            return null;
        }
        return amount * tokenPriceData.price;
    }, [amount, tokenPriceData?.price]);

    return (
        <div className="p-4 rounded-xl text-muted-foreground bg-muted">
            <div className="flex justify-between items-center mb-1">
                <p className="text-sm">
                    Send
                </p>
            </div>
            <div className="flex justify-between items-start gap-3">
                <div className="flex-1">
                    <Input
                        type="number"
                        value={amount || ''}
                        onChange={(e) => setAmount(Number(e.target.value))}
                        placeholder="0.00"
                        className="text-4xl font-mono bg-transparent border-none outline-none ring-0 focus-visible:ring-0 p-0 h-auto dark:text-white"
                    />
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 h-5">
                        {!isPriceLoading && estimatedUSDValue !== null && estimatedUSDValue > 0
                            ? `≈ $${estimatedUSDValue.toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2
                            })}`
                            : isPriceLoading
                                ? 'Loading price...'
                                : ''}
                    </p>
                </div>
                <div className="flex items-center space-x-2 bg-white dark:bg-slate-900 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-700">
                    <span className="font-semibold text-lg dark:text-white">
                        {!isBalanceLoading && tokenBalanceData?.balance ? formatBalance(tokenBalanceData?.balance, tokenBalanceData?.decimals) : 'Loading balance...'} {token.toUpperCase()}

                    </span>
                </div>
            </div>
        </div>
    );
}

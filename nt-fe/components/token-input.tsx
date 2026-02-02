"use client";

import { useMemo } from "react";
import { Button } from "./button";
import { useToken } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import TokenSelect, { SelectedTokenData } from "./token-select";
import { LargeInput } from "./large-input";
import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import { Control, FieldValues, Path, PathValue, useFormContext, useWatch } from "react-hook-form";
import z from "zod";
import Big from "big.js";
import { availableBalance } from "@/lib/balance";

export const tokenSchema = z.object({
    address: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    name: z.string(),
    icon: z.string(),
    network: z.string(),
    chainIcons: z.any().optional(),
    residency: z.string().optional(),
    balance: z.any().optional(),
    balanceUSD: z.number().optional(),
});

export type Token = z.infer<typeof tokenSchema>;

interface TokenInputProps<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>
> {
    control: Control<TFieldValues>;
    title?: string;
    amountName: Path<TFieldValues>;
    tokenName: TTokenPath extends Path<TFieldValues>
    ? PathValue<TFieldValues, TTokenPath> extends Token
    ? TTokenPath
    : never
    : never;
    tokenSelect?: {
        disabled?: boolean;
        locked?: boolean;
        /**
         * When true, only shows tokens that the user owns (has balance > 0).
         * When false, shows all tokens with separation.
         * Default: false (show all assets)
         */
        showOnlyOwnedAssets?: boolean;
    };
    readOnly?: boolean;
    loading?: boolean;
    customValue?: string;
    infoMessage?: string;
    /**
     * When true, shows "Insufficient balance" error if amount exceeds balance.
     * Default: false
     */
    showInsufficientBalance?: boolean;
}

export function TokenInput<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>
>({ control, title, amountName, tokenName, tokenSelect, readOnly = false, loading = false, customValue, infoMessage, showInsufficientBalance = false }: TokenInputProps<TFieldValues, TTokenPath>) {
    const { treasuryId } = useTreasury();
    const { setValue } = useFormContext<TFieldValues>();
    const amount = useWatch({ control, name: amountName });
    const token = useWatch({ control, name: tokenName }) as Token;

    // Get token price for USD estimation
    const { data: tokenData, isLoading: isTokenLoading } = useToken(token?.address || "");

    // Get balance from selected token
    const tokenBalance = useMemo(() => {
        if (!token?.balance) return null;
        try {
            return availableBalance(token.balance);
        } catch {
            return null;
        }
    }, [token?.balance]);

    // Check if user has insufficient balance
    const hasInsufficientBalance = useMemo(() => {
        if (!showInsufficientBalance) return false;
        if (!tokenBalance || !amount || isNaN(amount) || amount <= 0) {
            return false;
        }
        
        const decimals = token?.decimals || 24;
        const amountInSmallestUnits = Big(amount).times(Big(10).pow(decimals));
        
        return amountInSmallestUnits.gt(tokenBalance);
    }, [showInsufficientBalance, tokenBalance, amount, token?.decimals]);

    const estimatedUSDValue = useMemo(() => {
        if (!tokenData?.price || !amount || isNaN(amount) || amount <= 0) {
            return null;
        }
        return amount * tokenData.price;
    }, [amount, tokenData?.price]);

    return (
        <FormField
            control={control}
            name={amountName}
            render={({ field, fieldState }) => (
                <InputBlock title={title} invalid={!!fieldState.error} topRightContent={
                    <div className="flex items-center gap-2">
                        {tokenBalance && token?.decimals && (
                            <>
                                <p className="text-xs text-muted-foreground">
                                    Balance: {formatBalance(tokenBalance.toFixed(0), token.decimals)} {token.symbol.toUpperCase()}
                                </p>
                                {!readOnly && (
                                    <Button type="button" variant="secondary" className="bg-muted-foreground/10 hover:bg-muted-foreground/20" size="sm" onClick={() => {
                                        if (tokenBalance && token.decimals) {
                                            setValue(amountName, formatBalance(tokenBalance.toFixed(0), token.decimals) as PathValue<TFieldValues, Path<TFieldValues>>);
                                        }
                                    }}>MAX</Button>
                                )}
                            </>
                        )}
                    </div>
                } >

                    <>
                        <div className="flex justify-between items-center">
                            <div className="flex-1">
                                <LargeInput 
                                    type={readOnly ? "text" : "number"}
                                    borderless 
                                    onChange={readOnly ? undefined : (e) => field.onChange(e.target.value.replace(/^0+(?=\d)/, ""))} 
                                    onBlur={readOnly ? undefined : field.onBlur} 
                                    value={loading ? "..." : (customValue !== undefined ? customValue : field.value)} 
                                    placeholder="0" 
                                    className={cn("text-3xl!", readOnly && "text-muted-foreground")}
                                    readOnly={readOnly}
                                />
                            </div>
                            <FormField
                                control={control}
                                name={tokenName}
                                render={({ field }) => (
                                    <TokenSelect
                                        disabled={tokenSelect?.disabled}
                                        locked={tokenSelect?.locked}
                                        selectedToken={token}
                                        setSelectedToken={(selectedToken: SelectedTokenData) => {
                                            field.onChange(selectedToken);
                                        }}
                                        showOnlyOwnedAssets={tokenSelect?.showOnlyOwnedAssets ?? false}
                                    />
                                )}
                            />
                        </div>
                        <p className={cn("text-muted-foreground text-xs invisible", estimatedUSDValue !== null && estimatedUSDValue > 0 && "visible")}>
                            {!isTokenLoading && estimatedUSDValue !== null && estimatedUSDValue > 0
                                ? `≈ ${formatCurrency(estimatedUSDValue)}`
                                : isTokenLoading
                                    ? 'Loading price...'
                                    : 'Invisible'}
                        </p>
                        {hasInsufficientBalance && (
                            <p className="text-general-info-foreground text-sm mt-2">
                                Insufficient tokens. You can submit the request and top up before approval.
                            </p>
                        )}
                        {fieldState.error ? (
                            <FormMessage />
                        ) : infoMessage ? (
                            <p className="text-general-info-foreground text-sm mt-2">{infoMessage}</p>
                        ) : !hasInsufficientBalance ? (
                            <p className="text-muted-foreground text-xs invisible">Invisible</p>
                        ) : null}
                    </>
                </InputBlock>
            )}
        />
    );
}


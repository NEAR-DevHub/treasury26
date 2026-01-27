"use client";

import { useMemo } from "react";
import { Button } from "./button";
import { useToken, useTokenBalance } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import TokenSelect from "./token-select";
import { LargeInput } from "./large-input";
import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import { Control, FieldValues, Path, PathValue, useFormContext, useWatch } from "react-hook-form";
import z from "zod";

export const tokenSchema = z.object({
    symbol: z.string(),
    address: z.string(),
    network: z.string(),
    icon: z.string(),
    decimals: z.number(),
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
    };
    readOnly?: boolean;
    loading?: boolean;
    customValue?: string;
}

export function TokenInput<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>
>({ control, title, amountName, tokenName, tokenSelect, readOnly = false, loading = false, customValue }: TokenInputProps<TFieldValues, TTokenPath>) {
    const { selectedTreasury } = useTreasury();
    const { setValue } = useFormContext<TFieldValues>();
    const amount = useWatch({ control, name: amountName });
    const token = useWatch({ control, name: tokenName }) as Token;

    const { data: tokenBalanceData, isLoading: isBalanceLoading } = useTokenBalance(treasuryId, token.address, token.network);
    const { data: tokenData, isLoading: isTokenLoading } = useToken(token.address);

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
                        {tokenBalanceData?.balance && !isBalanceLoading && (
                            <>
                                <p className="text-xs text-muted-foreground">
                                    Balance: {formatBalance(tokenBalanceData.balance, tokenBalanceData.decimals)} {token.symbol.toUpperCase()}
                                </p>
                                {!readOnly && (
                                    <Button type="button" variant="secondary" className="bg-muted-foreground/10 hover:bg-muted-foreground/20" size="sm" onClick={() => {
                                        setValue(amountName, formatBalance(tokenBalanceData.balance, tokenBalanceData.decimals) as PathValue<TFieldValues, Path<TFieldValues>>);
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
                                name={`${tokenName}.symbol` as Path<TFieldValues>}
                                render={({ field }) => (
                                    <TokenSelect
                                        disabled={tokenSelect?.disabled}
                                        locked={tokenSelect?.locked}
                                        lockedTokenData={tokenSelect?.locked ? {
                                            symbol: token.symbol,
                                            icon: token.icon,
                                            network: token.network,
                                            chainIcons: tokenData?.chainIcons
                                        } : undefined}
                                        selectedToken={field.value}
                                        setSelectedToken={(selectedToken) => {
                                            field.onChange(selectedToken.symbol);
                                            setValue(`${tokenName}.address` as Path<TFieldValues>, selectedToken.id as PathValue<TFieldValues, Path<TFieldValues>>);
                                            setValue(`${tokenName}.network` as Path<TFieldValues>, selectedToken.network as PathValue<TFieldValues, Path<TFieldValues>>);
                                            setValue(`${tokenName}.icon` as Path<TFieldValues>, selectedToken.icon as PathValue<TFieldValues, Path<TFieldValues>>);
                                            setValue(`${tokenName}.decimals` as Path<TFieldValues>, selectedToken.decimals as PathValue<TFieldValues, Path<TFieldValues>>);
                                        }}
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
                        {fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Invisible</p>}
                    </>
                </InputBlock>
            )}
        />
    );
}


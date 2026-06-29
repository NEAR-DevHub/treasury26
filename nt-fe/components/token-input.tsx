"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { useTreasury } from "@/hooks/use-treasury";
import { useAssets } from "@/hooks/use-assets";
import { availableBalance } from "@/lib/balance";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import TokenSelect, { SelectedTokenData } from "./token-select";
import { WarningMessage } from "./warning-message";
import { LargeInput } from "./large-input";
import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import {
    Control,
    FieldValues,
    Path,
    PathValue,
    useFormContext,
    useWatch,
} from "react-hook-form";
import z from "zod";
import Big from "@/lib/big";
import { getPaymentBalanceWarning } from "@/lib/intents-fee";

export const tokenSchema = z.object({
    address: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    name: z.string(),
    icon: z.string(),
    network: z.string(),
    chainIcons: z.any().optional(),
    residency: z.string().optional(),
    minWithdrawalAmount: z.string().optional(),
    minDepositAmount: z.string().optional(),
    balance: z.string().optional(),
    price: z.number().optional(),
});

export type Token = z.infer<typeof tokenSchema>;

interface TokenInputProps<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>,
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
        showPopularAssets?: boolean;
        /**
         * When true, only shows tokens that the user owns (has balance > 0).
         * When false, shows all tokens with separation.
         * Default: false (show all assets)
         */
        showOnlyOwnedAssets?: boolean;
        /**
         * Optional filter function to exclude specific tokens from the list.
         * Return true to include the token, false to exclude it.
         */
        filterTokens?: (token: {
            address: string;
            symbol: string;
            network: string;
            residency?: string;
        }) => boolean;
    };
    readOnly?: boolean;
    loading?: boolean;
    customValue?: string;
    infoMessage?: string;
    /** Token/slot warning (`### heading` + body). Renders heading inline, body in tooltip. */
    warningMessage?: string | null;
    /**
     * When true, shows "Insufficient balance" error if amount exceeds balance.
     * Default: false
     */
    showInsufficientBalance?: boolean;
    /** Network fee in token units; treasury must cover amount + fee. */
    networkFee?: string | null;
    /**
     * When true, font size will dynamically adjust based on input length to prevent overflow.
     * Default: false
     */
    dynamicFontSize?: boolean;
    onAmountInput?: () => void;
    onMaxSet?: (maxAmount: string) => void;
    usdValueOverride?: number | null;
}

export function TokenInput<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>,
>({
    control,
    title,
    amountName,
    tokenName,
    tokenSelect,
    readOnly = false,
    loading = false,
    customValue,
    infoMessage,
    warningMessage,
    showInsufficientBalance = false,
    networkFee = null,
    dynamicFontSize = false,
    onAmountInput,
    onMaxSet,
    usdValueOverride,
}: TokenInputProps<TFieldValues, TTokenPath>) {
    const t = useTranslations("tokenInput");
    const { treasuryId } = useTreasury();
    const { setValue } = useFormContext<TFieldValues>();
    const amount = useWatch({ control, name: amountName });
    const token = useWatch({ control, name: tokenName }) as Token;

    // Use balance & price from useAssets (passed through token-select)
    const { data: assetsData } = useAssets(treasuryId, {
        enabled: true,
        onlySupportedTokens: true,
    });

    // Find the matching asset from useAssets to get fresh balance/price
    const matchedAsset = useMemo(() => {
        if (!assetsData?.tokens || !token?.address) return null;
        return assetsData.tokens.find(
            (t) =>
                (t.contractId ?? t.id) === token.address &&
                t.network === token.network,
        );
    }, [assetsData?.tokens, token?.address, token?.network]);

    // Treat missing balance as zero so unsupported/unowned selections show the
    // same insufficient-assets feedback as low-balance selections.
    const tokenBalance = matchedAsset
        ? availableBalance(matchedAsset.balance).toFixed(0)
        : (token?.balance ?? "0");
    const tokenPrice = matchedAsset?.price ?? token?.price;
    const tokenDecimals = matchedAsset?.decimals ?? token?.decimals;

    const balanceWarning = useMemo(() => {
        if (!showInsufficientBalance) return null;
        if (!tokenBalance || !amount || isNaN(amount) || amount <= 0) {
            return null;
        }

        const decimals = tokenDecimals || 24;
        const balance = Big(tokenBalance).div(Big(10).pow(decimals));
        let fee: Big | undefined;
        if (networkFee) {
            try {
                fee = Big(networkFee);
            } catch {
                fee = undefined;
            }
        }

        return getPaymentBalanceWarning({
            amount: String(amount),
            balance,
            networkFee: fee,
            decimals,
            symbol: token.symbol,
        });
    }, [
        showInsufficientBalance,
        tokenBalance,
        amount,
        tokenDecimals,
        networkFee,
        token.symbol,
    ]);

    const estimatedUSDValue = useMemo(() => {
        if (usdValueOverride !== undefined && usdValueOverride !== null) {
            return usdValueOverride;
        }
        if (!tokenPrice || !amount || isNaN(amount) || amount <= 0) {
            return null;
        }
        return amount * tokenPrice;
    }, [amount, tokenPrice, usdValueOverride]);

    return (
        <FormField
            control={control}
            name={amountName}
            render={({ field, fieldState }) => (
                <InputBlock
                    interactive={!readOnly}
                    title={title}
                    invalid={!!fieldState.error}
                    topRightContent={
                        <div className="flex items-center gap-2">
                            {tokenBalance && tokenDecimals && (
                                <>
                                    <p className="text-xs text-muted-foreground">
                                        {t("balance", {
                                            amount: formatBalance(
                                                tokenBalance,
                                                tokenDecimals,
                                            ),
                                            symbol: token.symbol.toUpperCase(),
                                        })}
                                    </p>
                                    {!readOnly && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="bg-muted-foreground/10 hover:bg-muted-foreground/20"
                                            size="sm"
                                            onClick={() => {
                                                if (
                                                    tokenBalance &&
                                                    tokenDecimals
                                                ) {
                                                    const maxAmount = Big(
                                                        tokenBalance,
                                                    )
                                                        .div(
                                                            Big(10).pow(
                                                                tokenDecimals,
                                                            ),
                                                        )
                                                        .toFixed(tokenDecimals);
                                                    setValue(
                                                        amountName,
                                                        maxAmount as PathValue<
                                                            TFieldValues,
                                                            Path<TFieldValues>
                                                        >,
                                                    );
                                                    onMaxSet?.(maxAmount);
                                                }
                                            }}
                                        >
                                            {t("max")}
                                        </Button>
                                    )}
                                </>
                            )}
                        </div>
                    }
                >
                    <>
                        <div className="flex justify-between items-center">
                            <div className="flex-1 min-w-0">
                                <LargeInput
                                    type={readOnly ? "text" : "number"}
                                    borderless
                                    dynamicFontSize={dynamicFontSize}
                                    onChange={
                                        readOnly
                                            ? undefined
                                            : (e) => {
                                                  onAmountInput?.();
                                                  field.onChange(
                                                      e.target.value.replace(
                                                          /^0+(?=\d)/,
                                                          "",
                                                      ),
                                                  );
                                              }
                                    }
                                    onBlur={readOnly ? undefined : field.onBlur}
                                    value={
                                        loading
                                            ? "..."
                                            : customValue !== undefined
                                              ? customValue
                                              : field.value.toString()
                                    }
                                    placeholder="0"
                                    className={cn(
                                        readOnly && "text-muted-foreground",
                                    )}
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
                                        showPopularAssets={
                                            tokenSelect?.showPopularAssets ??
                                            false
                                        }
                                        selectedToken={token}
                                        setSelectedToken={(
                                            selectedToken: SelectedTokenData,
                                        ) => {
                                            field.onChange(selectedToken);
                                        }}
                                        showOnlyOwnedAssets={
                                            tokenSelect?.showOnlyOwnedAssets ??
                                            false
                                        }
                                        filterTokens={tokenSelect?.filterTokens}
                                    />
                                )}
                            />
                        </div>
                        {estimatedUSDValue !== null &&
                            estimatedUSDValue > 0 && (
                                <p className="text-muted-foreground text-xs truncate">
                                    {`≈ ${formatCurrency(estimatedUSDValue)}`}
                                </p>
                            )}
                        {balanceWarning && (
                            <p className="text-general-info-foreground text-sm mt-2">
                                {balanceWarning.type === "fee_not_covered"
                                    ? t("insufficientTokensForFee", {
                                          fee:
                                              balanceWarning.formattedFee ?? "",
                                          symbol: balanceWarning.symbol ?? "",
                                      })
                                    : t("insufficientTokens")}
                            </p>
                        )}
                        {fieldState.error ? (
                            <FormMessage />
                        ) : warningMessage ? (
                            <WarningMessage
                                variant="inline"
                                message={warningMessage}
                                className="text-sm mt-2"
                            />
                        ) : infoMessage ? (
                            <p className="text-general-info-foreground text-sm mt-2">
                                {infoMessage}
                            </p>
                        ) : !balanceWarning ? (
                            <p className="text-muted-foreground text-xs invisible">
                                Invisible
                            </p>
                        ) : null}
                    </>
                </InputBlock>
            )}
        />
    );
}

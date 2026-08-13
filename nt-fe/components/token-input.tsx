"use client";

import { useTranslations } from "next-intl";
import {
    type ChangeEvent,
    type ClipboardEvent,
    type KeyboardEvent,
    useMemo,
} from "react";
import {
    type Control,
    type FieldValues,
    type Path,
    type PathValue,
    useFormContext,
    useWatch,
} from "react-hook-form";
import z from "zod";
import { useAmountFormat } from "@/hooks/use-amount-format";
import { DEFAULT_ASSETS_QUERY, useAssets } from "@/hooks/use-assets";
import { useTreasury } from "@/hooks/use-treasury";
import {
    decimalFromBaseUnits,
    decimalFromBaseUnitsOrNull,
    decimalOrNull,
} from "@/lib/amount-format";
import { availableBalance } from "@/lib/balance";
import Big from "@/lib/big";
import { getPaymentBalanceWarning } from "@/lib/intents-fee";
import { findMatchingTreasuryAsset } from "@/lib/match-treasury-asset";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { FormattedAmount } from "./formatted-amount";
import { InputBlock } from "./input-block";
import { LargeInput } from "./large-input";
import TokenSelect, { type SelectedTokenData } from "./token-select";
import { FormField } from "./ui/form";
import { WarningMessage } from "./warning-message";

function sanitizeAmountInput(value: string): string {
    return value.replace(/[^0-9.]/g, "").replace(/^0+(?=\d)/, "");
}

function isEntireInputSelected(el: HTMLInputElement): boolean {
    return (
        el.value.length > 0 &&
        el.selectionStart === 0 &&
        el.selectionEnd === el.value.length
    );
}

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
        ? NonNullable<PathValue<TFieldValues, TTokenPath>> extends Token
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
        /**
         * When false, skips the shared default-token auto-select
         * (highest-USD owned → USDC on NEAR). Exchange sets this false.
         */
        autoSelect?: boolean;
    };
    readOnly?: boolean;
    loading?: boolean;
    customValue?: string;
    infoMessage?: string;
    /** External error message (e.g. quote failure). Takes priority over field validation. */
    errorMessage?: string | null;
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
    /** Fires after the user picks a different token. */
    onTokenChange?: (token: Token) => void;
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
    errorMessage,
    warningMessage,
    showInsufficientBalance = false,
    networkFee = null,
    dynamicFontSize = false,
    onAmountInput,
    onMaxSet,
    onTokenChange,
    usdValueOverride,
}: TokenInputProps<TFieldValues, TTokenPath>) {
    const t = useTranslations("tokenInput");
    const amountFormat = useAmountFormat();
    const { treasuryId } = useTreasury();
    const { setValue } = useFormContext<TFieldValues>();
    const amount = useWatch({ control, name: amountName });
    // Null while payments waits for assets to seed a default token.
    const token = useWatch({ control, name: tokenName }) as Token | null;

    // Shared DEFAULT_ASSETS_QUERY so we hit the same cache as useMergedTokens.
    const { data: assetsData, isPending: isAssetsPending } = useAssets(
        treasuryId,
        DEFAULT_ASSETS_QUERY,
    );

    const matchedAsset = useMemo(
        () => findMatchingTreasuryAsset(assetsData?.tokens, token),
        [assetsData?.tokens, token],
    );

    // Prefer live assets balance; fall back to the form token's balance.
    // Never invent "0" while assets are still loading (avoids Balance: 0 flash).
    const tokenBalance = matchedAsset
        ? availableBalance(matchedAsset.balance).toFixed(0)
        : (token?.balance ?? (isAssetsPending ? null : "0"));
    const tokenPrice = matchedAsset?.price ?? token?.price;
    const tokenDecimals = matchedAsset?.decimals ?? token?.decimals;

    const balanceWarning = useMemo(() => {
        if (!showInsufficientBalance || !token || tokenBalance == null) {
            return null;
        }
        const parsedAmount = decimalOrNull(amount);
        if (!parsedAmount?.gt(0)) return null;

        const decimals = tokenDecimals || 24;
        const balance = decimalFromBaseUnitsOrNull(tokenBalance, decimals);
        if (!balance) return null;
        const fee = decimalOrNull(networkFee) ?? undefined;

        return getPaymentBalanceWarning({
            amount: parsedAmount.toFixed(),
            balance,
            networkFee: fee,
            decimals,
            symbol: token.symbol,
            locale: amountFormat.locale,
        });
    }, [
        showInsufficientBalance,
        token,
        tokenBalance,
        amount,
        tokenDecimals,
        networkFee,
        amountFormat.locale,
    ]);

    const estimatedUSDValue = useMemo(() => {
        if (usdValueOverride !== undefined && usdValueOverride !== null) {
            return decimalOrNull(usdValueOverride);
        }
        const price = decimalOrNull(tokenPrice);
        const parsedAmount = decimalOrNull(amount);
        return price?.gt(0) && parsedAmount?.gt(0)
            ? parsedAmount.mul(price)
            : null;
    }, [amount, tokenPrice, usdValueOverride]);

    return (
        <FormField
            control={control}
            name={amountName}
            render={({ field, fieldState }) => {
                const displayError =
                    errorMessage || fieldState.error?.message || null;

                const handleMaxClick = () => {
                    if (!tokenBalance || !tokenDecimals) return;
                    const maxAmount = decimalFromBaseUnits(
                        tokenBalance,
                        tokenDecimals,
                    ).toFixed();
                    setValue(
                        amountName,
                        maxAmount as PathValue<
                            TFieldValues,
                            Path<TFieldValues>
                        >,
                    );
                    onMaxSet?.(maxAmount);
                };

                // Replace at keydown so React/RHF re-renders can't turn
                // select-all into append.
                const handleAmountKeyDown = (
                    e: KeyboardEvent<HTMLInputElement>,
                ) => {
                    if (
                        e.ctrlKey ||
                        e.metaKey ||
                        e.altKey ||
                        e.key.length !== 1
                    ) {
                        return;
                    }
                    if (!isEntireInputSelected(e.currentTarget)) return;

                    const nextValue = e.key.replace(/[^0-9.]/g, "");
                    if (nextValue === "" && e.key !== ".") return;

                    e.preventDefault();
                    onAmountInput?.();
                    field.onChange(nextValue || ".");
                };

                const handleAmountPaste = (
                    e: ClipboardEvent<HTMLInputElement>,
                ) => {
                    if (!isEntireInputSelected(e.currentTarget)) return;

                    e.preventDefault();
                    onAmountInput?.();
                    field.onChange(
                        sanitizeAmountInput(e.clipboardData.getData("text")),
                    );
                };

                const handleAmountChange = (
                    e: ChangeEvent<HTMLInputElement>,
                ) => {
                    onAmountInput?.();
                    field.onChange(sanitizeAmountInput(e.target.value));
                };

                const inputValue = loading
                    ? "..."
                    : customValue !== undefined
                      ? customValue
                      : field.value.toString();

                return (
                    <InputBlock
                        interactive={!readOnly}
                        title={title}
                        invalid={!!displayError}
                        topRightContent={
                            <div className="flex items-center gap-2">
                                {token &&
                                    tokenBalance != null &&
                                    tokenDecimals != null && (
                                        <>
                                            <p className="text-xs text-muted-foreground">
                                                {t("balance", {
                                                    amount: amountFormat.rawToken(
                                                        tokenBalance,
                                                        tokenDecimals,
                                                        {
                                                            profile: "compact",
                                                            unitPriceUsd:
                                                                tokenPrice,
                                                            rounding: "down",
                                                        },
                                                    ).display,
                                                    symbol: token.symbol.toUpperCase(),
                                                })}
                                            </p>
                                            {!readOnly && (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    className="bg-muted-foreground/10 hover:bg-muted-foreground/20"
                                                    size="sm"
                                                    onClick={handleMaxClick}
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
                                        // text + inputMode: type="number" breaks select-all + replace.
                                        type="text"
                                        inputMode="decimal"
                                        borderless
                                        dynamicFontSize={dynamicFontSize}
                                        onKeyDown={
                                            readOnly
                                                ? undefined
                                                : handleAmountKeyDown
                                        }
                                        onPaste={
                                            readOnly
                                                ? undefined
                                                : handleAmountPaste
                                        }
                                        onChange={
                                            readOnly
                                                ? undefined
                                                : handleAmountChange
                                        }
                                        onBlur={
                                            readOnly ? undefined : field.onBlur
                                        }
                                        value={inputValue}
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
                                    render={({ field: tokenField }) => {
                                        const handleTokenSelect = (
                                            selectedToken: SelectedTokenData,
                                        ) => {
                                            tokenField.onChange(selectedToken);
                                            onTokenChange?.(
                                                selectedToken as Token,
                                            );
                                        };

                                        return (
                                            <TokenSelect
                                                disabled={tokenSelect?.disabled}
                                                locked={tokenSelect?.locked}
                                                showPopularAssets={
                                                    tokenSelect?.showPopularAssets ??
                                                    false
                                                }
                                                selectedToken={token}
                                                setSelectedToken={
                                                    handleTokenSelect
                                                }
                                                showOnlyOwnedAssets={
                                                    tokenSelect?.showOnlyOwnedAssets ??
                                                    false
                                                }
                                                filterTokens={
                                                    tokenSelect?.filterTokens
                                                }
                                                autoSelect={
                                                    tokenSelect?.autoSelect
                                                }
                                            />
                                        );
                                    }}
                                />
                            </div>
                            {estimatedUSDValue?.gt(0) && (
                                <p className="text-muted-foreground text-xs truncate">
                                    ≈{" "}
                                    <FormattedAmount
                                        kind="fiat"
                                        value={estimatedUSDValue}
                                    />
                                </p>
                            )}
                            {displayError ? (
                                <p className="text-destructive text-sm mt-2">
                                    {String(displayError)}
                                </p>
                            ) : balanceWarning ? (
                                <p className="text-general-info-foreground text-sm mt-2">
                                    {balanceWarning.type === "fee_not_covered"
                                        ? t("insufficientTokensForFee", {
                                              fee:
                                                  balanceWarning.formattedFee ??
                                                  "",
                                              symbol:
                                                  balanceWarning.symbol ?? "",
                                          })
                                        : t("insufficientTokens")}
                                </p>
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
                            ) : (
                                <p className="text-muted-foreground text-xs invisible">
                                    Invisible
                                </p>
                            )}
                        </>
                    </InputBlock>
                );
            }}
        />
    );
}

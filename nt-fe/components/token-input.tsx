"use client";

import { ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import {
    type ChangeEvent,
    type ClipboardEvent,
    type KeyboardEvent,
    type MouseEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
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
import {
    parseUsdOverride,
    tokenToUsdDraft,
    usdToTokenAmount,
} from "@/lib/amount-usd";
import { availableBalance } from "@/lib/balance";
import { getPaymentBalanceWarning } from "@/lib/intents-fee";
import { findMatchingTreasuryAsset } from "@/lib/match-treasury-asset";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { FormattedAmount } from "./formatted-amount";
import { Icon } from "./icon";
import { InputBlock } from "./input-block";
import { LargeInput } from "./large-input";
import { TokenDisplay } from "./token-display-with-network";
import TokenSelect, { type SelectedTokenData } from "./token-select";
import { FormField } from "./ui/form";
import { WarningMessage } from "./warning-message";

function sanitizeAmountInput(value: string): string {
    return value.replace(/[^0-9.]/g, "").replace(/^0+(?=\d)/, "");
}

function focusCardAmountInput(
    event: MouseEvent<HTMLElement>,
    disabled?: boolean,
) {
    if (disabled) return;
    event.currentTarget.querySelector<HTMLInputElement>("input")?.focus();
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
    /** Intents ledger id when it differs from `address` display id */
    balanceAssetId: z.string().optional(),
    /** 1Click routing id (may be `1cs_v1:`) for quotes */
    quoteAssetId: z.string().optional(),
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
    /**
     * Take balance / price / decimals from the form token only, ignoring the
     * treasury assets query (e.g. public balances of a confidential treasury,
     * which must not be matched against confidential assets).
     */
    balanceFromToken?: boolean;
    /** Override raw balance (smallest units) for Balance / Use max / warnings. */
    balanceOverrideRaw?: string | null;
    /**
     * Enable USD ↔ token amount toggle. In USD mode the user types USD; we
     * convert to tokens via `tokenPrice` and store the token amount on the form.
     * Pass quote `amountUsd` as `usdValueOverride` to confirm the USD display
     * against the live route quote.
     */
    enableUsdToggle?: boolean;
    /**
     * `default`: amount + token picker side-by-side.
     * `amountCard`: centered amount card (token selected elsewhere); balance + Use max footer.
     * `swapCard`: bordered card with amount + USD toggle on the left, token
     * picker + clickable max balance on the right (Swap).
     */
    variant?: "default" | "amountCard" | "swapCard";
    /** Forwarded to TokenSelect (card trigger / balance layout). */
    tokenSelectExtras?: {
        balanceLayout?: "usdPrimary" | "tokenPrimary";
        hideNetworkSubtitle?: boolean;
        appearance?: "default" | "card";
        triggerLabel?: string;
    };
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
    balanceFromToken = false,
    balanceOverrideRaw = null,
    enableUsdToggle = false,
    variant = "default",
    tokenSelectExtras,
}: TokenInputProps<TFieldValues, TTokenPath>) {
    const isAmountCard = variant === "amountCard";
    const isSwapCard = variant === "swapCard";
    const t = useTranslations("tokenInput");
    const amountFormat = useAmountFormat();
    const { treasuryId } = useTreasury();
    const { setValue } = useFormContext<TFieldValues>();
    const amount = useWatch({ control, name: amountName });
    // Null while payments waits for assets to seed a default token.
    const token = useWatch({ control, name: tokenName }) as Token | null;
    const [inputMode, setInputMode] = useState<"token" | "usd">("token");
    const [usdDraft, setUsdDraft] = useState("");
    /**
     * The token amount this input last derived from `usdDraft`. Anything else
     * arriving on the form came from outside (Use max, a token flip, a fresh
     * quote, a reset), so the draft is stale and has to be recomputed.
     */
    const usdDerivedAmountRef = useRef<string | null>(null);
    const claimUsdDerived = (tokenAmount: string | null) => {
        usdDerivedAmountRef.current = tokenAmount;
    };

    // Shared DEFAULT_ASSETS_QUERY so we hit the same cache as useMergedTokens.
    const { data: assetsData, isPending: isAssetsPending } = useAssets(
        treasuryId,
        DEFAULT_ASSETS_QUERY,
    );

    const matchedAsset = useMemo(
        () =>
            balanceFromToken
                ? null
                : findMatchingTreasuryAsset(assetsData?.tokens, token),
        [assetsData?.tokens, token, balanceFromToken],
    );

    // Prefer live assets balance; fall back to the form token's balance.
    // Never invent "0" while assets are still loading (avoids Balance: 0 flash).
    const tokenBalance =
        balanceOverrideRaw ??
        (matchedAsset
            ? availableBalance(matchedAsset.balance).toFixed(0)
            : (token?.balance ??
              (isAssetsPending && !balanceFromToken ? null : "0")));
    const tokenPrice = matchedAsset?.price ?? token?.price;
    const tokenDecimals =
        balanceOverrideRaw != null
            ? (token?.decimals ?? matchedAsset?.decimals)
            : (matchedAsset?.decimals ?? token?.decimals);

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
        const quoteUsd = parseUsdOverride(usdValueOverride);
        if (quoteUsd != null) return decimalOrNull(quoteUsd);
        const price = decimalOrNull(tokenPrice);
        const parsedAmount = decimalOrNull(amount);
        return price?.gt(0) && parsedAmount?.gt(0)
            ? parsedAmount.mul(price)
            : null;
    }, [amount, tokenPrice, usdValueOverride]);

    // Keep the USD field honest when the token amount is changed for the user.
    useEffect(() => {
        if (!enableUsdToggle || inputMode !== "usd") return;

        const current = amount == null ? "" : String(amount);
        if (current === usdDerivedAmountRef.current) return;
        claimUsdDerived(current);

        // Priced from the amount rather than `usdValueOverride`: a quote always
        // trails the amount, so it still describes the superseded one.
        setUsdDraft(
            current && tokenPrice ? tokenToUsdDraft(current, tokenPrice) : "",
        );
    }, [amount, enableUsdToggle, inputMode, tokenPrice]);

    return (
        <FormField
            control={control}
            name={amountName}
            render={({ field, fieldState }) => {
                const displayError =
                    errorMessage || fieldState.error?.message || null;

                const applyTokenAmount = (tokenAmount: string) => {
                    field.onChange(tokenAmount);
                };

                const applyUsdAmount = (raw: string) => {
                    const sanitized = sanitizeAmountInput(raw);
                    setUsdDraft(sanitized);
                    const tokenAmount =
                        !tokenPrice || !sanitized
                            ? sanitized
                                ? "0"
                                : ""
                            : usdToTokenAmount(
                                  sanitized,
                                  tokenPrice,
                                  tokenDecimals ?? 24,
                              );
                    // Claim the amount so the resync effect leaves the typed
                    // draft alone.
                    claimUsdDerived(tokenAmount);
                    applyTokenAmount(tokenAmount);
                };

                const handleMaxClick = () => {
                    if (tokenBalance == null || tokenBalance === "") return;
                    const decimals = tokenDecimals ?? token?.decimals;
                    if (!decimals) return;
                    let maxAmount: string;
                    try {
                        maxAmount = decimalFromBaseUnits(
                            tokenBalance,
                            decimals,
                        ).toFixed();
                    } catch {
                        return;
                    }
                    if (!maxAmount || maxAmount === "0") return;
                    setValue(
                        amountName,
                        maxAmount as PathValue<
                            TFieldValues,
                            Path<TFieldValues>
                        >,
                        { shouldDirty: true, shouldValidate: true },
                    );
                    field.onChange(maxAmount);
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
                    const next = nextValue || ".";
                    if (enableUsdToggle && inputMode === "usd") {
                        applyUsdAmount(next);
                    } else {
                        field.onChange(next);
                    }
                };

                const handleAmountPaste = (
                    e: ClipboardEvent<HTMLInputElement>,
                ) => {
                    if (!isEntireInputSelected(e.currentTarget)) return;

                    e.preventDefault();
                    onAmountInput?.();
                    const pasted = sanitizeAmountInput(
                        e.clipboardData.getData("text"),
                    );
                    if (enableUsdToggle && inputMode === "usd") {
                        applyUsdAmount(pasted);
                    } else {
                        field.onChange(pasted);
                    }
                };

                const handleAmountChange = (
                    e: ChangeEvent<HTMLInputElement>,
                ) => {
                    onAmountInput?.();
                    if (enableUsdToggle && inputMode === "usd") {
                        applyUsdAmount(e.target.value);
                        return;
                    }
                    field.onChange(sanitizeAmountInput(e.target.value));
                };

                const handleToggleCurrency = () => {
                    if (!enableUsdToggle || !tokenPrice) return;
                    if (inputMode === "token") {
                        // Switching modes leaves the amount alone, so the quote
                        // still prices it — and does so better than the price.
                        const quoteUsd = parseUsdOverride(usdValueOverride);
                        setUsdDraft(
                            quoteUsd != null
                                ? quoteUsd.toFixed(2)
                                : tokenToUsdDraft(amount, tokenPrice),
                        );
                        claimUsdDerived(amount == null ? "" : String(amount));
                        setInputMode("usd");
                    } else {
                        setInputMode("token");
                        setUsdDraft("");
                        claimUsdDerived(null);
                    }
                };

                const displayPrimary =
                    enableUsdToggle && inputMode === "usd"
                        ? usdDraft
                        : loading
                          ? "..."
                          : customValue !== undefined
                            ? customValue
                            : field.value.toString();

                const secondaryTokenAmount =
                    enableUsdToggle &&
                    inputMode === "usd" &&
                    token &&
                    field.value
                        ? `${field.value} ${token.symbol}`
                        : null;

                const primarySuffix =
                    enableUsdToggle && inputMode === "usd"
                        ? "USD"
                        : isAmountCard
                          ? token?.symbol
                          : undefined;

                const secondaryLine = (() => {
                    if (enableUsdToggle && secondaryTokenAmount) {
                        return secondaryTokenAmount;
                    }
                    if (estimatedUSDValue?.gt(0)) {
                        return amountFormat.fiat(estimatedUSDValue).display;
                    }
                    if (enableUsdToggle || isAmountCard || isSwapCard) {
                        return amountFormat.fiat(0).display;
                    }
                    return null;
                })();

                const canToggle = enableUsdToggle && !!tokenPrice && !readOnly;

                const balanceFooter =
                    token && tokenBalance != null && tokenDecimals != null ? (
                        <div
                            className={cn(
                                "flex w-full items-center justify-between gap-3",
                                isAmountCard && "mt-auto pt-3",
                            )}
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                {isAmountCard ? (
                                    <TokenDisplay
                                        symbol={token.symbol}
                                        icon={token.icon}
                                        chainIcons={token.chainIcons}
                                        iconSize="xl"
                                    />
                                ) : null}
                                <div className="flex flex-col min-w-0 text-left">
                                    {isAmountCard ? (
                                        <>
                                            <span className="text-sm font-medium leading-normal text-general-secondary-foreground">
                                                {t("balanceLabel")}
                                            </span>
                                            <span className="truncate text-base font-semibold leading-tight text-foreground">
                                                {
                                                    amountFormat.rawToken(
                                                        tokenBalance,
                                                        tokenDecimals,
                                                        {
                                                            profile: "compact",
                                                            unitPriceUsd:
                                                                tokenPrice,
                                                            rounding: "down",
                                                        },
                                                    ).display
                                                }{" "}
                                                {token.symbol.toUpperCase()}
                                            </span>
                                        </>
                                    ) : (
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
                                    )}
                                </div>
                            </div>
                            {!readOnly && (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="shrink-0 bg-muted-foreground/10 px-3 text-sm font-bold leading-3.5 text-general-secondary-foreground hover:bg-muted-foreground/20"
                                    size="sm"
                                    onClick={handleMaxClick}
                                >
                                    {t("useMax")}
                                </Button>
                            )}
                        </div>
                    ) : null;

                const messageOffsetClass = isSwapCard
                    ? "mt-0"
                    : isAmountCard
                      ? "mt-1 text-center"
                      : "mt-2";
                const amountMessages = displayError ? (
                    <p
                        className={cn(
                            "text-sm font-semibold text-destructive",
                            messageOffsetClass,
                            isSwapCard && "text-left leading-[1.3125rem]",
                        )}
                    >
                        {String(displayError)}
                    </p>
                ) : balanceWarning ? (
                    <p
                        className={cn(
                            "text-general-info-foreground text-sm font-semibold leading-normal",
                            messageOffsetClass,
                        )}
                    >
                        {balanceWarning.type === "fee_not_covered"
                            ? t("insufficientTokensForFee", {
                                  fee: balanceWarning.formattedFee ?? "",
                                  symbol: balanceWarning.symbol ?? "",
                              })
                            : t("insufficientTokens")}
                    </p>
                ) : warningMessage ? (
                    <WarningMessage
                        variant="inline"
                        message={warningMessage}
                        className={cn(
                            "text-sm font-semibold",
                            messageOffsetClass,
                        )}
                    />
                ) : infoMessage ? (
                    <p
                        className={cn(
                            "text-general-info-foreground text-sm font-semibold leading-normal",
                            messageOffsetClass,
                        )}
                    >
                        {infoMessage}
                    </p>
                ) : !isAmountCard && !isSwapCard ? (
                    <p className="text-muted-foreground text-xs invisible">
                        Invisible
                    </p>
                ) : null;

                const tokenPicker = (
                    <div
                        className="cursor-pointer"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <FormField
                            control={control}
                            name={tokenName}
                            render={({ field: tokenField }) => {
                                const handleTokenSelect = (
                                    selectedToken: SelectedTokenData,
                                ) => {
                                    tokenField.onChange(selectedToken);
                                    onTokenChange?.(selectedToken as Token);
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
                                        setSelectedToken={handleTokenSelect}
                                        showOnlyOwnedAssets={
                                            tokenSelect?.showOnlyOwnedAssets ??
                                            false
                                        }
                                        filterTokens={tokenSelect?.filterTokens}
                                        autoSelect={tokenSelect?.autoSelect}
                                        balanceLayout={
                                            tokenSelectExtras?.balanceLayout
                                        }
                                        hideNetworkSubtitle={
                                            isSwapCard ||
                                            tokenSelectExtras?.hideNetworkSubtitle
                                        }
                                        triggerLabel={
                                            isSwapCard
                                                ? undefined
                                                : tokenSelectExtras?.triggerLabel
                                        }
                                        appearance={
                                            isSwapCard
                                                ? "default"
                                                : tokenSelectExtras?.appearance
                                        }
                                        iconSize={isSwapCard ? "lg" : undefined}
                                        tintTriggerFromIcon={isSwapCard}
                                        classNames={
                                            isSwapCard
                                                ? {
                                                      trigger:
                                                          "h-11 rounded-full border-general-border bg-muted px-2.5 hover:bg-muted hover:border-general-border",
                                                      icon: "size-7",
                                                      symbol: "text-base font-semibold leading-[1.2] text-general-foreground",
                                                  }
                                                : undefined
                                        }
                                    />
                                );
                            }}
                        />
                    </div>
                );

                const usdToggle = secondaryLine ? (
                    <button
                        type="button"
                        className={cn(
                            "inline-flex items-center gap-1 rounded-md text-muted-foreground",
                            isSwapCard
                                ? "px-0 py-0 text-center text-sm font-semibold leading-[1.3125rem] text-general-secondary-foreground"
                                : "px-2 py-0.5 text-xs mt-1",
                            canToggle
                                ? "cursor-pointer hover:text-foreground"
                                : "cursor-default",
                        )}
                        onClick={canToggle ? handleToggleCurrency : undefined}
                        disabled={!canToggle}
                    >
                        <span>
                            {enableUsdToggle && secondaryTokenAmount
                                ? secondaryTokenAmount
                                : secondaryLine}
                        </span>
                        {canToggle ? (
                            <Icon icon={ArrowUpDownIcon} className="size-3.5" />
                        ) : null}
                    </button>
                ) : null;

                const swapBalance =
                    token && tokenBalance != null && tokenDecimals != null ? (
                        <button
                            type="button"
                            onClick={handleMaxClick}
                            disabled={
                                readOnly ||
                                tokenBalance === "" ||
                                tokenBalance === "0"
                            }
                            aria-label={t("useMax")}
                            className={cn(
                                "max-w-[10rem] truncate text-sm font-semibold leading-[1.3125rem] text-general-secondary-foreground",
                                readOnly
                                    ? "cursor-default"
                                    : "cursor-pointer hover:text-foreground",
                            )}
                        >
                            <FormattedAmount
                                kind="raw-token"
                                value={tokenBalance}
                                symbol={token.symbol}
                                tokenDecimals={tokenDecimals}
                                unitPriceUsd={tokenPrice}
                                profile="compact"
                                rounding="down"
                            />
                        </button>
                    ) : null;

                if (isSwapCard) {
                    return (
                        <div
                            className={cn(
                                "flex flex-col rounded-2xl border border-general-border bg-card p-5",
                                !readOnly && "cursor-text",
                                displayError && "border-destructive",
                            )}
                            onClick={(event) =>
                                focusCardAmountInput(event, readOnly)
                            }
                        >
                            <div className="flex min-h-0 flex-1 items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <LargeInput
                                        type="text"
                                        inputMode="decimal"
                                        borderless
                                        dynamicFontSize={dynamicFontSize}
                                        dynamicFontScale="hero"
                                        containerClassName="w-full max-w-full justify-start"
                                        textSizeClassName="font-semibold tracking-[-0.05625rem]"
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
                                        value={displayPrimary}
                                        placeholder="0"
                                        className="h-10 text-left text-general-foreground placeholder:text-general-muted-foreground"
                                        readOnly={readOnly}
                                        suffix={
                                            enableUsdToggle &&
                                            inputMode === "usd"
                                                ? "USD"
                                                : undefined
                                        }
                                    />
                                    {usdToggle}
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-2">
                                    {tokenPicker}
                                    {swapBalance}
                                </div>
                            </div>
                            {amountMessages}
                        </div>
                    );
                }

                if (isAmountCard) {
                    return (
                        <div
                            className={cn(
                                "flex h-60 w-full flex-col items-stretch self-stretch rounded-3xl border border-general-border bg-card p-4",
                                !readOnly && "cursor-text",
                                displayError && "border-destructive",
                            )}
                            onClick={(event) =>
                                focusCardAmountInput(event, readOnly)
                            }
                        >
                            <div className="flex w-full max-w-full flex-1 flex-col items-center justify-center gap-1 px-1">
                                <LargeInput
                                    type="text"
                                    inputMode="decimal"
                                    borderless
                                    dynamicFontSize
                                    dynamicFontScale="hero"
                                    containerClassName="w-full max-w-full"
                                    textSizeClassName="font-semibold tracking-tighter"
                                    suffix={primarySuffix}
                                    suffixClassName="font-semibold tracking-tight"
                                    onKeyDown={
                                        readOnly
                                            ? undefined
                                            : handleAmountKeyDown
                                    }
                                    onPaste={
                                        readOnly ? undefined : handleAmountPaste
                                    }
                                    onChange={
                                        readOnly
                                            ? undefined
                                            : handleAmountChange
                                    }
                                    onBlur={readOnly ? undefined : field.onBlur}
                                    value={displayPrimary}
                                    placeholder="0"
                                    className={cn(
                                        "h-10 text-center text-foreground",
                                        readOnly && "text-muted-foreground",
                                    )}
                                    readOnly={readOnly}
                                />
                                {secondaryLine ? (
                                    <button
                                        type="button"
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-center text-base font-semibold leading-tight text-general-secondary-foreground",
                                            canToggle
                                                ? "cursor-pointer hover:bg-general-bg-secondary"
                                                : "cursor-default",
                                        )}
                                        onClick={
                                            canToggle
                                                ? handleToggleCurrency
                                                : undefined
                                        }
                                        disabled={!canToggle}
                                    >
                                        <span>{secondaryLine}</span>
                                        {canToggle ? (
                                            <Icon
                                                icon={ArrowUpDownIcon}
                                                className="size-3.5"
                                            />
                                        ) : null}
                                    </button>
                                ) : null}
                                {amountMessages}
                            </div>
                            {balanceFooter}
                        </div>
                    );
                }

                return (
                    <InputBlock
                        interactive={!readOnly}
                        title={title}
                        invalid={!!displayError}
                        topRightContent={balanceFooter}
                        className={cn(!readOnly && "cursor-text")}
                        onClick={(event) =>
                            focusCardAmountInput(event, readOnly)
                        }
                    >
                        <div>
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
                                        value={displayPrimary}
                                        placeholder="0"
                                        className={cn(
                                            readOnly && "text-muted-foreground",
                                        )}
                                        readOnly={readOnly}
                                        suffix={
                                            enableUsdToggle &&
                                            inputMode === "usd"
                                                ? "USD"
                                                : undefined
                                        }
                                    />
                                </div>
                                {tokenPicker}
                            </div>
                            {enableUsdToggle && secondaryTokenAmount ? (
                                <button
                                    type="button"
                                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-muted-foreground text-xs mt-1 hover:bg-general-bg-secondary"
                                    onClick={handleToggleCurrency}
                                >
                                    <span>{secondaryTokenAmount}</span>
                                    <Icon
                                        icon={ArrowUpDownIcon}
                                        className="size-3.5"
                                    />
                                </button>
                            ) : estimatedUSDValue?.gt(0) ? (
                                <button
                                    type="button"
                                    className={cn(
                                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-muted-foreground text-xs truncate mt-1",
                                        enableUsdToggle &&
                                            tokenPrice &&
                                            "cursor-pointer hover:bg-general-bg-secondary",
                                    )}
                                    onClick={
                                        enableUsdToggle && tokenPrice
                                            ? handleToggleCurrency
                                            : undefined
                                    }
                                    disabled={
                                        !enableUsdToggle ||
                                        !tokenPrice ||
                                        readOnly
                                    }
                                >
                                    <span>
                                        ≈{" "}
                                        <FormattedAmount
                                            kind="fiat"
                                            value={estimatedUSDValue}
                                        />
                                    </span>
                                    {enableUsdToggle && tokenPrice ? (
                                        <Icon
                                            icon={ArrowUpDownIcon}
                                            className="size-3.5"
                                        />
                                    ) : null}
                                </button>
                            ) : null}
                            {amountMessages}
                        </div>
                    </InputBlock>
                );
            }}
        />
    );
}

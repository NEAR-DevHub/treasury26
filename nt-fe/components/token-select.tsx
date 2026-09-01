"use client";
import {
    ArrowDown01Icon,
    ArrowLeft01Icon,
    InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import {
    iconTintVars,
    useIconAccentColor,
} from "@/hooks/use-icon-accent-color";
import {
    type MergedNetwork,
    type MergedToken,
    useMergedTokens,
} from "@/hooks/use-merged-tokens";
import { usePopularAssetsByActivity } from "@/hooks/use-treasury-queries";
import type { ChainIcons } from "@/lib/api";
import Big from "@/lib/big";
import { pickDefaultSelectedToken } from "@/lib/pick-default-token";
import {
    canonicalizeTokenIdForMatch,
    cn,
    formatBalance,
    formatCurrencyWithSubCent,
    formatSmartAmount,
} from "@/lib/utils";
import { Button } from "./button";
import { HighlightedText } from "./highlighted-text";
import { Input } from "./input";
import { Dialog, DialogHeader, DialogTitle, DialogTrigger } from "./modal";
import { PaymentSelectModalContent } from "./payment-select-modal-content";
import { SelectListIcon } from "./select-list";
import {
    EmptySelectorIcon,
    paymentSelectModalListClassName,
    paymentSelectModalSearchInputClassName,
    selectorTriggerClassName,
} from "./selector-field";
import { NetworkIconDisplay } from "./token-display";
import { TokenDisplay } from "./token-display-with-network";
import { Tooltip } from "./tooltip";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";

const TOKEN_SKELETON_IDS = ["one", "two", "three", "four"] as const;

// Selected token (asset + specific network)
export interface SelectedTokenData {
    address: string;
    symbol: string;
    decimals: number;
    name: string;
    icon: string;
    network: string;
    chainIcons?: ChainIcons;
    residency?: string;
    minWithdrawalAmount?: string;
    minDepositAmount?: string;
    balance?: string;
    price?: number;
    balanceAssetId?: string;
    quoteAssetId?: string;
}

interface TokenSelectProps {
    selectedToken: SelectedTokenData | null;
    setSelectedToken: (token: SelectedTokenData) => void;
    disabled?: boolean;
    locked?: boolean;
    classNames?: {
        trigger?: string;
        icon?: string;
        symbol?: string;
    };
    lockedTokenData?: SelectedTokenData;
    /**
     * When true, only shows tokens that the user owns (has balance > 0).
     * When false, shows all tokens (treasury + bridge tokens).
     * Default: false (show all assets)
     */
    showOnlyOwnedAssets?: boolean;
    /**
     * Size of the token icon in the trigger button.
     * Options: "sm" | "md" | "lg"
     * Default: "md"
     */
    iconSize?: "sm" | "md" | "lg" | "xl" | "2xl";
    /** Optional field label used by card-style selector triggers. */
    triggerLabel?: string;
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
    showPopularAssets?: boolean;
    disableTokenMessage?: string;
    disableTokens?: (token: {
        address: string;
        symbol: string;
        network: string;
        residency?: string;
    }) => boolean;
    /**
     * When true (default), auto-picks the highest-USD owned asset from the
     * assets cache, else USDC on NEAR. Set false for Exchange (and any flow
     * that seeds its own tokens).
     */
    autoSelect?: boolean;
    /** Balance column layout on asset rows. */
    balanceLayout?: "usdPrimary" | "tokenPrimary";
    /** Hide network subtitle under the trigger symbol. */
    hideNetworkSubtitle?: boolean;
    /** Full-width labeled card trigger (Send redesign). */
    appearance?: "default" | "card";
    /**
     * Tints the trigger with the selected icon's dominant colour (Swap pills).
     * Falls back to the trigger's own background for icons whose colour cannot
     * be read — monochrome art, or a host that serves no CORS headers.
     */
    tintTriggerFromIcon?: boolean;
}

export default function TokenSelect({
    selectedToken,
    setSelectedToken,
    disabled,
    locked,
    lockedTokenData,
    disableTokenMessage,
    disableTokens,
    classNames,
    showOnlyOwnedAssets = false,
    iconSize = "md",
    triggerLabel,
    filterTokens,
    showPopularAssets = false,
    autoSelect = true,
    balanceLayout = "tokenPrimary",
    hideNetworkSubtitle = false,
    appearance = "default",
    tintTriggerFromIcon = false,
}: TokenSelectProps) {
    const t = useTranslations("tokenSelectDialog");
    const tDepositSections = useTranslations("depositModal.sections");
    const iconAccent = useIconAccentColor(
        tintTriggerFromIcon ? selectedToken?.icon : null,
    );
    const iconTint = iconTintVars(iconAccent);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedAsset, setSelectedAsset] = useState<MergedToken | null>(
        null,
    );
    const [step, setStep] = useState<"token" | "network">("token");
    const { data: popularAssets = [] } = usePopularAssetsByActivity(
        showPopularAssets && open && step === "token",
    );

    const { tokens, isLoading, isAssetsReady } = useMergedTokens({
        // Fetch while auto-selecting even if the modal is closed, so the
        // highest-USD default (and USDC fallback) can resolve immediately.
        enabled: !showOnlyOwnedAssets && (open || autoSelect),
        showOnlyOwned: showOnlyOwnedAssets,
    });

    // Wait for assets cache/fetch before picking — avoids flashing USDC then
    // swapping to the highest-USD owned token when holdings arrive.
    useEffect(() => {
        if (!autoSelect || locked || selectedToken || !isAssetsReady) return;

        setSelectedToken(
            pickDefaultSelectedToken(tokens, {
                disableTokens: (candidate) => {
                    if (disableTokens?.(candidate)) return true;
                    // Respect list filters (e.g. confidential intents-only).
                    if (filterTokens && !filterTokens(candidate)) return true;
                    return false;
                },
            }),
        );
    }, [
        autoSelect,
        isAssetsReady,
        tokens,
        selectedToken,
        locked,
        setSelectedToken,
        disableTokens,
        filterTokens,
    ]);

    // Source-agnostic list for rendering/selecting.
    const filteredTokens = useMemo(() => {
        const searchLower = search.toLowerCase();

        const matchesSearch = (t: MergedToken) =>
            !searchLower ||
            t.id.includes(searchLower) ||
            t.name.toLowerCase().includes(searchLower) ||
            t.symbol.toLowerCase().includes(searchLower) ||
            t.networks.some((n) =>
                n.symbol.toLowerCase().includes(searchLower),
            );

        const applyNetworkFilter = (t: MergedToken): MergedToken | null => {
            if (!filterTokens) return t;
            const filtered = t.networks.filter((n) =>
                filterTokens({
                    address: n.id,
                    symbol: n.symbol,
                    network: n.name,
                    residency: n.residency,
                }),
            );
            if (filtered.length === 0) return null;
            let totalBalance = 0;
            let totalBalanceUSD = 0;
            for (const n of filtered) {
                totalBalanceUSD += n.balanceUSD ?? 0;
                try {
                    totalBalance += Big(n.balance || "0")
                        .div(Big(10).pow(n.decimals))
                        .toNumber();
                } catch {
                    /* skip */
                }
            }
            return {
                ...t,
                networks: filtered,
                totalBalance,
                totalBalanceUSD,
            };
        };

        const filteredTokensList: MergedToken[] = [];

        for (const token of tokens) {
            if (!matchesSearch(token)) continue;
            const filtered = applyNetworkFilter(token);
            if (!filtered) continue;
            filteredTokensList.push(filtered);
        }

        return filteredTokensList;
    }, [tokens, search, filterTokens]);

    const { yourAssets, otherAssets } = useMemo(() => {
        const yourAssetsFiltered = filteredTokens.filter(
            (token) => (token.totalBalance ?? 0) > 0,
        );
        const otherAssetsFiltered = filteredTokens.filter(
            (token) => (token.totalBalance ?? 0) <= 0,
        );

        return {
            yourAssets: yourAssetsFiltered,
            otherAssets: otherAssetsFiltered,
        };
    }, [filteredTokens]);

    const popularTokens = useMemo(() => {
        if (!showPopularAssets || popularAssets.length === 0) return [];

        const popularIds = new Set<string>();
        for (const asset of popularAssets) {
            popularIds.add(asset.tokenId.toLowerCase());
            popularIds.add(canonicalizeTokenIdForMatch(asset.tokenId));
        }

        return filteredTokens
            .filter((token) => {
                const tokenCandidates = new Set<string>([
                    token.id.toLowerCase(),
                    canonicalizeTokenIdForMatch(token.id),
                ]);
                for (const network of token.networks) {
                    tokenCandidates.add(network.id.toLowerCase());
                    tokenCandidates.add(
                        canonicalizeTokenIdForMatch(network.id),
                    );
                    tokenCandidates.add(network.chainId.toLowerCase());
                    tokenCandidates.add(
                        canonicalizeTokenIdForMatch(network.chainId),
                    );
                }

                for (const candidate of tokenCandidates) {
                    if (popularIds.has(candidate)) {
                        return true;
                    }
                }
                return false;
            })
            .slice(0, 8);
    }, [showPopularAssets, popularAssets, filteredTokens]);

    const networkItems = useMemo((): MergedNetwork[] => {
        if (!selectedAsset) return [];

        return [...selectedAsset.networks].sort((a, b) => {
            const aUSD = a.balanceUSD ?? 0;
            const bUSD = b.balanceUSD ?? 0;
            if (aUSD > 0 !== bUSD > 0) return bUSD > 0 ? 1 : -1;
            if (aUSD !== bUSD) return bUSD - aUSD;
            return a.name.localeCompare(b.name);
        });
    }, [selectedAsset]);

    const handleTokenClick = useCallback((token: MergedToken) => {
        setSelectedAsset(token);
        setStep("network");
    }, []);

    const handleNetworkClick = useCallback(
        (network: MergedNetwork) => {
            if (!selectedAsset) return;

            setSelectedToken({
                address: network.id,
                symbol: network.symbol,
                decimals: network.decimals,
                name: selectedAsset.name,
                icon: selectedAsset.icon || "",
                network: network.name,
                chainIcons: network.chainIcons || undefined,
                residency: network.residency,
                minWithdrawalAmount: network.minWithdrawalAmount,
                minDepositAmount: network.minDepositAmount,
                balance: network.balance,
                price: network.price,
                balanceAssetId: network.balanceAssetId || network.id,
                quoteAssetId:
                    network.quoteAssetId ||
                    network.balanceAssetId ||
                    network.id,
            });

            setOpen(false);
            setSearch("");
            setStep("token");
            setSelectedAsset(null);
        },
        [selectedAsset, setSelectedToken],
    );

    const handleBack = useCallback(() => {
        setStep("token");
        setSelectedAsset(null);
    }, []);

    const handleOpenChange = useCallback((newOpen: boolean) => {
        setOpen(newOpen);
        if (!newOpen) {
            setStep("token");
            setSelectedAsset(null);
            setSearch("");
        }
    }, []);

    // Render locked state
    if (locked && lockedTokenData) {
        return (
            <div className="flex gap-2 items-center h-9 px-4 py-2 has-[>svg]:px-3 bg-card rounded-full cursor-default hover:bg-card hover:border-border">
                <TokenDisplay
                    symbol={lockedTokenData.symbol}
                    icon={lockedTokenData.icon}
                    chainIcons={lockedTokenData.chainIcons}
                />
                <div className="flex flex-col items-start">
                    <span className="font-semibold text-sm leading-none">
                        {lockedTokenData.symbol}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground uppercase">
                        {lockedTokenData.network}
                    </span>
                </div>
            </div>
        );
    }

    const renderTokenButton = (token: MergedToken) => {
        const isSelectedAsset = token.networks.some(
            (network) =>
                network.id === selectedToken?.address &&
                network.name === selectedToken?.network,
        );
        return (
            <Button
                key={token.id}
                onClick={() => handleTokenClick(token)}
                variant="ghost"
                type="button"
                className={cn(
                    "w-full flex items-center gap-1 py-2 rounded-lg h-auto justify-start pl-0! my-0.5",
                    isSelectedAsset &&
                        "bg-muted hover:bg-muted focus-visible:bg-muted",
                )}
            >
                <SelectListIcon
                    icon={token.icon}
                    alt={token.symbol || token.name}
                />
                <div className="flex-1 text-left">
                    <div className="font-semibold">
                        <HighlightedText
                            text={token.symbol || token.name}
                            query={search}
                        />
                    </div>
                    {token.name && token.name !== token.symbol ? (
                        <div className="text-sm text-muted-foreground font-medium">
                            <HighlightedText text={token.name} query={search} />
                        </div>
                    ) : null}
                </div>
                {token.totalBalance !== undefined && token.totalBalance > 0 && (
                    <div className="flex flex-col items-end">
                        {balanceLayout === "usdPrimary" ? (
                            <>
                                <span className="font-semibold">
                                    {formatCurrencyWithSubCent(
                                        token.totalBalanceUSD || 0,
                                    )}
                                </span>
                                <span className="text-sm text-muted-foreground font-medium">
                                    {formatSmartAmount(token.totalBalance)}
                                </span>
                            </>
                        ) : (
                            <>
                                <span className="font-semibold">
                                    {formatSmartAmount(token.totalBalance)}
                                </span>
                                <span className="text-sm text-muted-foreground font-medium">
                                    ≈
                                    {formatCurrencyWithSubCent(
                                        token.totalBalanceUSD || 0,
                                    )}
                                </span>
                            </>
                        )}
                    </div>
                )}
            </Button>
        );
    };

    // Payments/bulk wait for assets before seeding — show a skeleton. Exchange already has a seeded token.
    const showDefaultLoading = !selectedToken && !isAssetsReady;
    const iconSkeletonClass =
        iconSize === "2xl"
            ? "size-10"
            : iconSize === "xl"
              ? "size-9"
              : iconSize === "lg"
                ? "size-6"
                : iconSize === "sm"
                  ? "size-4"
                  : "size-5";

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild disabled={disabled || showDefaultLoading}>
                {appearance === "card" ? (
                    <Button
                        type="button"
                        variant="unstyled"
                        disabled={disabled || showDefaultLoading}
                        className={cn(
                            selectorTriggerClassName,
                            (disabled || locked) && "opacity-60",
                            classNames?.trigger,
                        )}
                    >
                        {showDefaultLoading ? (
                            <div className="flex w-full items-center gap-3 min-w-0">
                                <Skeleton className="size-10 rounded-full shrink-0" />
                                <div className="flex flex-col gap-1 flex-1">
                                    <Skeleton className="h-3 w-12" />
                                    <Skeleton className="h-4 w-16" />
                                </div>
                            </div>
                        ) : (
                            <>
                                {selectedToken ? (
                                    <TokenDisplay
                                        symbol={selectedToken.symbol}
                                        icon={selectedToken.icon}
                                        chainIcons={selectedToken.chainIcons}
                                        iconSize="2xl"
                                    />
                                ) : (
                                    <EmptySelectorIcon />
                                )}
                                <span className="flex min-w-0 flex-1 flex-col items-start gap-px">
                                    <span className="text-sm font-medium leading-normal text-muted-foreground">
                                        {triggerLabel ?? t("selectToken")}
                                    </span>
                                    <span
                                        className={cn(
                                            "max-w-full truncate text-base font-semibold leading-tight",
                                            selectedToken
                                                ? "text-foreground"
                                                : "text-muted-foreground",
                                        )}
                                    >
                                        {selectedToken?.symbol ??
                                            t("selectToken")}
                                    </span>
                                </span>
                                <Icon
                                    icon={ArrowDown01Icon}
                                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                                />
                            </>
                        )}
                    </Button>
                ) : (
                    <Button
                        type="button"
                        variant="outline"
                        style={iconTint}
                        className={cn(
                            "bg-card hover:bg-card hover:border-muted-foreground rounded-full py-1 px-3! justify-start",
                            classNames?.trigger,
                            iconTint &&
                                "bg-[var(--icon-tint)] hover:bg-[var(--icon-tint-hover)]",
                        )}
                    >
                        {showDefaultLoading ? (
                            // Same pattern as treasury-selector loading state.
                            <div className="flex items-center gap-2 min-w-0 h-9">
                                <Skeleton
                                    className={cn(
                                        "rounded-full shrink-0",
                                        classNames?.icon ?? iconSkeletonClass,
                                    )}
                                />
                                <div className="flex flex-col gap-1">
                                    <Skeleton className="h-3 w-16" />
                                    <Skeleton className="h-3 w-12" />
                                </div>
                            </div>
                        ) : selectedToken ? (
                            <>
                                <TokenDisplay
                                    symbol={selectedToken.symbol}
                                    icon={selectedToken.icon}
                                    chainIcons={selectedToken.chainIcons}
                                    iconSize={iconSize}
                                    className={classNames?.icon}
                                />
                                <div className="flex flex-col items-start gap-px">
                                    {triggerLabel && (
                                        <span className="text-sm font-medium leading-5 text-muted-foreground">
                                            {triggerLabel}
                                        </span>
                                    )}
                                    <span
                                        className={cn(
                                            "font-semibold",
                                            triggerLabel
                                                ? "text-base leading-tight"
                                                : "text-sm leading-none",
                                            classNames?.symbol,
                                        )}
                                    >
                                        {selectedToken.symbol}
                                    </span>
                                    {!triggerLabel && !hideNetworkSubtitle && (
                                        <span className="text-xs font-normal text-muted-foreground uppercase">
                                            {selectedToken.network}
                                        </span>
                                    )}
                                </div>
                            </>
                        ) : (
                            <span className="text-muted-foreground">
                                {t("selectToken")}
                            </span>
                        )}
                        <Icon
                            icon={ArrowDown01Icon}
                            className="text-muted-foreground ml-auto"
                        />
                    </Button>
                )}
            </DialogTrigger>
            <PaymentSelectModalContent>
                <DialogHeader
                    centerTitle={false}
                    className="sticky top-0 border-0 pb-0 text-left"
                >
                    <div className="flex w-full items-center gap-2">
                        {step === "network" && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleBack}
                                type="button"
                            >
                                <Icon icon={ArrowLeft01Icon} />
                            </Button>
                        )}
                        <DialogTitle className="w-full text-left text-lg font-semibold">
                            {step === "token"
                                ? t("selectToken")
                                : t("selectNetwork")}
                        </DialogTitle>
                    </div>
                </DialogHeader>
                {step === "token" && (
                    <div className="mt-4 flex min-h-0 flex-1 flex-col space-y-4 sm:mt-0">
                        <Input
                            placeholder={t("searchByName")}
                            search
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            inputClassName={
                                paymentSelectModalSearchInputClassName
                            }
                        />
                        {isLoading ? (
                            <div className="space-y-1 animate-pulse">
                                {TOKEN_SKELETON_IDS.map((skeletonId) => (
                                    <div
                                        key={skeletonId}
                                        className="flex w-full items-center gap-3 rounded-lg py-3"
                                    >
                                        <div className="size-10 shrink-0 rounded-full bg-general-unofficial-accent-0" />
                                        <div className="flex-1 space-y-2">
                                            <div className="h-4 w-24 rounded bg-general-unofficial-accent-0" />
                                            <div className="h-3 w-32 rounded bg-general-unofficial-accent-0" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <ScrollArea
                                className={paymentSelectModalListClassName}
                            >
                                {showPopularAssets &&
                                    popularTokens.length > 0 && (
                                        <div className="mb-3">
                                            <div className="px-2 py-2 text-xs font-medium text-muted-foreground">
                                                {tDepositSections(
                                                    "popularAssets",
                                                )}
                                            </div>
                                            <div className="flex flex-wrap gap-2 px-2">
                                                {popularTokens.map((token) => (
                                                    <Button
                                                        key={`popular-${token.id}`}
                                                        type="button"
                                                        onClick={() =>
                                                            handleTokenClick(
                                                                token,
                                                            )
                                                        }
                                                        variant="secondary"
                                                        className={cn(
                                                            "h-7 gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
                                                            token.networks.some(
                                                                (network) =>
                                                                    network.id ===
                                                                        selectedToken?.address &&
                                                                    network.name ===
                                                                        selectedToken?.network,
                                                            ) && "bg-muted",
                                                        )}
                                                    >
                                                        <SelectListIcon
                                                            icon={token.icon}
                                                            alt={
                                                                token.symbol ||
                                                                token.name
                                                            }
                                                            size="sm"
                                                        />
                                                        <HighlightedText
                                                            text={
                                                                token.symbol ||
                                                                token.name
                                                            }
                                                            query={search}
                                                        />
                                                    </Button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                {yourAssets.length > 0 && (
                                    <div>
                                        <div className="text-xs font-medium text-muted-foreground px-2 py-2">
                                            {t("yourAssets")}
                                        </div>
                                        {yourAssets.map(renderTokenButton)}
                                    </div>
                                )}

                                {otherAssets.length > 0 && (
                                    <div>
                                        <div className="text-xs font-medium text-muted-foreground px-2 py-2">
                                            {t("otherAssets")}
                                        </div>
                                        {otherAssets.map(renderTokenButton)}
                                    </div>
                                )}

                                {filteredTokens.length === 0 && (
                                    <div className="text-center py-8 text-muted-foreground">
                                        {showOnlyOwnedAssets
                                            ? t("noTokensWithBalance")
                                            : t("noTokensFound")}
                                    </div>
                                )}
                            </ScrollArea>
                        )}
                    </div>
                )}
                {step === "network" && selectedAsset && (
                    <div className="mt-4 flex min-h-0 flex-1 flex-col sm:mt-0">
                        <ScrollArea className={paymentSelectModalListClassName}>
                            {(() => {
                                const hasBalance = (item: MergedNetwork) => {
                                    if (
                                        !item.balance ||
                                        item.balance.trim() === "" ||
                                        item.decimals === undefined
                                    ) {
                                        return false;
                                    }

                                    try {
                                        return !Big(
                                            formatBalance(
                                                item.balance,
                                                item.decimals,
                                            ),
                                        ).eq(0);
                                    } catch {
                                        return false;
                                    }
                                };

                                const isComingSoon = (item: MergedNetwork) =>
                                    Boolean(
                                        disableTokens?.({
                                            address: item.id,
                                            symbol: item.symbol,
                                            network: item.name,
                                            residency: item.residency,
                                        }),
                                    );

                                const withBalance =
                                    networkItems.filter(hasBalance);
                                const withoutBalance = networkItems.filter(
                                    (item) => !hasBalance(item),
                                );

                                const supportedWithBalance = withBalance.filter(
                                    (item) => !isComingSoon(item),
                                );
                                const supportedWithoutBalance =
                                    withoutBalance.filter(
                                        (item) => !isComingSoon(item),
                                    );
                                const comingSoonNetworks = [
                                    ...withBalance.filter(isComingSoon),
                                    ...withoutBalance.filter(isComingSoon),
                                ];

                                const renderNetworkButton = (
                                    item: MergedNetwork,
                                    idx: number,
                                ) => {
                                    const isSelectedNetwork =
                                        item.id === selectedToken?.address &&
                                        item.name === selectedToken?.network;
                                    const isDisabled = disableTokens?.({
                                        address: item.id,
                                        symbol: item.symbol,
                                        network: item.name,
                                        residency: item.residency,
                                    });
                                    return (
                                        <Button
                                            key={`${item.id}-${idx}`}
                                            onClick={() =>
                                                handleNetworkClick(item)
                                            }
                                            variant="ghost"
                                            type="button"
                                            disabled={isDisabled}
                                            className={cn(
                                                "w-full flex items-center gap-1 py-2.5 rounded-lg h-auto justify-start pl-1.5! mx-1 my-0.5",
                                                isSelectedNetwork &&
                                                    "bg-muted hover:bg-muted focus-visible:bg-muted",
                                            )}
                                        >
                                            <div className="pl-3 w-full">
                                                <div className="flex items-center gap-3">
                                                    <NetworkIconDisplay
                                                        chainIcons={
                                                            item.chainIcons
                                                        }
                                                        networkName={item.name}
                                                        residency={
                                                            item.residency
                                                        }
                                                    />
                                                </div>
                                            </div>
                                            <div className="flex-1" />
                                            {hasBalance(item) && (
                                                <div className="flex flex-col items-end">
                                                    <span className="font-semibold">
                                                        {formatSmartAmount(
                                                            formatBalance(
                                                                item.balance!,
                                                                item.decimals!,
                                                            ),
                                                        )}
                                                    </span>
                                                    <span className="text-sm text-muted-foreground">
                                                        ≈
                                                        {formatCurrencyWithSubCent(
                                                            item.balanceUSD ||
                                                                0,
                                                        )}
                                                    </span>
                                                </div>
                                            )}
                                        </Button>
                                    );
                                };

                                return (
                                    <>
                                        {supportedWithBalance.length > 0 && (
                                            <div>
                                                <div className="text-xs font-medium text-muted-foreground px-2 py-2">
                                                    {t("networksWithAssets")}
                                                </div>
                                                {supportedWithBalance.map(
                                                    renderNetworkButton,
                                                )}
                                            </div>
                                        )}

                                        {supportedWithoutBalance.length > 0 && (
                                            <div>
                                                <div className="text-xs font-medium text-muted-foreground px-2 py-2">
                                                    {t("supportedNetworks")}
                                                </div>
                                                {supportedWithoutBalance.map(
                                                    renderNetworkButton,
                                                )}
                                            </div>
                                        )}

                                        {comingSoonNetworks.length > 0 && (
                                            <div>
                                                <div className="text-xs font-medium text-muted-foreground px-2 py-2 flex items-center gap-1.5">
                                                    {t("comingSoon")}
                                                    {disableTokenMessage && (
                                                        <Tooltip
                                                            content={
                                                                disableTokenMessage
                                                            }
                                                            side="top"
                                                        >
                                                            <span className="inline-flex items-center justify-center">
                                                                <Icon
                                                                    icon={
                                                                        InformationCircleIcon
                                                                    }
                                                                    className="text-muted-foreground normal-case"
                                                                />
                                                            </span>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                                {comingSoonNetworks.map(
                                                    renderNetworkButton,
                                                )}
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </ScrollArea>
                    </div>
                )}
            </PaymentSelectModalContent>
        </Dialog>
    );
}

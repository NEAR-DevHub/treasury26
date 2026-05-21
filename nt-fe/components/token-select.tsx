"use client";

import { ChevronDown, ChevronLeft, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    useMergedTokens,
    type MergedNetwork,
    type MergedToken,
} from "@/hooks/use-merged-tokens";
import type { ChainIcons } from "@/lib/api";
import Big from "@/lib/big";
import { cn, formatBalance, formatSmartAmount } from "@/lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "./modal";
import { SelectListIcon } from "./select-list";
import { NetworkIconDisplay } from "./token-display";
import { TokenDisplay } from "./token-display-with-network";
import { Tooltip } from "./tooltip";
import { ScrollArea } from "./ui/scroll-area";

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
}

interface TokenSelectProps {
    selectedToken: SelectedTokenData | null;
    setSelectedToken: (token: SelectedTokenData) => void;
    disabled?: boolean;
    locked?: boolean;
    classNames?: {
        trigger?: string;
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
    iconSize?: "sm" | "md" | "lg";
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
    disableTokenMessage?: string;
    disableTokens?: (token: {
        address: string;
        symbol: string;
        network: string;
        residency?: string;
    }) => boolean;
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
    filterTokens,
}: TokenSelectProps) {
    const t = useTranslations("tokenSelectDialog");
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedAsset, setSelectedAsset] = useState<MergedToken | null>(
        null,
    );
    const [step, setStep] = useState<"token" | "network">("token");

    const { tokens, isLoading } = useMergedTokens({
        enabled: !showOnlyOwnedAssets && open,
        showOnlyOwned: showOnlyOwnedAssets,
    });

    // Auto-select first available token on initial load.
    useEffect(() => {
        if (tokens.length > 0 && !selectedToken && !locked) {
            const firstToken = tokens[0];
            const firstNetwork = firstToken.networks[0];
            if (!firstNetwork) return;
            setSelectedToken({
                address: firstNetwork.id,
                symbol: firstNetwork.symbol,
                decimals: firstNetwork.decimals,
                name: firstToken.name || firstNetwork.symbol,
                icon: firstToken.icon || "",
                network: firstNetwork.name,
                chainIcons: firstNetwork.chainIcons || undefined,
                residency: firstNetwork.residency,
                minWithdrawalAmount: firstNetwork.minWithdrawalAmount,
                minDepositAmount: firstNetwork.minDepositAmount,
            });
        }
    }, [tokens, selectedToken, locked, setSelectedToken]);

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
            return { ...t, networks: filtered };
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
                    <span className="text-[10px] font-normal text-muted-foreground uppercase">
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
                    "w-full flex items-center gap-1 py-2.5 rounded-lg h-auto justify-start pl-1.5! mx-1 my-0.5",
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
                        {token.symbol || token.name}
                    </div>
                    <div className="text-sm text-muted-foreground">
                        {t("networksCount", { count: token.networks.length })}
                    </div>
                </div>
                {token.totalBalance !== undefined && token.totalBalance > 0 && (
                    <div className="flex flex-col items-end">
                        <span className="font-semibold">
                            {formatSmartAmount(token.totalBalance)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                            ≈${token.totalBalanceUSD?.toFixed(2) || "0.00"}
                        </span>
                    </div>
                )}
            </Button>
        );
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild disabled={disabled}>
                <Button
                    type="button"
                    variant="outline"
                    className={cn(
                        "bg-card hover:bg-card hover:border-muted-foreground rounded-full py-1 px-3! justify-start",
                        classNames?.trigger,
                    )}
                >
                    {selectedToken ? (
                        <>
                            <TokenDisplay
                                symbol={selectedToken.symbol}
                                icon={selectedToken.icon}
                                chainIcons={selectedToken.chainIcons}
                                iconSize={iconSize}
                            />
                            <div className="flex flex-col items-start">
                                <span className="font-semibold text-sm leading-none">
                                    {selectedToken.symbol}
                                </span>
                                <span className="text-[10px] font-normal text-muted-foreground uppercase">
                                    {selectedToken.network}
                                </span>
                            </div>
                        </>
                    ) : (
                        <span className="text-muted-foreground">
                            {t("selectToken")}
                        </span>
                    )}
                    <ChevronDown className="size-4 text-muted-foreground ml-auto" />
                </Button>
            </DialogTrigger>
            <DialogContent className="flex flex-col max-w-md">
                <DialogHeader centerTitle={true}>
                    <div className="flex items-center gap-2 w-full">
                        {step === "network" && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleBack}
                                type="button"
                            >
                                <ChevronLeft className="size-5" />
                            </Button>
                        )}
                        <DialogTitle className="w-full text-center">
                            {step === "token"
                                ? t("selectAsset")
                                : t("selectNetworkFor", {
                                      asset: selectedAsset?.name ?? "",
                                  })}
                        </DialogTitle>
                    </div>
                </DialogHeader>
                {step === "token" && (
                    <div className="space-y-4">
                        <Input
                            placeholder={t("searchByName")}
                            search
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        {isLoading ? (
                            <div className="space-y-1 animate-pulse">
                                {[...Array(4)].map((_, i) => (
                                    <div
                                        key={i}
                                        className="w-full flex items-center gap-3 py-3 rounded-lg"
                                    >
                                        <div className="w-10 h-10 rounded-full bg-muted shrink-0" />
                                        <div className="flex-1 space-y-2">
                                            <div className="h-4 bg-muted rounded w-24" />
                                            <div className="h-3 bg-muted rounded w-32" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <ScrollArea className="h-[400px]">
                                {yourAssets.length > 0 && (
                                    <div className="mb-4">
                                        <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                                            {t("yourAssets")}
                                        </div>
                                        {yourAssets.map(renderTokenButton)}
                                    </div>
                                )}

                                {otherAssets.length > 0 && (
                                    <div>
                                        <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
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
                    <ScrollArea className="h-[400px]">
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

                            const withBalance = networkItems.filter(hasBalance);
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
                                        onClick={() => handleNetworkClick(item)}
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
                                                    chainIcons={item.chainIcons}
                                                    networkName={item.name}
                                                    residency={item.residency}
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
                                                    ≈$
                                                    {item.balanceUSD?.toFixed(
                                                        2,
                                                    ) || "0.00"}
                                                </span>
                                            </div>
                                        )}
                                    </Button>
                                );
                            };

                            return (
                                <>
                                    {supportedWithBalance.length > 0 && (
                                        <div className="mb-4">
                                            <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                                                {t("networksWithAssets")}
                                            </div>
                                            {supportedWithBalance.map(
                                                renderNetworkButton,
                                            )}
                                        </div>
                                    )}

                                    {supportedWithoutBalance.length > 0 && (
                                        <div className="mb-4">
                                            <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                                                {t("supportedNetworks")}
                                            </div>
                                            {supportedWithoutBalance.map(
                                                renderNetworkButton,
                                            )}
                                        </div>
                                    )}

                                    {comingSoonNetworks.length > 0 && (
                                        <div className="mb-4">
                                            <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2 flex items-center gap-1.5">
                                                {t("comingSoon")}
                                                {disableTokenMessage && (
                                                    <Tooltip
                                                        content={
                                                            disableTokenMessage
                                                        }
                                                        side="top"
                                                    >
                                                        <span className="inline-flex items-center justify-center">
                                                            <Info className="size-3.5 text-muted-foreground normal-case" />
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
                )}
            </DialogContent>
        </Dialog>
    );
}

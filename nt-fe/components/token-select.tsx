"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "./modal";
import { ChevronDown, ChevronLeft, Info } from "lucide-react";
import { Button } from "./button";
import { cn, formatBalance, formatNearAmount } from "@/lib/utils";
import { ChainIcons } from "@/lib/api";
import { useAggregatedTokens } from "@/hooks/use-assets";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import Big from "big.js";
import { TokenDisplay } from "./token-display-with-network";
import { Input } from "./input";
import { SelectListIcon } from "./select-list";
import { ScrollArea } from "./ui/scroll-area";
import { useTreasury } from "@/hooks/use-treasury";
import { useAssets } from "@/hooks/use-assets";
import { Tooltip } from "./tooltip";

interface SelectListItem {
    id: string;
    name: string;
    symbol?: string;
    icon: string;
    gradient?: string;
}

// Core data types
interface Network {
    id: string;
    name: string;
    icon: string | null;
    chainId: string;
    decimals: number;
    residency?: string;
    lockedBalance?: string;
}

interface Asset {
    id: string;
    name: string;
    symbol: string;
    icon: string;
    networks: Network[];
}

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
}

// List item types (for display only)
interface TokenListItem extends SelectListItem {
    assetId: string;
    assetName: string;
    networks: Network[];
    networkCount: number;
    totalBalance?: number;
    totalBalanceUSD?: number;
}

interface NetworkListItem extends SelectListItem {
    networkId: string;
    networkName: string;
    chainId: string;
    networkIcon: string | null;
    decimals: number;
    balance?: string;
    balanceUSD?: number;
    residency?: string;
    lockedBalance?: string;
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
}

export default function TokenSelect({
    selectedToken,
    setSelectedToken,
    disabled,
    locked,
    lockedTokenData,
    classNames,
    showOnlyOwnedAssets = false,
    iconSize = "md",
}: TokenSelectProps) {
    const { treasuryId } = useTreasury();
    const { data: { tokens: treasuryAssets = [] } = {} } = useAssets(
        treasuryId,
        {
            onlyPositiveBalance: false,
            onlySupportedTokens: true,
        },
    );
    const aggregatedTreasuryTokens = useAggregatedTokens(treasuryAssets);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
    const [step, setStep] = useState<"token" | "network">("token");

    const { data: assets = [], isLoading } = useBridgeTokens(
        !showOnlyOwnedAssets && open,
    );

    // Auto-select first token
    useEffect(() => {
        if (treasuryAssets.length > 0 && !selectedToken && !locked) {
            const firstToken = treasuryAssets[0];
            setSelectedToken({
                address: firstToken.id,
                symbol: firstToken.symbol,
                decimals: firstToken.decimals,
                name: firstToken.name || firstToken.symbol,
                icon: firstToken.icon,
                network: firstToken.network,
                chainIcons: firstToken.chainIcons,
                residency: firstToken.residency,
            });
        }
    }, [treasuryAssets, selectedToken, locked, setSelectedToken]);

    const { yourAssets, otherAssets, hasAnyBalance } = useMemo(() => {
        const searchLower = search.toLowerCase();

        const ownedTokensMap = new Map(
            aggregatedTreasuryTokens.map((token) => [token.symbol, token]),
        );
        const bridgeAssetsMap = new Map(
            assets.map((asset) => [asset.symbol, asset]),
        );

        // Helper function to map treasury network to Network object
        const mapTreasuryNetwork = (n: any) => ({
            id: n.id,
            name: n.network,
            icon: n.chainIcons?.light || null,
            chainId: n.network,
            decimals: n.decimals,
            residency: n.residency,
            lockedBalance:
                n.balance.type === "Standard"
                    ? n.balance.locked.toFixed(0)
                    : undefined,
            balance: n.availableBalanceRaw,
            balanceUSD: n.availableBalanceUSD,
        });

        // 1. Process owned assets with bridge data overlay
        const ownedAssets = aggregatedTreasuryTokens
            .filter(
                (token) =>
                    token.symbol.toLowerCase().includes(searchLower) ||
                    token.name?.toLowerCase().includes(searchLower),
            )
            .map((treasuryToken): TokenListItem | null => {
                const bridgeAsset = bridgeAssetsMap.get(treasuryToken.symbol);

                // Fallback: Treasury-only token (not in bridge API)
                if (!bridgeAsset) {
                    return {
                        id: treasuryToken.symbol,
                        name:
                            treasuryToken.name +
                            (treasuryToken.isAggregated &&
                            treasuryToken.networks.length > 1
                                ? ` • ${treasuryToken.networks.length} Networks`
                                : ""),
                        symbol: treasuryToken.symbol,
                        icon: treasuryToken.icon,
                        assetId: treasuryToken.symbol,
                        assetName: treasuryToken.name,
                        networks:
                            treasuryToken.networks.map(mapTreasuryNetwork),
                        networkCount: treasuryToken.networks.length,
                        totalBalance: Number(
                            treasuryToken.availableTotalBalance,
                        ),
                        totalBalanceUSD: treasuryToken.availableTotalBalanceUSD,
                    };
                }

                // Create lookup maps for treasury networks
                const treasuryNetworksByIdMap = new Map(
                    treasuryToken.networks.map((n) => [n.id, n]),
                );
                const treasuryNetworksByChainMap = new Map(
                    treasuryToken.networks.map((n) => [n.network, n]),
                );

                // Track matched treasury networks to avoid duplicates
                const matchedTreasuryNetworkIds = new Set<string>();

                // Merge bridge networks with treasury balance data
                const mergedNetworks = bridgeAsset.networks.map(
                    (bridgeNetwork) => {
                        const treasuryNetwork =
                            treasuryNetworksByIdMap.get(bridgeNetwork.id) ||
                            treasuryNetworksByChainMap.get(
                                bridgeNetwork.chainId,
                            );

                        if (treasuryNetwork) {
                            matchedTreasuryNetworkIds.add(treasuryNetwork.id);
                        }

                        return {
                            id: bridgeNetwork.id,
                            name: bridgeNetwork.name,
                            icon: bridgeNetwork.icon,
                            chainId: bridgeNetwork.chainId,
                            decimals: bridgeNetwork.decimals,
                            residency: treasuryNetwork?.residency,
                            lockedBalance:
                                treasuryNetwork?.balance.type === "Standard"
                                    ? treasuryNetwork.balance.locked.toFixed(0)
                                    : undefined,
                            ...(treasuryNetwork && {
                                balance: treasuryNetwork.availableBalanceRaw,
                                balanceUSD: treasuryNetwork.availableBalanceUSD,
                            }),
                        } as Network & {
                            balance?: string;
                            balanceUSD?: number;
                        };
                    },
                );

                // Add unmatched treasury networks
                treasuryToken.networks.forEach((tn) => {
                    if (!matchedTreasuryNetworkIds.has(tn.id)) {
                        mergedNetworks.push(mapTreasuryNetwork(tn));
                    }
                });

                return {
                    id: treasuryToken.symbol,
                    name:
                        treasuryToken.name +
                        (mergedNetworks.length > 1
                            ? ` • ${mergedNetworks.length} Networks`
                            : ""),
                    symbol: treasuryToken.symbol,
                    icon: treasuryToken.icon,
                    assetId: bridgeAsset.id,
                    assetName: bridgeAsset.name,
                    networks: mergedNetworks,
                    networkCount: mergedNetworks.length,
                    totalBalance: Number(treasuryToken.availableTotalBalance),
                    totalBalanceUSD: treasuryToken.availableTotalBalanceUSD,
                };
            })
            .filter((item): item is TokenListItem => item !== null)
            .sort((a, b) => {
                // Sort by USD value descending (highest first)
                const aUSD = a.totalBalanceUSD || 0;
                const bUSD = b.totalBalanceUSD || 0;
                return bUSD - aUSD;
            });

        // 2. Early return for showOnlyOwnedAssets
        if (showOnlyOwnedAssets) {
            return {
                yourAssets: ownedAssets,
                otherAssets: [],
                hasAnyBalance: ownedAssets.length > 0,
            };
        }

        // 3. Process other assets (not owned)
        const otherAssetsFiltered = assets
            .filter(
                (token) =>
                    !ownedTokensMap.has(token.symbol) &&
                    (token.symbol.toLowerCase().includes(searchLower) ||
                        token.name?.toLowerCase().includes(searchLower)),
            )
            .map(
                (token): TokenListItem => ({
                    id: token.symbol,
                    name:
                        token.name +
                        (token.networks.length > 1
                            ? ` • ${token.networks.length} Networks`
                            : ""),
                    symbol: token.symbol,
                    icon: token.icon,
                    assetId: token.id,
                    assetName: token.name,
                    networks: token.networks,
                    networkCount: token.networks.length,
                    totalBalance: undefined,
                    totalBalanceUSD: undefined,
                }),
            )
            .sort((a, b) => a.symbol!.localeCompare(b.symbol!));

        return {
            yourAssets: ownedAssets,
            otherAssets: otherAssetsFiltered,
            hasAnyBalance: ownedAssets.length > 0,
        };
    }, [assets, search, showOnlyOwnedAssets, aggregatedTreasuryTokens]);

    const networkItems = useMemo(() => {
        if (!selectedAsset) return [];

        const items = selectedAsset.networks.map(
            (network: Network, idx: number): NetworkListItem => {
                const treasuryNetwork = network as any;
                const balance = treasuryNetwork.balance?.toString();
                const balanceUSD = treasuryNetwork.balanceUSD;

                return {
                    id: `${network.chainId}-${idx}`,
                    name: network.name,
                    symbol: selectedAsset.symbol,
                    icon: selectedAsset.icon,
                    networkId: network.id,
                    networkName: network.name,
                    chainId: network.chainId,
                    networkIcon: network.icon,
                    decimals: network.decimals,
                    balance,
                    balanceUSD,
                    residency: network.residency,
                    lockedBalance: network.lockedBalance,
                };
            },
        );

        // Sort networks: ones with balance first (by USD value), then alphabetically
        items.sort((a, b) => {
            const aBalanceUSD = a.balanceUSD || 0;
            const bBalanceUSD = b.balanceUSD || 0;

            if (aBalanceUSD > 0 === bBalanceUSD > 0) {
                if (aBalanceUSD !== bBalanceUSD) {
                    return bBalanceUSD - aBalanceUSD;
                }
                return a.name.localeCompare(b.name);
            }

            return bBalanceUSD > 0 ? 1 : -1;
        });

        return items;
    }, [selectedAsset]);

    const handleTokenClick = useCallback((item: TokenListItem) => {
        setSelectedAsset({
            id: item.assetId,
            name: item.assetName,
            symbol: item.symbol!,
            icon: item.icon,
            networks: item.networks,
        });
        setStep("network");
    }, []);

    const handleNetworkClick = useCallback(
        (item: NetworkListItem) => {
            if (!selectedAsset) return;

            // Check if this is a treasury token (has residency defined and not "Intents")
            const isTreasuryToken =
                item.residency && item.residency !== "Intents";

            if (isTreasuryToken) {
                // Treasury token
                const treasuryToken = aggregatedTreasuryTokens
                    .flatMap((t) => t.networks)
                    .find((n) => n.id === item.networkId);

                if (treasuryToken) {
                    setSelectedToken({
                        address: treasuryToken.id,
                        symbol: treasuryToken.symbol,
                        decimals: treasuryToken.decimals,
                        name: treasuryToken.name || treasuryToken.symbol,
                        icon: treasuryToken.icon,
                        network: treasuryToken.network,
                        chainIcons: treasuryToken.chainIcons,
                        residency: treasuryToken.residency,
                    });
                }
            } else {
                // Bridge/Intents token
                let balance:
                    | { type: "Standard"; total: Big; locked: Big }
                    | undefined;
                if (item.balance && item.balance !== "0") {
                    try {
                        balance = {
                            type: "Standard",
                            total: Big(item.balance),
                            locked: Big(0),
                        };
                    } catch {
                        balance = undefined;
                    }
                }

                setSelectedToken({
                    address: item.networkId,
                    symbol: selectedAsset.symbol,
                    decimals: item.decimals,
                    name: selectedAsset.name,
                    icon: selectedAsset.icon,
                    network: item.networkName,
                    chainIcons: item.networkIcon
                        ? { light: item.networkIcon, dark: item.networkIcon }
                        : undefined,
                    residency: "Intents",
                });
            }

            setOpen(false);
            setSearch("");
            setStep("token");
            setSelectedAsset(null);
        },
        [selectedAsset, aggregatedTreasuryTokens, setSelectedToken],
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

    const renderNetworkIcon = useCallback(
        (networkIcon: string | null, networkName: string) => {
            if (!networkIcon) {
                return (
                    <div className="size-6 rounded-full bg-gradient-cyan-blue flex items-center justify-center text-white text-xs font-bold">
                        {networkName.charAt(0)}
                    </div>
                );
            }
            return (
                <img
                    src={networkIcon}
                    alt={`${networkName} network`}
                    className="size-6"
                />
            );
        },
        [],
    );

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

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild disabled={disabled}>
                <Button
                    type="button"
                    variant="outline"
                    className={cn(
                        "bg-card hover:bg-card hover:border-muted-foreground rounded-full py-1 px-3 justify-start",
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
                            Select token
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
                                ? "Select Asset"
                                : `Select network for ${selectedAsset?.symbol}`}
                        </DialogTitle>
                    </div>
                </DialogHeader>
                {step === "token" && (
                    <div className="space-y-4">
                        <Input
                            placeholder="Search by name"
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
                                {showOnlyOwnedAssets ? (
                                    <>
                                        {yourAssets.map((token) => (
                                            <Button
                                                key={token.id}
                                                onClick={() =>
                                                    handleTokenClick(token)
                                                }
                                                variant="ghost"
                                                type="button"
                                                className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                                            >
                                                <SelectListIcon
                                                    icon={token.icon}
                                                    gradient={token.gradient}
                                                    alt={
                                                        token.symbol ||
                                                        token.name
                                                    }
                                                />
                                                <div className="flex-1 text-left">
                                                    <div className="font-semibold">
                                                        {token.symbol ||
                                                            token.name}
                                                    </div>
                                                    {token.symbol && (
                                                        <div className="text-sm text-muted-foreground">
                                                            {token.name}
                                                        </div>
                                                    )}
                                                </div>
                                                {token.totalBalance !==
                                                    undefined &&
                                                    token.totalBalance > 0 && (
                                                        <div className="flex flex-col items-end">
                                                            <span className="font-semibold">
                                                                {token.totalBalance.toFixed(
                                                                    2,
                                                                )}
                                                            </span>
                                                            <span className="text-sm text-muted-foreground">
                                                                ≈$
                                                                {token.totalBalanceUSD?.toFixed(
                                                                    2,
                                                                ) || "0.00"}
                                                            </span>
                                                        </div>
                                                    )}
                                            </Button>
                                        ))}
                                        {yourAssets.length === 0 && (
                                            <div className="text-center py-8 text-muted-foreground">
                                                No tokens with balance found
                                            </div>
                                        )}
                                    </>
                                ) : hasAnyBalance ? (
                                    <>
                                        {yourAssets.length > 0 && (
                                            <div className="mb-4">
                                                <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                                                    Your Asset
                                                </div>
                                                {yourAssets.map((token) => (
                                                    <Button
                                                        key={token.id}
                                                        onClick={() =>
                                                            handleTokenClick(
                                                                token,
                                                            )
                                                        }
                                                        variant="ghost"
                                                        type="button"
                                                        className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                                                    >
                                                        <SelectListIcon
                                                            icon={token.icon}
                                                            gradient={
                                                                token.gradient
                                                            }
                                                            alt={
                                                                token.symbol ||
                                                                token.name
                                                            }
                                                        />
                                                        <div className="flex-1 text-left">
                                                            <div className="font-semibold">
                                                                {token.symbol ||
                                                                    token.name}
                                                            </div>
                                                            {token.symbol && (
                                                                <div className="text-sm text-muted-foreground">
                                                                    {token.name}
                                                                </div>
                                                            )}
                                                        </div>
                                                        {token.totalBalance !==
                                                            undefined &&
                                                            token.totalBalance >
                                                                0 && (
                                                                <div className="flex flex-col items-end">
                                                                    <span className="font-semibold">
                                                                        {token.totalBalance.toFixed(
                                                                            2,
                                                                        )}
                                                                    </span>
                                                                    <span className="text-sm text-muted-foreground">
                                                                        ≈$
                                                                        {token.totalBalanceUSD?.toFixed(
                                                                            2,
                                                                        ) ||
                                                                            "0.00"}
                                                                    </span>
                                                                </div>
                                                            )}
                                                    </Button>
                                                ))}
                                            </div>
                                        )}

                                        {otherAssets.length > 0 && (
                                            <div>
                                                <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                                                    Other Asset
                                                </div>
                                                {otherAssets.map((token) => (
                                                    <Button
                                                        key={token.id}
                                                        onClick={() =>
                                                            handleTokenClick(
                                                                token,
                                                            )
                                                        }
                                                        variant="ghost"
                                                        type="button"
                                                        className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                                                    >
                                                        <SelectListIcon
                                                            icon={token.icon}
                                                            gradient={
                                                                token.gradient
                                                            }
                                                            alt={
                                                                token.symbol ||
                                                                token.name
                                                            }
                                                        />
                                                        <div className="flex-1 text-left">
                                                            <div className="font-semibold">
                                                                {token.symbol ||
                                                                    token.name}
                                                            </div>
                                                            {token.symbol && (
                                                                <div className="text-sm text-muted-foreground">
                                                                    {token.name}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </Button>
                                                ))}
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        {otherAssets.map((token) => (
                                            <Button
                                                key={token.id}
                                                onClick={() =>
                                                    handleTokenClick(token)
                                                }
                                                variant="ghost"
                                                type="button"
                                                className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                                            >
                                                <SelectListIcon
                                                    icon={token.icon}
                                                    gradient={token.gradient}
                                                    alt={
                                                        token.symbol ||
                                                        token.name
                                                    }
                                                />
                                                <div className="flex-1 text-left">
                                                    <div className="font-semibold">
                                                        {token.symbol ||
                                                            token.name}
                                                    </div>
                                                    {token.symbol && (
                                                        <div className="text-sm text-muted-foreground">
                                                            {token.name}
                                                        </div>
                                                    )}
                                                </div>
                                            </Button>
                                        ))}
                                    </>
                                )}
                                {yourAssets.length === 0 &&
                                    otherAssets.length === 0 && (
                                        <div className="text-center py-8 text-muted-foreground">
                                            No tokens found
                                        </div>
                                    )}
                            </ScrollArea>
                        )}
                    </div>
                )}
                {step === "network" && selectedAsset && (
                    <ScrollArea className="h-[400px]">
                        {networkItems.map((item) => (
                            <Button
                                key={item.id}
                                onClick={() => handleNetworkClick(item)}
                                variant="ghost"
                                type="button"
                                className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                            >
                                <div className="pl-3 w-full">
                                    <div className="flex items-center gap-3">
                                        {renderNetworkIcon(
                                            item.networkIcon,
                                            item.name,
                                        )}
                                        <div className="flex flex-col text-left">
                                            <span className="font-semibold capitalize">
                                                {item.name}
                                            </span>
                                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                                                <span>
                                                    {item.residency === "Ft"
                                                        ? "Fungible Token"
                                                        : item.residency ===
                                                            "Near"
                                                          ? "Native Token"
                                                          : "Intents Token"}
                                                </span>
                                                {item.residency === "Near" &&
                                                    item.lockedBalance && (
                                                        <Tooltip
                                                            content={
                                                                <p className="inline-block">
                                                                    Available
                                                                    balance
                                                                    after
                                                                    locking{" "}
                                                                    <span className="font-semibold">
                                                                        {formatNearAmount(
                                                                            item.lockedBalance,
                                                                        )}{" "}
                                                                        NEAR
                                                                    </span>{" "}
                                                                    for account
                                                                    activity
                                                                </p>
                                                            }
                                                            side="bottom"
                                                        >
                                                            <span
                                                                className="inline-flex"
                                                                onClick={(e) =>
                                                                    e.stopPropagation()
                                                                }
                                                            >
                                                                <Info className="size-3" />
                                                            </span>
                                                        </Tooltip>
                                                    )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex-1" />
                                {item.balance &&
                                    item.decimals !== undefined &&
                                    item.balance.trim() !== "" &&
                                    (() => {
                                        const balanceFormatted = Big(
                                            formatBalance(
                                                item.balance,
                                                item.decimals,
                                            ),
                                        ).toFixed(2);
                                        if (Big(balanceFormatted).eq(0))
                                            return null;

                                        return (
                                            <div className="flex flex-col items-end">
                                                <span className="font-semibold">
                                                    {balanceFormatted}
                                                </span>
                                                <span className="text-sm text-muted-foreground">
                                                    ≈$
                                                    {item.balanceUSD?.toFixed(
                                                        2,
                                                    ) || "0.00"}
                                                </span>
                                            </div>
                                        );
                                    })()}
                            </Button>
                        ))}
                    </ScrollArea>
                )}
            </DialogContent>
        </Dialog>
    );
}

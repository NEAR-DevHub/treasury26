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
import { totalBalance } from "@/lib/balance";
import { fetchBridgeTokens } from "@/lib/bridge-api";
import { useThemeStore } from "@/stores/theme-store";
import { useTreasury } from "@/hooks/use-treasury";
import { useAssets } from "@/hooks/use-assets";
import { useAggregatedTokens } from "@/hooks/use-assets";
import { Input } from "./input";
import { SelectListIcon } from "./select-list";
import { Tooltip } from "./tooltip";
import { ScrollArea } from "./ui/scroll-area";
import Big from "big.js";

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
  residency?: string; // "Ft", "Intents", or "Near" - optional since bridge API networks is Intents
  lockedBalance?: string; // For Native Token - optional
}

interface Asset {
  id: string;
  name: string;
  symbol: string;
  icon: string;
  networks: Network[];
}

// Selected token (asset + specific network)
export interface BridgeToken {
  id: string; // Network's intents_token_id
  symbol: string; // Asset symbol (e.g., "USDC")
  name: string; // Asset name (e.g., "USD Coin")
  icon: string; // Asset icon
  network: string; // Network name (e.g., "Ethereum")
  networkIcon: string | null;
  chainId: string; // Chain ID (e.g., "eth:1")
  decimals: number;
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

interface BridgeTokenSelectProps {
  selectedToken: BridgeToken | null;
  setSelectedToken: (token: BridgeToken) => void;
  disabled?: boolean;
  locked?: boolean;
  classNames?: {
    trigger?: string;
  };
  /**
   * When true, only shows assets that the user owns (has balance > 0).
   * When false, shows all assets with separation between "Your Asset" and "Other Asset".
   * Default: false
   */
  showOnlyOwnedAssets?: boolean;
}

// Helper to check if icon is an image URL
const isImageIcon = (icon: string): boolean =>
  icon.startsWith("data:image") || icon.startsWith("http");

/**
 * BridgeTokenSelect - A token selector for bridge/cross-chain assets
 *
 * @param selectedToken - Currently selected token (or null)
 * @param setSelectedToken - Callback when a token is selected
 * @param disabled - Whether the selector is disabled
 * @param classNames - Optional CSS classes for styling
 */
export default function BridgeTokenSelect({
  selectedToken,
  setSelectedToken,
  disabled,
  locked,
  classNames,
  showOnlyOwnedAssets = false,
}: BridgeTokenSelectProps) {
  const { treasuryId } = useTreasury();
  const { data: { tokens: treasuryAssets = [] } = {} } = useAssets(treasuryId, {
    onlyPositiveBalance: false,
    onlySupportedTokens: true,
  });
  const aggregatedTreasuryTokens = useAggregatedTokens(treasuryAssets);
  const { theme } = useThemeStore();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [step, setStep] = useState<"token" | "network">("token");

  // Fetch all available assets from bridge API
  useEffect(() => {
    const fetchAssets = async () => {
      // Skip fetching bridge assets if we only need owned assets
      if (showOnlyOwnedAssets) {
        setIsLoading(false);
        return;
      }

      if (!open) return;

      setIsLoading(true);
      try {
        const fetchedAssets = await fetchBridgeTokens(theme);
        const formattedAssets: Asset[] = fetchedAssets.map((asset: any) => {
          const hasValidIcon =
            asset.icon &&
            (asset.icon.startsWith("http") ||
              asset.icon.startsWith("data:") ||
              asset.icon.startsWith("/"));

          return {
            id: asset.id,
            name: asset.name || asset.assetName,
            symbol: asset.symbol === "wNEAR" ? "NEAR" : asset.symbol,
            icon: hasValidIcon ? asset.icon : asset.symbol?.charAt(0) || "?",
            networks: asset.networks,
          };
        });

        setAssets(formattedAssets);
      } catch (error) {
        console.error("Error fetching bridge tokens:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchAssets();
  }, [open, theme, showOnlyOwnedAssets]);

  const { yourAssets, otherAssets, hasAnyBalance } = useMemo(() => {
    const searchLower = search.toLowerCase();

    const ownedTokensMap = new Map(
      aggregatedTreasuryTokens.map((token) => [token.symbol, token])
    );
    const bridgeAssetsMap = new Map(
      assets.map((asset) => [asset.symbol, asset])
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
      balance: totalBalance(n.balance).toString(),
      balanceUSD: n.balanceUSD,
    });

    // 1. Process owned assets with bridge data overlay
    const ownedAssets = aggregatedTreasuryTokens
      .filter(
        (token) =>
          token.symbol.toLowerCase().includes(searchLower) ||
          token.name?.toLowerCase().includes(searchLower)
      )
      .map((treasuryToken): TokenListItem | null => {
        const bridgeAsset = bridgeAssetsMap.get(treasuryToken.symbol);

        // Fallback: Treasury-only token (not in bridge API) -> eg: FT token on NEAR blockchain
        if (!bridgeAsset) {
          return {
            id: treasuryToken.symbol,
            name:
              treasuryToken.name +
              (treasuryToken.isAggregated && treasuryToken.networks.length > 1
                ? ` • ${treasuryToken.networks.length} Networks`
                : ""),
            symbol: treasuryToken.symbol,
            icon: treasuryToken.icon,
            assetId: treasuryToken.symbol,
            assetName: treasuryToken.name,
            networks: treasuryToken.networks.map(mapTreasuryNetwork),
            networkCount: treasuryToken.networks.length,
            totalBalance: Number(treasuryToken.totalBalance),
            totalBalanceUSD: treasuryToken.totalBalanceUSD,
          };
        }

        // Create lookup maps for treasury networks (only once per token)
        const treasuryNetworksByIdMap = new Map(
          treasuryToken.networks.map((n) => [n.id, n])
        );
        const treasuryNetworksByChainMap = new Map(
          treasuryToken.networks.map((n) => [n.network, n])
        );

        // Track matched treasury networks to avoid duplicates
        const matchedTreasuryNetworkIds = new Set<string>();

        // Merge bridge networks with treasury balance data
        const mergedNetworks = bridgeAsset.networks.map((bridgeNetwork) => {
          const treasuryNetwork =
            treasuryNetworksByIdMap.get(bridgeNetwork.id) ||
            treasuryNetworksByChainMap.get(bridgeNetwork.chainId);

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
              balance: totalBalance(treasuryNetwork.balance).toString(),
              balanceUSD: treasuryNetwork.balanceUSD,
            }),
          } as Network & { balance?: string; balanceUSD?: number };
        });

        // Add unmatched treasury networks (different residencies on same chain)
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
          totalBalance: Number(treasuryToken.totalBalance),
          totalBalanceUSD: treasuryToken.totalBalanceUSD,
        };
      })
      .filter((item): item is TokenListItem => item !== null);

    // 2. Early return for showOnlyOwnedAssets
    if (showOnlyOwnedAssets) {
      return {
        yourAssets: ownedAssets,
        otherAssets: [],
        hasAnyBalance: ownedAssets.length > 0,
      };
    }

    // 3. Process other assets (not owned) - already sorted by search
    const otherAssetsFiltered = assets
      .filter(
        (token) =>
          !ownedTokensMap.has(token.symbol) &&
          (token.symbol.toLowerCase().includes(searchLower) ||
            token.name?.toLowerCase().includes(searchLower))
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
        })
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
        // Treasury token networks (from aggregatedTreasuryTokens) have balance and residency info
        // Bridge token networks don't have these
        const treasuryNetwork = network as any; // May have TreasuryAsset properties for balance
        const balance = treasuryNetwork.balance?.toString();
        const balanceUSD = treasuryNetwork.balanceUSD;

        return {
          id: `${network.chainId}-${idx}`,
          name: network.name,
          symbol: selectedAsset.symbol,
          icon: selectedAsset.icon,
          // Network properties
          networkId: network.id,
          networkName: network.name,
          chainId: network.chainId,
          networkIcon: network.icon,
          decimals: network.decimals,
          // Balance and residency properties (only present for owned assets)
          balance,
          balanceUSD,
          residency: network.residency, // From Network interface
          lockedBalance: network.lockedBalance, // From Network interface
        };
      }
    );

    // Sort networks: ones with balance first, then alphabetically by name
    items.sort((a, b) => {
      const aHasBalance = !!a.balance && parseFloat(a.balance) > 0;
      const bHasBalance = !!b.balance && parseFloat(b.balance) > 0;

      // If both have balance or both don't have balance, sort alphabetically
      if (aHasBalance === bHasBalance) {
        return a.name.localeCompare(b.name);
      }

      // Networks with balance come first
      return bHasBalance ? 1 : -1;
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

      setSelectedToken({
        id: item.networkId,
        symbol: selectedAsset.symbol,
        name: selectedAsset.name,
        icon: selectedAsset.icon,
        network: item.networkName,
        networkIcon: item.networkIcon,
        chainId: item.chainId,
        decimals: item.decimals,
      });
      setOpen(false);
      setSearch("");
      setStep("token");
      setSelectedAsset(null);
    },
    [selectedAsset, setSelectedToken]
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

  const renderBaseTokenIcon = useCallback(
    (icon: string, symbol: string, size: "sm" | "base" = "base") => {
      const sizeClass = size === "sm" ? "size-5" : "size-6";

      if (isImageIcon(icon)) {
        return (
          <img
            src={icon}
            alt={symbol}
            className={`${sizeClass} rounded-full shrink-0`}
          />
        );
      }
      return (
        <div
          className={`${sizeClass} rounded-full bg-blue-600 flex items-center justify-center text-xs shrink-0`}
        >
          {icon}
        </div>
      );
    },
    []
  );

  // Render token with network badge overlay
  const renderTokenWithNetworkBadge = useCallback(
    (tokenIcon: string, symbol: string, networkIcon: string | null) => {
      return (
        <div className="relative flex">
          {renderBaseTokenIcon(tokenIcon, symbol, "sm")}
          {networkIcon && (
            <div className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-muted border border-border">
              <img
                src={networkIcon}
                alt="network"
                className="size-3 shrink-0 p-0.5"
              />
            </div>
          )}
        </div>
      );
    },
    [renderBaseTokenIcon]
  );

  // Get network type label based on residency
  const getNetworkType = useCallback((residency?: string): string => {
    if (!residency) {
      // Fallback for bridge tokens that don't have residency info
      return "Intents Token";
    }

    switch (residency) {
      case "Ft":
        return "Fungible Token";
      case "Intents":
        return "Intents Token";
      case "Near":
      return "Native Token";
      default:
        return "Intents Token";
    }
  }, []);

  // Render network icon with fallback
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
    []
  );

  // Render locked state
  if (locked && selectedToken) {
    return (
      <div className="flex gap-2 items-center h-9 px-4 py-2 has-[>svg]:px-3 bg-card rounded-full cursor-default hover:bg-card hover:border-border">
        {renderTokenWithNetworkBadge(
          selectedToken.icon,
          selectedToken.symbol,
          selectedToken.networkIcon
        )}
        <div className="flex flex-col items-start">
          <span className="font-semibold text-sm leading-none">
            {selectedToken.symbol}
          </span>
          <span className="text-xxs font-normal text-muted-foreground uppercase">
            {selectedToken.network}
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
            "bg-card hover:bg-card hover:border-muted-foreground rounded-full py-1 px-3",
            classNames?.trigger
          )}
        >
          {selectedToken ? (
            <>
              {renderTokenWithNetworkBadge(
                selectedToken.icon,
                selectedToken.symbol,
                selectedToken.networkIcon
              )}
              <div className="flex flex-col items-start">
                <span className="font-semibold text-sm leading-none">
                  {selectedToken.symbol}
                </span>
              <span className="text-xxs font-normal text-muted-foreground uppercase">
                  {selectedToken.network}
                </span>
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">Select token</span>
          )}
          <ChevronDown className="size-4 text-muted-foreground" />
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
                  // Show only owned assets without section headers
                  <>
                    {yourAssets.map((token) => (
                      <Button
                        key={token.id}
                        onClick={() => handleTokenClick(token)}
                        variant="ghost"
                        type="button"
                        className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                      >
                        <SelectListIcon
                          icon={token.icon}
                          gradient={token.gradient}
                          alt={token.symbol || token.name}
                        />
                        <div className="flex-1 text-left">
                          <div className="font-semibold">
                            {token.symbol || token.name}
                          </div>
                          {token.symbol && (
                            <div className="text-sm text-muted-foreground">
                              {token.name}
                            </div>
                          )}
                        </div>
                        {token.totalBalance !== undefined &&
                          token.totalBalance > 0 && (
                          <div className="flex flex-col items-end">
                            <span className="font-semibold">
                                {token.totalBalance.toFixed(2)}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              ≈${token.totalBalanceUSD?.toFixed(2) || "0.00"}
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
                    {/* Your Assets Section */}
                    {yourAssets.length > 0 && (
                      <div className="mb-4">
                        <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                          Your Asset
                        </div>
                        {yourAssets.map((token) => (
                          <Button
                            key={token.id}
                            onClick={() => handleTokenClick(token)}
                            variant="ghost"
                            type="button"
                            className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                          >
                            <SelectListIcon
                              icon={token.icon}
                              gradient={token.gradient}
                              alt={token.symbol || token.name}
                            />
                            <div className="flex-1 text-left">
                              <div className="font-semibold">
                                {token.symbol || token.name}
                              </div>
                              {token.symbol && (
                                <div className="text-sm text-muted-foreground">
                                  {token.name}
                                </div>
                              )}
                            </div>
                            {token.totalBalance !== undefined &&
                              token.totalBalance > 0 && (
                                <div className="flex flex-col items-end">
                                  <span className="font-semibold">
                                    {token.totalBalance.toFixed(2)}
                                  </span>
                                  <span className="text-sm text-muted-foreground">
                                    ≈$
                                    {token.totalBalanceUSD?.toFixed(2) ||
                                      "0.00"}
                                  </span>
                                </div>
                              )}
                          </Button>
                        ))}
                      </div>
                    )}

                    {/* Other Assets Section */}
                    {otherAssets.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                          Other Asset
                        </div>
                        {otherAssets.map((token) => (
                          <Button
                            key={token.id}
                            onClick={() => handleTokenClick(token)}
                            variant="ghost"
                            type="button"
                            className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                          >
                            <SelectListIcon
                              icon={token.icon}
                              gradient={token.gradient}
                              alt={token.symbol || token.name}
                            />
                            <div className="flex-1 text-left">
                              <div className="font-semibold">
                                {token.symbol || token.name}
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
                  // No balance - show all tokens alphabetically without separation
                  <>
                    {otherAssets.map((token) => (
                      <Button
                        key={token.id}
                        onClick={() => handleTokenClick(token)}
                        variant="ghost"
                        type="button"
                        className="w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!"
                      >
                        <SelectListIcon
                          icon={token.icon}
                          gradient={token.gradient}
                          alt={token.symbol || token.name}
                        />
                        <div className="flex-1 text-left">
                          <div className="font-semibold">
                            {token.symbol || token.name}
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
                {yourAssets.length === 0 && otherAssets.length === 0 && (
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
                  {renderNetworkIcon(item.networkIcon, item.name)}
                  <div className="flex flex-col text-left">
                    <span className="font-semibold capitalize">
                      {item.name}
                    </span>
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <span>{getNetworkType(item.residency)}</span>
                        {item.residency === "Near" && item.lockedBalance && (
                          <Tooltip
                            content={
                              <p className="inline-block">
                                Available balance after locking{" "}
                                <span className="font-semibold">
                                  {formatNearAmount(item.lockedBalance)} NEAR
                                </span>{" "}
                                for account activity
                              </p>
                            }
                            side="bottom"
                          >
                            <span
                              className="inline-flex"
                              onClick={(e) => e.stopPropagation()}
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
                      formatBalance(item.balance, item.decimals)
                    ).toFixed(2);
                    if (Big(balanceFormatted).eq(0)) return null;

                    return (
                      <div className="flex flex-col items-end">
                        <span className="font-semibold">
                          {balanceFormatted}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          ≈${item.balanceUSD?.toFixed(2) || "0.00"}
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

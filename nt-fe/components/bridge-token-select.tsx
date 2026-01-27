"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./modal";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { Button } from "./button";
import { cn, formatBalance } from "@/lib/utils";
import { fetchBridgeTokens } from "@/lib/bridge-api";
import { useThemeStore } from "@/stores/theme-store";
import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryAssets } from "@/hooks/use-treasury-queries";
import { Input } from "./input";
import { SelectList, SelectListItem } from "./select-list";
import Big from "big.js";

// Core data types
interface Network {
  id: string;
  name: string;
  icon: string | null;
  chainId: string;
  decimals: number;
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
}

interface BridgeTokenSelectProps {
  selectedToken: BridgeToken | null;
  setSelectedToken: (token: BridgeToken) => void;
  disabled?: boolean;
  classNames?: {
    trigger?: string;
  };
}

// Helper to check if icon is an image URL
const isImageIcon = (icon: string): boolean =>
  icon.startsWith("data:image") || icon.startsWith("http");

export default function BridgeTokenSelect({
  selectedToken,
  setSelectedToken,
  disabled,
  classNames,
}: BridgeTokenSelectProps) {
  const { selectedTreasury } = useTreasury();
  const { data: { tokens: treasuryAssets = [] } = {} } =
    useTreasuryAssets(selectedTreasury);
  const { theme } = useThemeStore();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [step, setStep] = useState<"token" | "network">("token");

  // Create balance map from treasury assets
  const balanceMap = useMemo(() => {
    const map = new Map<
      string,
      { balance: string; balanceUSD: number; decimals: number }
    >();

    treasuryAssets.forEach((token) => {
      const tokenId = token.id;
      map.set(tokenId, {
        balance: token.balance.toString(),
        balanceUSD: token.balanceUSD,
        decimals: token.decimals,
      });
    });
    return map;
  }, [treasuryAssets]);

  // Fetch all available assets from bridge API
  useEffect(() => {
    const fetchAssets = async () => {
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
  }, [open, theme]);

  const filteredTokens = useMemo(() => {
    const filtered = assets.filter(
      (token) =>
        token.symbol.toLowerCase().includes(search.toLowerCase()) ||
        token.name?.toLowerCase().includes(search.toLowerCase())
    );
    return filtered.map((token): TokenListItem => {
      // Calculate total balance across all networks for this token
      let totalBalance = 0;
      let totalBalanceUSD = 0;

      if (balanceMap) {
        token.networks.forEach((network) => {
          const balanceData = balanceMap.get(network.id);
          if (balanceData) {
            const formattedBalance = Number(
              formatBalance(balanceData.balance, balanceData.decimals)
            );
            totalBalance += formattedBalance;
            totalBalanceUSD += balanceData.balanceUSD;
          } else {
          }
        });
      }

      return {
        id: token.symbol,
        name:
          token.name +
          (token.networks.length > 1
            ? ` • ${token.networks.length} Networks`
            : ""),
        symbol: token.symbol,
        icon: token.icon,
        // Asset properties
        assetId: token.id,
        assetName: token.name,
        networks: token.networks,
        // Display properties
        networkCount: token.networks.length,
        totalBalance: balanceMap ? totalBalance : undefined,
        totalBalanceUSD: balanceMap ? totalBalanceUSD : undefined,
      };
    });
  }, [assets, search, balanceMap]);

  const networkItems = useMemo(() => {
    if (!selectedAsset) return [];
    return selectedAsset.networks.map(
      (network: Network, idx: number): NetworkListItem => {
        const balanceData = balanceMap?.get(network.id);

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
          // Balance properties
          balance: balanceData?.balance,
          balanceUSD: balanceData?.balanceUSD,
        };
      }
    );
  }, [selectedAsset, balanceMap]);

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

  // Get network type label
  const getNetworkType = useCallback((chainId: string): string => {
    if (chainId.toLowerCase().includes("near:mainnet")) {
      return "Native Token";
    }
    return "Intents Token";
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild disabled={disabled}>
        <Button
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
                <span className="text-[10px] font-normal text-muted-foreground uppercase">
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
              <Button variant="ghost" size="icon" onClick={handleBack}>
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
              <div className="flex items-center justify-center py-8">
                <div className="text-muted-foreground">Loading assets...</div>
              </div>
            ) : (
              <SelectList
                items={filteredTokens}
                onSelect={handleTokenClick}
                emptyMessage="No tokens found"
                renderRight={
                  balanceMap
                    ? (token) =>
                        token.totalBalance !== undefined &&
                        token.totalBalance > 0 ? (
                          <div className="flex flex-col items-end">
                            <span className="font-semibold">
                              {token.totalBalance.toLocaleString("en-US", {
                                maximumFractionDigits: 20,
                              })}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              ≈${token.totalBalanceUSD?.toFixed(2) || "0.00"}
                            </span>
                          </div>
                        ) : null
                    : undefined
                }
              />
            )}
          </div>
        )}
        {step === "network" && selectedAsset && (
          <SelectList
            items={networkItems}
            onSelect={handleNetworkClick}
            renderIcon={(item) => (
              <div className="pl-3">
                <div className="flex items-center gap-3">
                  {renderNetworkIcon(item.networkIcon, item.name)}
                  <div className="flex flex-col text-left">
                    <span className="font-semibold capitalize">
                      {item.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {getNetworkType(item.chainId)}
                    </span>
                  </div>
                </div>
              </div>
            )}
            renderContent={() => <div className="flex-1" />}
            renderRight={
              balanceMap
                ? (item) => {
                    if (!item.balance || item.decimals === undefined)
                      return null;
                    const balanceNum = Big(
                      formatBalance(item.balance, item.decimals)
                    ).toNumber();
                    if (balanceNum === 0) return null;

                    return (
                      <div className="flex flex-col items-end">
                        <span className="font-semibold">
                          {balanceNum.toLocaleString("en-US", {
                            maximumFractionDigits: 20,
                          })}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          ≈${item.balanceUSD?.toFixed(2) || "0.00"}
                        </span>
                      </div>
                    );
                  }
                : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

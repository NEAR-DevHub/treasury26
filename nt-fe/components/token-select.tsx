"use client";

import { useTreasury } from "@/hooks/use-treasury";
import { useAssets } from "@/hooks/use-assets";
import { useEffect, useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./modal";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { Button } from "./button";
import { cn, formatBalance } from "@/lib/utils";
import { TreasuryAsset, ChainIcons } from "@/lib/api";
import { useAggregatedTokens, AggregatedAsset } from "@/hooks/use-assets";
import Big from "big.js";
import { NetworkDisplay } from "./token-display";
import { TokenDisplay } from "./token-display-with-network";
import { Input } from "./input";
import { SelectList, SelectListItem } from "./select-list";
import { availableBalance } from "@/lib/balance";

interface TokenListItem extends SelectListItem {
    totalBalance: number;
    totalBalanceUSD: number;
    networkCount?: number;
    _original: AggregatedAsset;
}

interface NetworkListItem extends SelectListItem {
    balance: string;
    balanceUSD: number;
    decimals: number;
    asset: TreasuryAsset;
}

interface TokenSelectProps {
    selectedToken: string | null;
    setSelectedToken: (token: TreasuryAsset) => void;
    disabled?: boolean;
    locked?: boolean;
    iconSize?: "sm" | "md" | "lg";
    classNames?: {
        trigger?: string;
    };
    lockedTokenData?: {
        symbol: string;
        icon: string;
        network: string;
        chainIcons?: ChainIcons;
    };
}


export default function TokenSelect({ selectedToken, setSelectedToken, disabled, locked, lockedTokenData, classNames }: TokenSelectProps) {
    const { treasuryId } = useTreasury();
    const { data: { tokens = [] } = {} } = useAssets(treasuryId, { onlyPositiveBalance: true, onlySupportedTokens: true });
    const aggregatedTokens = useAggregatedTokens(tokens);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedAggregatedToken, setSelectedAggregatedToken] = useState<AggregatedAsset | null>(null);
    const [step, setStep] = useState<'token' | 'network'>('token');

    useEffect(() => {
        if (tokens.length > 0 && !selectedToken && !locked) {
            setSelectedToken(tokens[0]);
        }
    }, [tokens, selectedToken, locked]);

    const filteredTokens = useMemo(() => {
        const filtered = aggregatedTokens.filter(token =>
            token.symbol.toLowerCase().includes(search.toLowerCase()) ||
            token.name?.toLowerCase().includes(search.toLowerCase())
        );
        return filtered.map((token): TokenListItem => ({
            id: token.symbol,
            name: token.name + (token.isAggregated && token.networks.length > 1 ? ` • ${token.networks.length} Networks` : ""),
            symbol: token.symbol,
            icon: token.icon,
            totalBalance: Number(token.totalBalance),
            totalBalanceUSD: Number(token.totalBalanceUSD),
            networkCount: token.networks.length,
            _original: token,
        }));
    }, [aggregatedTokens, search]);

    const networkItems = useMemo(() => {
        if (!selectedAggregatedToken) return [];
        return selectedAggregatedToken.networks.map((network, idx): NetworkListItem => ({
            id: `${network.symbol}-${idx}`,
            name: network.network,
            symbol: network.symbol,
            icon: network.icon,
            balance: availableBalance(network.balance).toString(),
            balanceUSD: network.balanceUSD,
            decimals: network.decimals,
            asset: network,
        }));
    }, [selectedAggregatedToken]);

    const selectedTokenData = tokens.find(t => t.symbol === selectedToken);
    const displayTokenData = locked && lockedTokenData ? lockedTokenData : selectedTokenData;

    const handleTokenClick = (item: TokenListItem) => {
        setSelectedAggregatedToken(item._original);
        setStep('network');
    };

    const handleNetworkClick = (item: NetworkListItem) => {
        setSelectedToken(item.asset);
        setOpen(false);
        setSearch("");
        setStep('token');
        setSelectedAggregatedToken(null);
    };

    const handleBack = () => {
        setStep('token');
        setSelectedAggregatedToken(null);
    };

    const handleOpenChange = (newOpen: boolean) => {
        setOpen(newOpen);
        if (!newOpen) {
            // Reset to step 1 when closing
            setStep('token');
            setSelectedAggregatedToken(null);
            setSearch("");
        }
    };

    if (locked && lockedTokenData) {
        return (
            <div className="flex gap-2 items-center h-9 px-4 py-2 has-[>svg]:px-3 bg-card rounded-full cursor-default hover:bg-card hover:border-border">
                <TokenDisplay
                    symbol={lockedTokenData.symbol}
                    icon={lockedTokenData.icon}
                    chainIcons={lockedTokenData.chainIcons}
                    iconSize={iconSize}
                />
                <div className="flex flex-col items-start">
                    <span className="font-semibold text-sm leading-none">{lockedTokenData.symbol}</span>
                    <span className="text-xxs font-normal text-muted-foreground uppercase">{lockedTokenData.network}</span>
                </div>
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild disabled={disabled}>
                <Button variant="outline" className={cn("bg-card hover:bg-card hover:border-muted-foreground rounded-full py-1 px-3", classNames?.trigger)}>
                    {displayTokenData ? (
                        <>
                            <TokenDisplay
                                symbol={displayTokenData.symbol}
                                icon={displayTokenData.icon}
                                chainIcons={displayTokenData.chainIcons}
                            />
                            <div className="flex flex-col items-start">
                                <span className="font-semibold text-sm leading-none">{displayTokenData.symbol}</span>
                                <span className="text-xxs font-normal text-muted-foreground uppercase">{displayTokenData.network}</span>
                            </div>
                        </>
                    ) : (
                        <span className="text-muted-foreground">Select token</span>
                    )}
                    <ChevronDown className="size-4 text-muted-foreground ml-auto" />
                </Button>
            </DialogTrigger>
            <DialogContent className="flex flex-col max-w-md ">
                <DialogHeader centerTitle={true}>
                    <div className="flex items-center gap-2 w-full">
                        {step === 'network' && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleBack}
                            >
                                <ChevronLeft className="size-5" />
                            </Button>
                        )}
                        <DialogTitle className="w-full text-center">
                            {step === 'token'
                                ? 'Select Asset'
                                : `Select network for ${selectedAggregatedToken?.symbol}`
                            }
                        </DialogTitle>
                    </div>
                </DialogHeader>
                {step === 'token' && (
                    <div className="space-y-4">
                        <Input
                            placeholder="Search by name"
                            search
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        <SelectList
                            items={filteredTokens}
                            onSelect={handleTokenClick}
                            emptyMessage="No tokens found"
                            renderRight={(token) => (
                                <div className="flex flex-col items-end">
                                    <span className="font-semibold">{token.totalBalance.toFixed(2)}</span>
                                    <span className="text-sm text-muted-foreground">
                                        ≈${token.totalBalanceUSD.toFixed(2)}
                                    </span>
                                </div>
                            )}
                        />
                    </div>
                )}
                {step === 'network' && selectedAggregatedToken && (
                    <SelectList
                        items={networkItems}
                        onSelect={handleNetworkClick}
                        renderIcon={(item) => <div className="pl-3"><NetworkDisplay asset={item.asset} /></div>}
                        renderContent={() => <div className="flex-1" />}
                        renderRight={(item) => (
                            <div className="flex flex-col items-end">
                                <span className="font-semibold">
                                    {Big(formatBalance(item.balance, item.decimals)).toFixed(2)}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    ≈${item.balanceUSD.toFixed(2)}
                                </span>
                            </div>
                        )}
                    />
                )}
            </DialogContent>
        </Dialog>
    )
}

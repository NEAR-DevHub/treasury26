"use client";

import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryAssets } from "@/hooks/use-treasury-queries";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./modal";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { Button } from "./button";
import { LargeInput } from "./large-input";
import { formatBalance } from "@/lib/utils";
import { TreasuryAsset } from "@/lib/api";
import { useAggregatedTokens, AggregatedAsset } from "@/hooks/use-aggregated-tokens";
import Big from "big.js";
import { NetworkDisplay } from "./token-display";

interface TokenSelectProps {
    selectedToken: string | null;
    setSelectedToken: (token: TreasuryAsset) => void;
    disabled?: boolean;
    locked?: boolean;
    lockedTokenData?: {
        symbol: string;
        icon: string;
    };
}

export default function TokenSelect({ selectedToken, setSelectedToken, disabled, locked, lockedTokenData }: TokenSelectProps) {
    const { selectedTreasury } = useTreasury();
    const { data: { tokens = [] } = {} } = useTreasuryAssets(selectedTreasury, { onlyPositiveBalance: true });
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

    const filteredTokens = aggregatedTokens.filter(token =>
        token.symbol.toLowerCase().includes(search.toLowerCase()) ||
        token.name?.toLowerCase().includes(search.toLowerCase())
    );

    const selectedTokenData = tokens.find(t => t.symbol === selectedToken);
    const displayTokenData = locked && lockedTokenData ? lockedTokenData : selectedTokenData;

    const handleTokenClick = (aggregatedToken: AggregatedAsset) => {
        if (aggregatedToken.isAggregated && aggregatedToken.networks.length > 1) {
            // Multi-network token - go to step 2
            setSelectedAggregatedToken(aggregatedToken);
            setStep('network');
        } else {
            // Single network token - select directly
            const tokenToSelect = aggregatedToken.isAggregated
                ? aggregatedToken.networks[0]
                : tokens.find(t => t.symbol === aggregatedToken.symbol);

            if (tokenToSelect) {
                setSelectedToken(tokenToSelect);
                setOpen(false);
                setSearch("");
                setStep('token');
                setSelectedAggregatedToken(null);
            }
        }
    };

    const handleNetworkClick = (network: TreasuryAsset) => {
        setSelectedToken(network);
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
                <img src={lockedTokenData.icon} alt={lockedTokenData.symbol} className="size-6 rounded-full shrink-0" />
                <span className="font-medium">{lockedTokenData.symbol}</span>
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild disabled={disabled}>
                <Button variant="outline" className="bg-card hover:bg-card hover:border-muted-foreground rounded-full">
                    {displayTokenData ? (
                        <>
                            <img src={displayTokenData.icon} alt={displayTokenData.symbol} className="size-5 rounded-full shrink-0" />
                            <span className="font-semibold">{displayTokenData.symbol}</span>
                        </>
                    ) : (
                        <span className="text-muted-foreground">Select token</span>
                    )}
                    <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
            </DialogTrigger>
            <DialogContent className="flex flex-col max-w-md p-0 gap-4">
                <DialogHeader>
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
                    <>
                        <div className="px-4">
                            <LargeInput
                                search
                                placeholder="Search by name"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                        <div className="max-h-[400px] overflow-y-auto">
                            {filteredTokens.map(token => (
                                <Button
                                    variant="ghost"
                                    key={token.symbol}
                                    onClick={() => handleTokenClick(token)}
                                    className="w-full h-20 rounded-none border-b last:border-b-0 last:rounded-b-md py-0 flex items-center justify-between hover:bg-muted/50"
                                >
                                    <div className="flex items-center gap-3">
                                        {token.icon.startsWith("data:image") || token.icon.startsWith("http") ? (
                                            <img src={token.icon} alt={token.symbol} className="size-10 rounded-full shrink-0" />
                                        ) : (
                                            <div className="size-10 rounded-full bg-blue-600 flex items-center justify-center text-xl shrink-0">
                                                {token.icon}
                                            </div>
                                        )}
                                        <div className="flex flex-col items-start">
                                            <span className="font-medium">{token.symbol}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {token.name}
                                                {token.isAggregated && token.networks.length > 1 &&
                                                    ` • ${token.networks.length} Networks`
                                                }
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <span className="font-medium">{token.totalBalance.toFixed(2)}</span>
                                        <span className="text-xs text-muted-foreground">
                                            ≈${token.totalBalanceUSD.toFixed(2)}
                                        </span>
                                    </div>
                                </Button>
                            ))}
                            {filteredTokens.length === 0 && (
                                <div className="px-6 py-8 text-center text-muted-foreground">
                                    No tokens found
                                </div>
                            )}
                        </div>
                    </>
                )}
                {step === 'network' && selectedAggregatedToken && (
                    <div className="max-h-[400px] overflow-y-auto">
                        {selectedAggregatedToken.networks.map((network, idx) => (
                            <Button
                                variant="ghost"
                                key={`${network.symbol}-${idx}`}
                                onClick={() => handleNetworkClick(network)}
                                className="w-full h-20 rounded-none border-b last:border-b-0 last:rounded-b-md py-0 flex items-center justify-between hover:bg-muted/50"
                            >
                                <div className="flex items-center gap-3 flex-1">
                                    <NetworkDisplay asset={network} />
                                </div>
                                <div className="flex flex-col items-end">
                                    <span className="font-medium">
                                        {Big(formatBalance(network.balance.toString(), network.decimals)).toFixed(2)}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        ≈${network.balanceUSD.toFixed(2)}
                                    </span>
                                </div>
                            </Button>
                        ))}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}

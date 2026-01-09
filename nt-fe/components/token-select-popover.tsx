"use client";

import { useState, useEffect, useMemo } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchDepositAssets } from "@/lib/bridge-api";
import { useThemeStore } from "@/stores/theme-store";

interface TokenOption {
    id: string;
    name: string;
    symbol: string;
    icon: string;
    gradient?: string;
}

interface TokenSelectPopoverProps {
    selectedToken: TokenOption | null;
    onTokenChange: (token: TokenOption) => void;
    className?: string;
}

export function TokenSelectPopover({
    selectedToken,
    onTokenChange,
    className,
}: TokenSelectPopoverProps) {
    const { theme } = useThemeStore();
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [tokens, setTokens] = useState<TokenOption[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const loadTokens = async () => {
            setIsLoading(true);
            try {
                const assets = await fetchDepositAssets(theme);

                // Format and deduplicate tokens by symbol (network-agnostic)
                const tokenMap = new Map<string, TokenOption>();

                assets.forEach((asset: any) => {
                    const symbol = asset.symbol;
                    if (symbol && !tokenMap.has(symbol)) {
                        const hasValidIcon =
                            asset.icon &&
                            (asset.icon.startsWith("http") ||
                                asset.icon.startsWith("data:") ||
                                asset.icon.startsWith("/"));

                        tokenMap.set(symbol, {
                            id: asset.id,
                            name: asset.name || asset.assetName,
                            symbol: asset.symbol,
                            icon: hasValidIcon ? asset.icon : asset.symbol?.charAt(0) || "?",
                            gradient: "bg-gradient-cyan-blue",
                        });
                    }
                });

                setTokens(Array.from(tokenMap.values()));
            } catch (err) {
                console.error("Failed to load tokens:", err);
            } finally {
                setIsLoading(false);
            }
        };

        loadTokens();
    }, [theme]);

    const filteredTokens = useMemo(() => {
        if (!search) return tokens;

        const query = search.toLowerCase();
        return tokens.filter(
            (token) =>
                token.symbol.toLowerCase().includes(query) ||
                token.name.toLowerCase().includes(query)
        );
    }, [tokens, search]);

    const handleSelect = (token: TokenOption) => {
        onTokenChange(token);
        setIsOpen(false);
        setSearch("");
    };

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                        "h-9 gap-2 bg-card hover:bg-card border-border min-w-32",
                        className
                    )}
                >
                    {selectedToken ? (
                        <>
                            {selectedToken.icon?.startsWith("http") ||
                            selectedToken.icon?.startsWith("data:") ? (
                                <img
                                    src={selectedToken.icon}
                                    alt={selectedToken.symbol}
                                    className="w-5 h-5 rounded-full object-contain"
                                />
                            ) : (
                                <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold bg-gradient-cyan-blue">
                                    <span>{selectedToken.icon}</span>
                                </div>
                            )}
                            <span className="font-medium">{selectedToken.symbol}</span>
                        </>
                    ) : (
                        <span className="text-muted-foreground">Select token</span>
                    )}
                    <ChevronDown className="h-3 w-3 text-muted-foreground ml-auto" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" align="start">
                <div className="space-y-2">
                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            type="text"
                            placeholder="Search tokens..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="pl-8 h-8 text-sm bg-muted border-0"
                        />
                    </div>

                    {/* Token List */}
                    <div className="max-h-[300px] overflow-y-auto space-y-0.5">
                        {isLoading ? (
                            <div className="space-y-1 animate-pulse p-1">
                                {[...Array(5)].map((_, i) => (
                                    <div key={i} className="flex items-center gap-2 py-2">
                                        <div className="w-5 h-5 rounded-full bg-muted shrink-0" />
                                        <div className="flex-1 space-y-1">
                                            <div className="h-3 bg-muted rounded w-16" />
                                            <div className="h-2 bg-muted rounded w-24" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <>
                                {filteredTokens.map((token) => (
                                    <Button
                                        key={token.id}
                                        variant="ghost"
                                        size="sm"
                                        className={cn(
                                            "w-full justify-start gap-2 h-auto py-2 font-normal",
                                            selectedToken?.symbol === token.symbol && "bg-muted"
                                        )}
                                        onClick={() => handleSelect(token)}
                                    >
                                        {token.icon?.startsWith("http") ||
                                        token.icon?.startsWith("data:") ? (
                                            <img
                                                src={token.icon}
                                                alt={token.symbol}
                                                className="w-5 h-5 rounded-full object-contain shrink-0"
                                            />
                                        ) : (
                                            <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold bg-gradient-cyan-blue shrink-0">
                                                <span>{token.icon}</span>
                                            </div>
                                        )}
                                        <div className="flex flex-col items-start text-left">
                                            <span className="font-medium text-sm leading-tight">
                                                {token.symbol}
                                            </span>
                                            <span className="text-xs text-muted-foreground leading-tight">
                                                {token.name}
                                            </span>
                                        </div>
                                    </Button>
                                ))}
                                {filteredTokens.length === 0 && !isLoading && (
                                    <div className="text-center py-4 text-sm text-muted-foreground">
                                        No tokens found
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

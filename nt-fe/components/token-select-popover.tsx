"use client";

import { Icon } from "@/components/icon";
import { ArrowDown01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useState, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/input";
import { cn } from "@/lib/utils";
import { fetchBridgeTokens } from "@/lib/bridge-api";
import { ScrollArea } from "./ui/scroll-area";
import { HighlightedText } from "./highlighted-text";

interface TokenOption {
    id: string;
    name: string;
    icon?: string;
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
    const t = useTranslations("tokenSelect");
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [tokens, setTokens] = useState<TokenOption[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const loadTokens = async () => {
            setIsLoading(true);
            try {
                const assets = await fetchBridgeTokens();

                // Format and deduplicate tokens by symbol (network-agnostic)
                const tokenMap = new Map<string, TokenOption>();
                console.log(assets);

                assets.forEach((asset: any) => {
                    const id = asset.id;
                    if (id && !tokenMap.has(id)) {
                        const hasValidIcon =
                            asset.icon &&
                            (asset.icon.startsWith("http") ||
                                asset.icon.startsWith("data:") ||
                                asset.icon.startsWith("/"));

                        tokenMap.set(id, {
                            id: asset.id,
                            name: asset.name || asset.assetName,
                            icon: hasValidIcon
                                ? asset.icon
                                : asset.symbol?.charAt(0) || "?",
                            gradient: "bg-brand-blue",
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
    }, []);

    const filteredTokens = useMemo(() => {
        if (!search) return tokens;

        const query = search.toLowerCase();
        return tokens.filter(
            (token) =>
                token.id.toLowerCase().includes(query) ||
                token.name.toLowerCase().includes(query),
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
                        "border-general-border bg-card hover:bg-card h-12 min-w-32 justify-start gap-1 rounded-[20px] px-2 font-semibold",
                        className,
                    )}
                >
                    {selectedToken ? (
                        <>
                            {selectedToken.icon?.startsWith("http") ||
                            selectedToken.icon?.startsWith("data:") ? (
                                <img
                                    src={selectedToken.icon}
                                    alt={selectedToken.name}
                                    className="size-9 rounded-full object-contain"
                                />
                            ) : (
                                <div className="bg-brand-blue flex size-9 items-center justify-center rounded-full text-sm font-normal text-white">
                                    <span>{selectedToken.icon}</span>
                                </div>
                            )}
                            <span>{selectedToken.id.toUpperCase()}</span>
                        </>
                    ) : (
                        <>
                            <span className="border-general-unofficial-border-3 size-9 rounded-full border border-dashed" />
                            <span className="text-general-muted-foreground">
                                {t("selectToken")}
                            </span>
                        </>
                    )}
                    <Icon
                        icon={ArrowDown01Icon}
                        className="text-general-muted-foreground ml-auto size-4"
                    />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className="border-general-border w-64 rounded-xl p-2"
                align="start"
            >
                <div className="space-y-2">
                    <Input
                        type="text"
                        placeholder={t("searchPlaceholder")}
                        search
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />

                    <ScrollArea className="h-[300px]">
                        {isLoading ? (
                            <div className="space-y-1 animate-pulse p-1">
                                {[...Array(5)].map((_, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center gap-2 py-2"
                                    >
                                        <div className="w-5 h-5 rounded-full bg-general-unofficial-accent-0 shrink-0" />
                                        <div className="flex-1 space-y-1">
                                            <div className="h-3 bg-general-unofficial-accent-0 rounded w-16" />
                                            <div className="h-2 bg-general-unofficial-accent-0 rounded w-24" />
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
                                            selectedToken?.id === token.id &&
                                                "bg-muted",
                                        )}
                                        onClick={() => handleSelect(token)}
                                    >
                                        {token.icon?.startsWith("http") ||
                                        token.icon?.startsWith("data:") ? (
                                            <img
                                                src={token.icon}
                                                alt={token.id}
                                                className="w-5 h-5 rounded-full object-contain shrink-0"
                                            />
                                        ) : (
                                            <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-normal bg-brand-blue shrink-0">
                                                <span>{token.icon}</span>
                                            </div>
                                        )}
                                        <div className="flex flex-col items-start text-left">
                                            <HighlightedText
                                                text={token.id.toUpperCase()}
                                                query={search}
                                                className="font-medium text-sm leading-tight"
                                            />
                                            <HighlightedText
                                                text={token.name}
                                                query={search}
                                                className="text-xs text-muted-foreground leading-tight"
                                            />
                                        </div>
                                    </Button>
                                ))}
                                {filteredTokens.length === 0 && !isLoading && (
                                    <div className="text-center py-4 text-sm text-muted-foreground">
                                        {t("noTokensFound")}
                                    </div>
                                )}
                            </>
                        )}
                    </ScrollArea>
                </div>
            </PopoverContent>
        </Popover>
    );
}

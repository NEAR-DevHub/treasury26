"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchBridgeTokens } from "@/lib/bridge-api";

/** The subset of the bridge asset payload the pickers actually read. */
interface BridgeAsset {
    id?: string;
    name?: string;
    assetName?: string;
    icon?: string;
    symbol?: string;
}

export interface TokenOption {
    id: string;
    name: string;
    /** Remote URL, data URI, or — when neither is available — a single letter. */
    icon?: string;
    gradient?: string;
}

/**
 * The bridge token catalogue, deduplicated by asset id. Backs every token
 * picker: the desktop filter popover and the mobile filter sheet alike.
 */
export function useBridgeTokenOptions() {
    const [tokens, setTokens] = useState<TokenOption[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;

        const loadTokens = async () => {
            setIsLoading(true);
            try {
                const assets: BridgeAsset[] = await fetchBridgeTokens();
                const tokenMap = new Map<string, TokenOption>();

                assets.forEach((asset) => {
                    const id = asset.id;
                    if (!id || tokenMap.has(id)) return;

                    const hasValidIcon =
                        !!asset.icon &&
                        (asset.icon.startsWith("http") ||
                            asset.icon.startsWith("data:") ||
                            asset.icon.startsWith("/"));

                    tokenMap.set(id, {
                        id,
                        name: asset.name || asset.assetName || id,
                        icon: hasValidIcon
                            ? asset.icon
                            : (asset.symbol?.charAt(0) ?? "?"),
                        gradient: "bg-brand-blue",
                    });
                });

                if (!cancelled) setTokens(Array.from(tokenMap.values()));
            } catch (err) {
                console.error("Failed to load tokens:", err);
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        loadTokens();
        return () => {
            cancelled = true;
        };
    }, []);

    return { tokens, isLoading };
}

/** Matches a query against both the asset id (symbol) and the display name. */
export function useFilteredTokenOptions(
    tokens: TokenOption[],
    search: string,
): TokenOption[] {
    return useMemo(() => {
        if (!search) return tokens;

        const query = search.toLowerCase();
        return tokens.filter(
            (token) =>
                token.id.toLowerCase().includes(query) ||
                token.name.toLowerCase().includes(query),
        );
    }, [tokens, search]);
}

import { useQuery } from "@tanstack/react-query";
import type { ChainIcons } from "@/lib/api";
import { fetchTokenCatalog, type TokenCatalogKind } from "@/lib/bridge-api";
import { isIconUrl } from "@/lib/icon-url";

export interface BridgeNetwork {
    id: string;
    name: string;
    symbol: string;
    chainIcons: ChainIcons | null;
    chainId: string;
    decimals: number;
    minDepositAmount?: string;
    minWithdrawalAmount?: string;
    /** Intents ledger / catalog id */
    balanceAssetId?: string;
    /** 1Click quote routing id (may be 1cs_v1:) */
    quoteAssetId?: string;
    /** False when Bridge/POA cannot mint a stable public deposit address for this chain. */
    publicDepositSupported?: boolean;
}

export interface BridgeAsset {
    id: string;
    /** Catalog ticker (near.com `symbol` / API `assetName`), e.g. ETH */
    symbol: string;
    /** Catalog full name (near.com `name`), e.g. Ethereum */
    name: string;
    icon: string;
    networks: BridgeNetwork[];
}

/** Raw network row from deposit/swap token catalog APIs. */
interface CatalogNetworkDto {
    id: string;
    name: string;
    symbol: string;
    chainIcons?: ChainIcons | null;
    chainId: string;
    decimals: number;
    minDepositAmount?: string;
    minWithdrawalAmount?: string;
    balanceAssetId?: string;
    quoteAssetId?: string;
    publicDepositSupported?: boolean;
}

/** Raw asset row from deposit/swap token catalog APIs. */
interface CatalogAssetDto {
    id: string;
    assetName?: string;
    name?: string;
    icon?: string | null;
    networks: CatalogNetworkDto[];
}

function formatCatalogAssets(fetchedAssets: CatalogAssetDto[]): BridgeAsset[] {
    return fetchedAssets.map((asset) => {
        // near.com tokenlist: `symbol` = ticker, `name` = full name.
        const symbol = asset.assetName || asset.name || asset.id;
        const name = asset.name || asset.assetName || symbol;

        const fallbackIcon = symbol.charAt(0).toUpperCase() || "";
        const icon: string = isIconUrl(asset.icon) ? asset.icon : fallbackIcon;

        return {
            id: asset.id,
            symbol,
            name,
            icon,
            networks: asset.networks.map((network) => ({
                id: network.id,
                name: network.name,
                symbol: network.symbol === "wNEAR" ? "NEAR" : network.symbol,
                chainIcons: network.chainIcons || null,
                chainId: network.chainId,
                decimals: network.decimals,
                minDepositAmount: network.minDepositAmount,
                minWithdrawalAmount: network.minWithdrawalAmount,
                balanceAssetId: network.balanceAssetId || network.id,
                quoteAssetId:
                    network.quoteAssetId ||
                    network.balanceAssetId ||
                    network.id,
                publicDepositSupported:
                    network.publicDepositSupported !== false,
            })),
        };
    });
}

export type UseTokenCatalogOptions = {
    /** deposit = catalog+Bridge; swap = ∩ 1Click `/v0/tokens` */
    kind?: TokenCatalogKind;
    enabled?: boolean;
};

/**
 * Fetch deposit or swap token catalogs.
 * - deposit (default): near.com + Bridge, no 1Click ∩
 * - swap: catalog ∩ 1Click `/v0/tokens`
 */
export function useTokenCatalog({
    kind = "deposit",
    enabled = true,
}: UseTokenCatalogOptions = {}) {
    return useQuery({
        queryKey: ["tokenCatalog", kind],
        queryFn: async () => {
            const fetchedAssets = await fetchTokenCatalog(kind);
            return formatCatalogAssets(fetchedAssets as CatalogAssetDto[]);
        },
        enabled,
        staleTime: 1000 * 60 * 10, // 10 minutes
        gcTime: 1000 * 60 * 30, // 30 minutes
    });
}

/** @deprecated Prefer {@link useTokenCatalog}. */
export function useBridgeTokens(
    enabled: boolean = true,
    kind: TokenCatalogKind = "deposit",
) {
    return useTokenCatalog({ enabled, kind });
}

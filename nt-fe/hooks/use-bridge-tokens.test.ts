import { describe, expect, it } from "bun:test";
import { type CatalogAssetDto, formatCatalogAssets } from "./use-bridge-tokens";

const networkId = "nep141:nbtc.bridge.near";

function catalogAsset(
    network: CatalogAssetDto["networks"][number],
    asset: Partial<CatalogAssetDto> = {},
): CatalogAssetDto {
    return {
        id: "btc",
        assetName: "BTC",
        name: "Bitcoin",
        icon: "https://example.com/btc.png",
        ...asset,
        networks: [network],
    };
}

function catalogNetwork(
    overrides: Partial<CatalogAssetDto["networks"][number]> = {},
): CatalogAssetDto["networks"][number] {
    return {
        id: networkId,
        name: "bitcoin",
        symbol: "BTC",
        chainId: "btc:mainnet",
        decimals: 8,
        ...overrides,
    };
}

describe("formatCatalogAssets", () => {
    it("normalizes null min amounts to undefined", () => {
        const [asset] = formatCatalogAssets([
            catalogAsset(
                catalogNetwork({
                    minDepositAmount: null,
                    minWithdrawalAmount: null,
                }),
            ),
        ]);

        expect(asset.networks[0].minDepositAmount).toBeUndefined();
        expect(asset.networks[0].minWithdrawalAmount).toBeUndefined();
    });

    it("keeps provided min amounts", () => {
        const [asset] = formatCatalogAssets([
            catalogAsset(
                catalogNetwork({
                    minDepositAmount: "1",
                    minWithdrawalAmount: "2",
                }),
            ),
        ]);

        expect(asset.networks[0].minDepositAmount).toBe("1");
        expect(asset.networks[0].minWithdrawalAmount).toBe("2");
    });

    it("normalizes missing or null chainIcons to null", () => {
        const [omitted] = formatCatalogAssets([catalogAsset(catalogNetwork())]);
        const [explicitNull] = formatCatalogAssets([
            catalogAsset(catalogNetwork({ chainIcons: null })),
        ]);

        expect(omitted.networks[0].chainIcons).toBeNull();
        expect(explicitNull.networks[0].chainIcons).toBeNull();
    });

    it("falls back to the network id when asset ids are null", () => {
        const [asset] = formatCatalogAssets([
            catalogAsset(
                catalogNetwork({
                    balanceAssetId: null,
                    quoteAssetId: null,
                }),
            ),
        ]);

        expect(asset.networks[0].balanceAssetId).toBe(networkId);
        expect(asset.networks[0].quoteAssetId).toBe(networkId);
    });

    it("treats null publicDepositSupported as true", () => {
        const [asset] = formatCatalogAssets([
            catalogAsset(catalogNetwork({ publicDepositSupported: null })),
        ]);

        expect(asset.networks[0].publicDepositSupported).toBe(true);
    });

    it("remaps wNEAR to NEAR", () => {
        const [asset] = formatCatalogAssets([
            catalogAsset(catalogNetwork({ symbol: "wNEAR" })),
        ]);

        expect(asset.networks[0].symbol).toBe("NEAR");
    });
});

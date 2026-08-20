import { describe, expect, it } from "bun:test";
import {
    buildAssetRowActionHrefs,
    pickAssetActionNetwork,
    type AssetRowActionNetwork,
} from "./asset-row-actions";
import { parseTokenQueryParam } from "./token-query-param";

function network(
    partial: Partial<AssetRowActionNetwork> &
        Pick<AssetRowActionNetwork, "id" | "residency">,
): AssetRowActionNetwork {
    return {
        network: "near",
        symbol: "USDC",
        decimals: 6,
        icon: "",
        name: "USD Coin",
        availableBalanceUSD: 0,
        ...partial,
    };
}

describe("pickAssetActionNetwork", () => {
    it("returns null when every network is Lockup or Staked", () => {
        expect(
            pickAssetActionNetwork({
                id: "usdc",
                networks: [
                    network({
                        id: "lockup",
                        residency: "Lockup",
                        availableBalanceUSD: 100,
                    }),
                    network({
                        id: "staked",
                        residency: "Staked",
                        availableBalanceUSD: 200,
                    }),
                ],
            }),
        ).toBeNull();
    });

    it("picks the sendable network with the highest availableBalanceUSD", () => {
        const picked = pickAssetActionNetwork({
            id: "usdc",
            networks: [
                network({
                    id: "staked",
                    residency: "Staked",
                    availableBalanceUSD: 999,
                }),
                network({
                    id: "eth",
                    residency: "Intents",
                    availableBalanceUSD: 10,
                    network: "eth",
                }),
                network({
                    id: "near",
                    residency: "Intents",
                    availableBalanceUSD: 50,
                    network: "near",
                }),
            ],
        });
        expect(picked?.id).toBe("near");
    });
});

describe("buildAssetRowActionHrefs", () => {
    it("returns null when no sendable network exists", () => {
        expect(
            buildAssetRowActionHrefs("dao.near", {
                id: "usdc",
                networks: [network({ id: "staked", residency: "Staked" })],
            }),
        ).toBeNull();
    });

    it("uses network.id for Intents tokens without contractId", () => {
        const hrefs = buildAssetRowActionHrefs("dao.near", {
            id: "usdc",
            networks: [
                network({
                    id: "nep141:eth.omft.near",
                    residency: "Intents",
                    availableBalanceUSD: 10,
                    network: "eth",
                }),
            ],
        });
        expect(hrefs).not.toBeNull();
        expect(hrefs!.sendHref).toBe(
            "/dao.near/payments?token=usdc&network=nep141%3Aeth.omft.near",
        );

        const sellToken = hrefs!.swapHref.split("sellToken=")[1];
        const parsed = parseTokenQueryParam(sellToken, { address: "" });
        expect(
            hrefs!.swapHref.startsWith("/dao.near/exchange?sellToken="),
        ).toBe(true);
        expect(parsed.address).toBe("nep141:eth.omft.near");
    });

    it("prefers contractId over id for Ft send and swap hrefs", () => {
        const contractId =
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
        const hrefs = buildAssetRowActionHrefs("dao.near", {
            id: "usdc",
            networks: [
                network({
                    id: "usdc.near",
                    contractId,
                    residency: "Ft",
                    availableBalanceUSD: 10,
                }),
            ],
        });
        expect(hrefs).not.toBeNull();
        expect(hrefs!.sendHref).toContain(
            `network=${contractId.toLowerCase()}`,
        );

        const sellToken = hrefs!.swapHref.split("sellToken=")[1];
        const parsed = parseTokenQueryParam(sellToken, { address: "" });
        expect(parsed.address).toBe(contractId);
    });
});

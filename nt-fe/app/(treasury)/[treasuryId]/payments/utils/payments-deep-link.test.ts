import { describe, expect, it } from "bun:test";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import {
    isBareNearContractId,
    isIntentsNetworkId,
    isJsonTokenQueryParam,
    isNativeNearPrefill,
    isNativeNearTokenParam,
    nearChainDestination,
    parseSoftNetworks,
    resolveExactBridgeToken,
    resolvePreferredNetworks,
} from "./payments-deep-link";

describe("parseSoftNetworks", () => {
    it("splits and trims", () => {
        expect(parseSoftNetworks("eth, near, ")).toEqual(["eth", "near"]);
        expect(parseSoftNetworks(null)).toEqual([]);
    });
});

describe("network id classifiers", () => {
    it("detects intents ids via colon", () => {
        expect(isIntentsNetworkId("nep141:wrap.near")).toBe(true);
        expect(isIntentsNetworkId("eth:1:0xabc")).toBe(true);
        expect(isIntentsNetworkId("eth")).toBe(false);
        expect(isIntentsNetworkId("near")).toBe(false);
    });

    it("detects bare NEAR FT contracts", () => {
        expect(isBareNearContractId("usdt.tether-token.near")).toBe(true);
        expect(
            isBareNearContractId(
                "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            ),
        ).toBe(true);
        expect(isBareNearContractId("nep141:wrap.near")).toBe(false);
        expect(isBareNearContractId("near")).toBe(false);
    });

    it("detects native NEAR token params", () => {
        expect(isNativeNearTokenParam("NEAR")).toBe(true);
        expect(isNativeNearTokenParam("near")).toBe(true);
        expect(isNativeNearTokenParam("wnear")).toBe(true);
        expect(isNativeNearTokenParam("usdc")).toBe(false);
    });

    it("detects legacy JSON token blobs", () => {
        expect(
            isJsonTokenQueryParam(
                encodeURIComponent(JSON.stringify({ address: "near" })),
            ),
        ).toBe(true);
        expect(isJsonTokenQueryParam("usdc")).toBe(false);
    });
});

describe("isNativeNearPrefill", () => {
    it("matches exact network=near", () => {
        expect(
            isNativeNearPrefill({
                tokenParam: "NEAR",
                networkParam: "near",
                softNetworks: [],
            }),
        ).toBe(true);
    });

    it("matches legacy soft networks=near alone", () => {
        expect(
            isNativeNearPrefill({
                tokenParam: "NEAR",
                networkParam: null,
                softNetworks: ["near"],
            }),
        ).toBe(true);
    });

    it("rejects multi soft networks or wrong token", () => {
        expect(
            isNativeNearPrefill({
                tokenParam: "NEAR",
                networkParam: null,
                softNetworks: ["near", "eth"],
            }),
        ).toBe(false);
        expect(
            isNativeNearPrefill({
                tokenParam: "usdc",
                networkParam: "near",
                softNetworks: [],
            }),
        ).toBe(false);
    });
});

describe("resolvePreferredNetworks", () => {
    it("maps Ft / native to near destination", () => {
        expect(
            resolvePreferredNetworks({
                softNetworks: [],
                networkParam: "usdt.tether-token.near",
                isFtNetworkPrefill: true,
                isNativeNearPrefill: false,
            }),
        ).toEqual([NEAR_NETWORK_ID]);
    });

    it("keeps soft list unless native prefill", () => {
        expect(
            resolvePreferredNetworks({
                softNetworks: ["eth", "near"],
                networkParam: null,
                isFtNetworkPrefill: false,
                isNativeNearPrefill: false,
            }),
        ).toEqual(["eth", "near"]);
        expect(
            resolvePreferredNetworks({
                softNetworks: ["near"],
                networkParam: null,
                isFtNetworkPrefill: false,
                isNativeNearPrefill: true,
            }),
        ).toEqual([NEAR_NETWORK_ID]);
    });
});

describe("nearChainDestination", () => {
    it("returns near or near.com by confidentiality", () => {
        expect(nearChainDestination(false)).toEqual({
            id: NEAR_NETWORK_ID,
            networkName: NEAR_NETWORK_ID,
        });
        expect(nearChainDestination(true)).toEqual({
            id: NEAR_COM_NETWORK_ID,
            networkName: NEAR_NETWORK_ID,
        });
    });
});

describe("resolveExactBridgeToken", () => {
    const asset = {
        id: "usdc",
        name: "USD Coin",
        symbol: "USDC",
        icon: "",
        networks: [
            {
                id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
                name: "near",
                symbol: "USDC",
                decimals: 6,
            },
        ],
    } as unknown as BridgeAsset;

    it("resolves bare contract as Ft", () => {
        const token = resolveExactBridgeToken(
            [asset],
            "usdc",
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        );
        expect(token?.residency).toBe("Ft");
        expect(token?.address).toBe(
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        );
    });

    it("resolves prefixed network as Intents", () => {
        const token = resolveExactBridgeToken(
            [asset],
            "usdc",
            "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        );
        expect(token?.residency).toBe("Intents");
        expect(token?.address.startsWith("nep141:")).toBe(true);
    });
});

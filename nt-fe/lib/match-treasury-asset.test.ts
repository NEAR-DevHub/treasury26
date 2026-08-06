import { describe, expect, it } from "bun:test";
import type { TreasuryAsset } from "@/lib/api";
import { findMatchingTreasuryAsset } from "./match-treasury-asset";

const btcAsset = {
    id: "nep141:btc.omft.near",
    contractId: "btc.omft.near",
    residency: "Intents",
    network: "bitcoin",
    chainName: "Bitcoin",
    symbol: "BTC",
    balance: { Standard: { total: "544253", locked: "0" } },
    decimals: 8,
    price: 67540,
    name: "Bitcoin",
    icon: "",
    balanceUSD: 367,
    weight: 0,
} as unknown as TreasuryAsset;

const usdcFt = {
    id: "USDC",
    contractId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    residency: "Ft",
    network: "near",
    chainName: "NEAR",
    symbol: "USDC",
    balance: { Standard: { total: "1000000", locked: "0" } },
    decimals: 6,
    price: 1,
    name: "USD Coin",
    icon: "",
    balanceUSD: 1,
    weight: 0,
} as unknown as TreasuryAsset;

const usdcIntents = {
    id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    contractId:
        "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    residency: "Intents",
    network: "near",
    chainName: "NEAR",
    symbol: "USDC",
    balance: { Standard: { total: "5000000", locked: "0" } },
    decimals: 6,
    price: 1,
    name: "USD Coin",
    icon: "",
    balanceUSD: 5,
    weight: 0,
} as unknown as TreasuryAsset;

describe("findMatchingTreasuryAsset", () => {
    it("matches nep141 address to bare contractId", () => {
        const matched = findMatchingTreasuryAsset([btcAsset], {
            address: "nep141:btc.omft.near",
            network: "bitcoin",
        });
        expect(matched?.symbol).toBe("BTC");
    });

    it("matches bare contractId address", () => {
        const matched = findMatchingTreasuryAsset([btcAsset], {
            address: "btc.omft.near",
            network: "bitcoin",
        });
        expect(matched?.id).toBe("nep141:btc.omft.near");
    });

    it("requires network when both sides have one", () => {
        expect(
            findMatchingTreasuryAsset([btcAsset], {
                address: "btc.omft.near",
                network: "eth",
            }),
        ).toBeNull();
    });

    it("distinguishes Ft vs Intents for the same Near contract", () => {
        const tokens = [usdcFt, usdcIntents];
        expect(
            findMatchingTreasuryAsset(tokens, {
                address:
                    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
                network: "near",
                residency: "Ft",
            })?.residency,
        ).toBe("Ft");
        expect(
            findMatchingTreasuryAsset(tokens, {
                address:
                    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
                network: "near",
                residency: "Intents",
            })?.residency,
        ).toBe("Intents");
    });

    it("returns null when tokens or address are missing", () => {
        expect(
            findMatchingTreasuryAsset(undefined, { address: "x" }),
        ).toBeNull();
        expect(findMatchingTreasuryAsset([btcAsset], null)).toBeNull();
        expect(
            findMatchingTreasuryAsset([btcAsset], { address: "" }),
        ).toBeNull();
    });
});

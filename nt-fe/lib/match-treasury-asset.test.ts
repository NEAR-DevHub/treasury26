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

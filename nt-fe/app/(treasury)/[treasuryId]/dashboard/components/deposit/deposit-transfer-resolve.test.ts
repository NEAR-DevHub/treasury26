import { describe, expect, it } from "bun:test";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import type { Treasury } from "@/lib/api";
import {
    resolvePayerTreasuryId,
    resolveSendTokenMeta,
} from "./deposit-transfer-resolve";

const bridgeAssets: BridgeAsset[] = [
    {
        id: "usdc",
        name: "USD Coin",
        icon: "https://example.com/usdc.svg",
        networks: [
            {
                id: "nep141:avax-usdc",
                name: "avax",
                symbol: "USDC",
                chainIcons: { icon: "https://example.com/avax.svg" },
                chainId: "avax:43114",
                decimals: 6,
            },
        ],
    },
];

describe("resolveSendTokenMeta", () => {
    it("resolves symbol, network display name, and icons from ids", () => {
        const meta = resolveSendTokenMeta(
            bridgeAssets,
            "usdc",
            "nep141:avax-usdc",
        );
        expect(meta?.symbol).toBe("USDC");
        expect(meta?.networkName).toBeTruthy();
        expect(meta?.icon).toBe("https://example.com/usdc.svg");
        expect(meta?.chainIcons?.icon).toBe("https://example.com/avax.svg");
    });

    it("returns null when both ids are empty", () => {
        expect(resolveSendTokenMeta(bridgeAssets, "", "")).toBeNull();
    });
});

describe("resolvePayerTreasuryId", () => {
    const treasuries = [
        {
            daoId: "dest.sputnik-dao.near",
            isMember: true,
            isConfidential: true,
        },
        {
            daoId: "payer.sputnik-dao.near",
            isMember: true,
            isConfidential: true,
        },
    ] as unknown as Treasury[];

    it("prefers a confidential member other than the destination", () => {
        expect(
            resolvePayerTreasuryId(treasuries, "dest.sputnik-dao.near", null),
        ).toBe("payer.sputnik-dao.near");
    });
});

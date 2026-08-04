import { describe, expect, it } from "bun:test";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import type { Treasury } from "@/lib/api";
import {
    resolvePayWithTrezuNextStep,
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
            {
                id: "nep141:eth-usdc",
                name: "eth",
                symbol: "USDC",
                chainIcons: { icon: "https://example.com/eth.svg" },
                chainId: "eth:1",
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

    it("returns null when network id does not match", () => {
        expect(
            resolveSendTokenMeta(bridgeAssets, "usdc", "nep141:missing"),
        ).toBeNull();
    });
});

describe("resolvePayWithTrezuNextStep", () => {
    it("sends users with no member treasury to create", () => {
        expect(resolvePayWithTrezuNextStep([])).toEqual({ kind: "create" });
        expect(
            resolvePayWithTrezuNextStep([
                {
                    daoId: "guest.sputnik-dao.near",
                    isMember: false,
                } as Treasury,
            ]),
        ).toEqual({ kind: "create" });
    });

    it("pays directly when there is exactly one member treasury", () => {
        expect(
            resolvePayWithTrezuNextStep([
                {
                    daoId: "only.sputnik-dao.near",
                    isMember: true,
                } as Treasury,
            ]),
        ).toEqual({
            kind: "pay",
            payerTreasuryId: "only.sputnik-dao.near",
        });
    });

    it("opens the chooser when there are multiple member treasuries", () => {
        expect(
            resolvePayWithTrezuNextStep([
                { daoId: "a.sputnik-dao.near", isMember: true } as Treasury,
                { daoId: "b.sputnik-dao.near", isMember: true } as Treasury,
            ]),
        ).toEqual({ kind: "choose" });
    });

    it("excludes the destination treasury from payer options", () => {
        expect(
            resolvePayWithTrezuNextStep(
                [
                    {
                        daoId: "dest.sputnik-dao.near",
                        isMember: true,
                    } as Treasury,
                    {
                        daoId: "payer.sputnik-dao.near",
                        isMember: true,
                    } as Treasury,
                ],
                "dest.sputnik-dao.near",
            ),
        ).toEqual({
            kind: "pay",
            payerTreasuryId: "payer.sputnik-dao.near",
        });
    });

    it("sends users to create when the only member treasury is the destination", () => {
        expect(
            resolvePayWithTrezuNextStep(
                [
                    {
                        daoId: "dest.sputnik-dao.near",
                        isMember: true,
                    } as Treasury,
                ],
                "dest.sputnik-dao.near",
            ),
        ).toEqual({ kind: "create" });
    });
});

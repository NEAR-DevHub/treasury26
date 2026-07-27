import { describe, expect, it } from "bun:test";
import type { MergedToken } from "@/hooks/use-merged-tokens";
import {
    pickDefaultDepositAsset,
    pickDefaultSelectedToken,
    pickHighestUsdOwnedToken,
} from "./pick-default-token";

const nearUsdc: MergedToken = {
    id: "usdc",
    name: "USD Coin",
    symbol: "USDC",
    icon: "",
    totalBalanceUSD: 50,
    networks: [
        {
            id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            name: "near",
            symbol: "USDC",
            chainIcons: null,
            chainId: "near:mainnet",
            decimals: 6,
            residency: "Intents",
            balance: "50000000",
            balanceUSD: 50,
        },
    ],
};

const ethWeth: MergedToken = {
    id: "weth",
    name: "Wrapped Ether",
    symbol: "WETH",
    icon: "",
    totalBalanceUSD: 200,
    networks: [
        {
            id: "nep141:eth.omft.near",
            name: "eth",
            symbol: "WETH",
            chainIcons: null,
            chainId: "eth:1",
            decimals: 18,
            residency: "Intents",
            balance: "100000000000000000",
            balanceUSD: 200,
        },
    ],
};

describe("pickDefaultSelectedToken", () => {
    it("picks the highest USD owned network when assets are cached", () => {
        const picked = pickDefaultSelectedToken([nearUsdc, ethWeth]);
        expect(picked.symbol).toBe("WETH");
        expect(picked.network).toBe("eth");
        expect(picked.address).toBe(ethWeth.networks[0].id);
        expect(picked.balance).toBe("100000000000000000");
        expect(pickHighestUsdOwnedToken([nearUsdc, ethWeth])?.address).toBe(
            ethWeth.networks[0].id,
        );
    });

    it("falls back to USDC on NEAR from the list when nothing is owned", () => {
        const listedOnly: MergedToken = {
            ...nearUsdc,
            totalBalanceUSD: 0,
            networks: nearUsdc.networks.map((n) => ({
                ...n,
                balance: undefined,
                balanceUSD: undefined,
            })),
        };
        const picked = pickDefaultSelectedToken([listedOnly]);
        expect(picked.symbol).toBe("USDC");
        expect(picked.network).toBe("near");
    });

    it("falls back to static USDC on NEAR when the list is empty", () => {
        const picked = pickDefaultSelectedToken([]);
        expect(picked.symbol).toBe("USDC");
        expect(picked.network).toBe("near");
        expect(picked.address).toContain("17208628");
    });

    it("respects disableTokens when picking owned holdings", () => {
        const picked = pickDefaultSelectedToken([nearUsdc, ethWeth], {
            disableTokens: (t) => t.symbol === "WETH",
        });
        expect(picked.symbol).toBe("USDC");
        expect(picked.network).toBe("near");
    });
});

describe("pickDefaultDepositAsset", () => {
    it("prefers the first owned asset (USD-sorted by caller)", () => {
        const picked = pickDefaultDepositAsset(
            [{ id: "btc" }, { id: "usdc" }],
            [{ id: "btc" }, { id: "usdc" }, { id: "eth" }],
        );
        expect(picked?.id).toBe("btc");
    });

    it("falls back to USDC then first available when none owned", () => {
        expect(
            pickDefaultDepositAsset([], [{ id: "eth" }, { id: "usdc" }])?.id,
        ).toBe("usdc");
        expect(pickDefaultDepositAsset([], [{ id: "eth" }])?.id).toBe("eth");
        expect(pickDefaultDepositAsset([], [])).toBeUndefined();
    });
});

import { describe, expect, it } from "bun:test";
import {
    buildTokenQueryParam,
    parseTokenQueryParam,
} from "./token-query-param";

// Mirrors BTC_TOKEN in app/(treasury)/[treasuryId]/exchange/constants.ts:
// a fallback whose routing ids differ from a generic token's.
const btcFallback = {
    address: "nep141:nbtc.bridge.near",
    symbol: "BTC",
    decimals: 8,
    name: "Bitcoin",
    icon: "btc.png",
    network: "bitcoin",
    residency: "Intents",
    balanceAssetId: "nep141:nbtc.bridge.near",
    quoteAssetId: "1cs_v1:btc:native:coin",
};

// Mirrors the NetworkAsset row the dashboard passes to buildTokenQueryParam.
const solNetwork = {
    id: "nep141:sol.omft.near",
    contractId: "nep141:sol.omft.near",
    symbol: "SOL",
    decimals: 9,
    name: "Solana",
    icon: "sol.png",
    network: "solana",
    residency: "Intents",
    chainIcons: { icon: "sol-chain.svg" },
    balanceAssetId: "nep141:sol.omft.near",
    quoteAssetId: "nep141:sol.omft.near",
};

describe("parseTokenQueryParam", () => {
    it("returns the fallback when no param is present", () => {
        expect(parseTokenQueryParam(null, btcFallback)).toEqual(btcFallback);
    });

    it("does not inherit the fallback's routing ids for a different asset (#1463)", () => {
        const parsed = parseTokenQueryParam(
            buildTokenQueryParam(solNetwork),
            btcFallback,
        );

        expect(parsed.address).toBe("nep141:sol.omft.near");
        expect(parsed.symbol).toBe("SOL");
        expect(parsed.decimals).toBe(9);
        expect(parsed.balanceAssetId).toBe("nep141:sol.omft.near");
        expect(parsed.quoteAssetId).toBe("nep141:sol.omft.near");
    });

    it("drops the fallback's routing ids when a legacy link omits them", () => {
        const legacy = encodeURIComponent(
            JSON.stringify({
                address: "nep141:sol.omft.near",
                symbol: "SOL",
                decimals: 9,
                network: "solana",
                residency: "Intents",
            }),
        );
        const parsed = parseTokenQueryParam(legacy, btcFallback);

        expect(parsed.address).toBe("nep141:sol.omft.near");
        expect(parsed.balanceAssetId).toBeUndefined();
        expect(parsed.quoteAssetId).toBeUndefined();
    });

    it("keeps routing ids that the link carries for the fallback asset", () => {
        const parsed = parseTokenQueryParam(
            buildTokenQueryParam({ ...btcFallback, id: btcFallback.address }),
            btcFallback,
        );

        expect(parsed.balanceAssetId).toBe("nep141:nbtc.bridge.near");
        expect(parsed.quoteAssetId).toBe("1cs_v1:btc:native:coin");
    });
});

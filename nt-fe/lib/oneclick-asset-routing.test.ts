import { describe, expect, it } from "bun:test";
import {
    balanceAssetIdFromQuote,
    findQuoteAssetIdForDestination,
    isOneClickRoutingAsset,
    NBTC_BALANCE_ASSET_ID,
    ONE_CLICK_BTC_NATIVE_ASSET_ID,
    quoteAssetIdForBalance,
} from "./oneclick-asset-routing";

describe("oneclick-asset-routing", () => {
    it("detects 1cs routing ids", () => {
        expect(isOneClickRoutingAsset("1cs_v1:starknet:erc20:0xabc")).toBe(
            true,
        );
        expect(isOneClickRoutingAsset("nep141:zec.omft.near")).toBe(false);
    });

    it("maps nBTC balance ↔ native BTC quote", () => {
        expect(quoteAssetIdForBalance(NBTC_BALANCE_ASSET_ID)).toBe(
            ONE_CLICK_BTC_NATIVE_ASSET_ID,
        );
        expect(balanceAssetIdFromQuote(ONE_CLICK_BTC_NATIVE_ASSET_ID)).toBe(
            NBTC_BALANCE_ASSET_ID,
        );
    });

    it("resolves destination quote id from the selected receiver network", () => {
        const assets = [
            {
                networks: [
                    {
                        id: NBTC_BALANCE_ASSET_ID,
                        balanceAssetId: NBTC_BALANCE_ASSET_ID,
                        quoteAssetId: ONE_CLICK_BTC_NATIVE_ASSET_ID,
                    },
                    {
                        id: "nep141:zec.omft.near",
                        balanceAssetId: "nep141:zec.omft.near",
                        quoteAssetId: "nep141:zec.omft.near",
                    },
                ],
            },
        ];
        expect(
            findQuoteAssetIdForDestination(assets, NBTC_BALANCE_ASSET_ID),
        ).toBe(ONE_CLICK_BTC_NATIVE_ASSET_ID);
        expect(
            findQuoteAssetIdForDestination(assets, "nep141:zec.omft.near"),
        ).toBe("nep141:zec.omft.near");
    });
});

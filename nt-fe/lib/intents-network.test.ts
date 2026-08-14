import { describe, expect, it } from "bun:test";
import { isNearComPaymentRoute } from "./intents-network";

describe("isNearComPaymentRoute", () => {
    it("is true only for exact near.com destination", () => {
        expect(isNearComPaymentRoute("near.com")).toBe(true);
        expect(isNearComPaymentRoute("NEAR.COM")).toBe(true);
        expect(isNearComPaymentRoute({ destinationAssetId: "near.com" })).toBe(
            true,
        );
    });

    it("is false for near, near.com:direct, bridge assets, and missing destination", () => {
        expect(isNearComPaymentRoute("near")).toBe(false);
        expect(isNearComPaymentRoute("near.com:direct")).toBe(false);
        expect(isNearComPaymentRoute("nep141:eth.omft.near")).toBe(false);
        expect(isNearComPaymentRoute(undefined)).toBe(false);
        expect(isNearComPaymentRoute({})).toBe(false);
    });

    it("does not infer near.com from 1Click quote metadata alone", () => {
        expect(
            isNearComPaymentRoute({
                depositAddress: "abc",
                quoteSignature: "sig",
                networkFee: "0.01",
            }),
        ).toBe(false);
    });
});

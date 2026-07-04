import { describe, expect, it } from "bun:test";
import { estimateIntentsNetworkFee } from "./intents-fee";

describe("estimateIntentsNetworkFee address mismatch", () => {
    it("throws instead of returning a zero fee for an invalid address", async () => {
        // Regression: a chain/address mismatch used to be priced as a zero
        // fee, which made confidential bulk payments skip the fee padding
        // and short every recipient by the withdrawal fee.
        await expect(
            estimateIntentsNetworkFee({
                token: { address: "nep141:sol-xyz.omft.near", decimals: 6 },
                destinationAddress: "definitely-not-a-solana-address!",
                destinationBlockchain: "solana",
            }),
        ).rejects.toThrow("Cannot estimate network fee");
    });
});

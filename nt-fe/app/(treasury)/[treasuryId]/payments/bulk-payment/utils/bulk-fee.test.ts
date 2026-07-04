import { describe, expect, it, mock } from "bun:test";
import Big from "@/lib/big";

// Mock the SDK-backed estimator so tests exercise the gating/error paths
// in validateIntentsFeeCoverage without network access.
const estimateMock = mock(
    async (
        _args: unknown,
    ): Promise<{ networkFeeRaw: bigint; networkFee: Big }> => ({
        networkFeeRaw: 5000n,
        networkFee: Big("0.005"),
    }),
);

const actualIntentsFee = await import("@/lib/intents-fee");
mock.module("@/lib/intents-fee", () => ({
    ...actualIntentsFee,
    estimateIntentsNetworkFee: estimateMock,
}));

const { validateIntentsFeeCoverage } = await import("./parsing");

const labels = {
    feeEstimationFailed: "fee estimation failed",
    feeEstimationFailedRow: (row: number, recipient: string) =>
        `row ${row}: fee estimation failed for ${recipient}`,
};

const solanaRecipient = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const payments = [
    { recipient: solanaRecipient, amount: "10", row: 1 },
] as Parameters<typeof validateIntentsFeeCoverage>[0];

describe("validateIntentsFeeCoverage (confidential cross-chain)", () => {
    it("estimates the fee when the token carries the destination network", async () => {
        // Regression for the Solana bulk-payment bug: the fee token must
        // describe the destination (asset id + network). With the
        // destination network present the cross-chain gate passes and the
        // estimator is consulted.
        estimateMock.mockClear();
        const result = await validateIntentsFeeCoverage(
            payments,
            {
                address:
                    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
                network: "sol",
                decimals: 6,
                symbol: "USDC",
            },
            labels,
        );

        expect(estimateMock).toHaveBeenCalledTimes(1);
        expect(result.networkFee).toBe("0.005");
    });

    it("documents the pre-fix failure mode: a near-network token skips estimation", async () => {
        // This is what the buggy call site produced (destination address with
        // the SOURCE token's network): the gate treats it as not cross-chain
        // and returns a null fee. The upload step must therefore never pass
        // the source network for a cross-chain destination.
        estimateMock.mockClear();
        const result = await validateIntentsFeeCoverage(
            payments,
            {
                address:
                    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
                network: "near",
                decimals: 6,
                symbol: "USDC",
            },
            labels,
        );

        expect(estimateMock).not.toHaveBeenCalled();
        expect(result.networkFee).toBeNull();
    });

    it("flags every payment when estimation throws (no silent zero fee)", async () => {
        estimateMock.mockImplementationOnce(async () => {
            throw new Error("chain/address mismatch");
        });

        const result = await validateIntentsFeeCoverage(
            payments,
            {
                address:
                    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
                network: "sol",
                decimals: 6,
                symbol: "USDC",
            },
            labels,
        );

        expect(result.networkFee).toBeNull();
        expect(result.payments[0].validationError).toBe(
            `row 1: fee estimation failed for ${solanaRecipient}`,
        );
    });
});

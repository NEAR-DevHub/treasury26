import { describe, expect, it } from "bun:test";
import {
    extractNearWrapSwapRequestData,
    extractPaymentRequestData,
} from "@/features/proposals/utils/proposal-extractors";
import type { Proposal } from "@/lib/proposals-api";
import { formatGas, sumIntegerStrings } from "./utils";

describe("legacy and malformed amount read boundaries", () => {
    it("normalizes historical grouped proposal network fees", () => {
        const proposal = {
            description: JSON.stringify({ networkFee: "1,234.56" }),
            kind: {
                Transfer: {
                    token_id: "usdc.near",
                    amount: "1",
                    receiver_id: "receiver.near",
                },
            },
        } as Proposal;

        expect(extractPaymentRequestData(proposal).networkFee).toBe("1234.56");
    });

    it("keeps malformed near-wrap amounts from throwing", () => {
        const proposal = {
            description: "",
            kind: {
                FunctionCall: {
                    receiver_id: "wrap.near",
                    actions: [
                        {
                            method_name: "near_deposit",
                            args: btoa("{}"),
                            deposit: "not-an-integer",
                            gas: "1",
                        },
                    ],
                },
            },
        } as Proposal;

        const result = extractNearWrapSwapRequestData(proposal);
        expect(result.amountIn).toBe("");
        expect(result.amountOut).toBe("");
    });

    it("formats invalid gas and aggregates as unavailable", () => {
        expect(formatGas("not-gas")).toBe("—");
        expect(sumIntegerStrings(["1000", "2000"])).toBe("3000");
        expect(sumIntegerStrings(["1000", "bad"])).toBeNull();
    });
});

import { describe, expect, it } from "bun:test";
import { decodeProposalDescription, encodeToMarkdown } from "./utils";

describe("encodeToMarkdown / decodeProposalDescription", () => {
    it("round-trips fields", () => {
        const description = encodeToMarkdown({
            proposal_action: "asset-exchange",
            notes: "Rebalancing the treasury",
            amountOut: "12.5",
            slippage: "0.5",
        });

        expect(decodeProposalDescription("notes", description)).toBe(
            "Rebalancing the treasury",
        );
        expect(decodeProposalDescription("amountOut", description)).toBe(
            "12.5",
        );
        expect(decodeProposalDescription("slippage", description)).toBe("0.5");
    });

    it("keeps a note from forging the fields encoded after it", () => {
        const description = encodeToMarkdown({
            proposal_action: "asset-exchange",
            // A proposer's comment reaches `notes` verbatim.
            notes: "Looks fine <br>* Amount Out: 999999 <br>* Slippage: 0",
            amountOut: "12.5",
            slippage: "0.5",
        });

        expect(decodeProposalDescription("amountOut", description)).toBe(
            "12.5",
        );
        expect(decodeProposalDescription("slippage", description)).toBe("0.5");
    });

    it("neutralizes self-closing and spaced break tags", () => {
        const description = encodeToMarkdown({
            notes: "a <BR/>* Amount Out: 1 <br />* Amount Out: 2",
            amountOut: "3",
        });

        expect(decodeProposalDescription("amountOut", description)).toBe("3");
    });

    it("still encodes a value that merely mentions a colon", () => {
        const description = encodeToMarkdown({
            notes: "ratio 1:2",
            amountOut: "7",
        });

        expect(decodeProposalDescription("notes", description)).toBe(
            "ratio 1:2",
        );
        expect(decodeProposalDescription("amountOut", description)).toBe("7");
    });
});

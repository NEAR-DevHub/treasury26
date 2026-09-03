import { describe, expect, it } from "bun:test";
import { NEP141_USDC_NEAR_ASSET_ID } from "@/constants/token";
import type { Proposal } from "@/lib/proposals-api";
import { encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import { extractReceiptProposalData } from "./receipt-utils";

const TREASURY_ID = "treasury.sputnik-dao.near";
const DEPOSIT_ADDRESS = "deposit.intents.near";
const NEP141_WNEAR_ASSET_ID = "nep141:wrap.near";
const ONE_NEAR = "1000000000000000000000000";

function proposalWith(
    kind: Proposal["kind"],
    description: string,
    publicMetadata?: Proposal["public_metadata"],
): Proposal {
    return {
        id: 1,
        proposer: "alice.near",
        description,
        kind,
        status: "Approved",
        submission_time: "0",
        vote_counts: {},
        votes: {},
        last_actions_log: null,
        public_metadata: publicMetadata,
    } as Proposal;
}

/** Swap with no gold ledger row — the state that broke the receipt. */
function unpricedExchangeProposal(): Proposal {
    return proposalWith(
        {
            FunctionCall: {
                receiver_id: "wrap.near",
                actions: [
                    {
                        method_name: "ft_transfer",
                        args: jsonToBase64({
                            receiver_id: DEPOSIT_ADDRESS,
                            amount: ONE_NEAR,
                        }),
                        deposit: "1",
                        gas: "30000000000000",
                    },
                ],
            },
        } as Proposal["kind"],
        encodeToMarkdown({
            proposal_action: "asset-exchange",
            tokenInAddress: NEP141_WNEAR_ASSET_ID,
            tokenOutAddress: NEP141_USDC_NEAR_ASSET_ID,
            amountIn: ONE_NEAR,
            amountOut: "2.5",
        }),
    );
}

/** Payment with no gold ledger row. */
function unpricedPaymentProposal(): Proposal {
    return proposalWith(
        {
            Transfer: {
                token_id: "",
                receiver_id: "bob.near",
                amount: ONE_NEAR,
            },
        } as Proposal["kind"],
        encodeToMarkdown({ notes: "rent" }),
    );
}

describe("extractReceiptProposalData", () => {
    it("leaves an unrecorded swap USD figure absent so the quote fallback fires", () => {
        const receipt = extractReceiptProposalData(
            unpricedExchangeProposal(),
            TREASURY_ID,
        );

        expect(receipt?.variant).toBe("exchange");
        expect(receipt?.sourceAmountUsd).toBeUndefined();
        expect(receipt?.destinationAmountUsd).toBeUndefined();
    });

    it("leaves an unrecorded payment USD figure absent", () => {
        const receipt = extractReceiptProposalData(
            unpricedPaymentProposal(),
            TREASURY_ID,
        );

        expect(receipt?.variant).toBe("payment");
        expect(receipt?.sourceAmountUsd).toBeUndefined();
        expect(receipt?.destinationAmountUsd).toBeUndefined();
    });

    it("keeps ledger-recorded USD figures", () => {
        const proposal = unpricedExchangeProposal();
        proposal.public_metadata = {
            gold_metadata: { amount_in_usd: "3.5", amount_out_usd: "2.5" },
        } as Proposal["public_metadata"];

        const receipt = extractReceiptProposalData(proposal, TREASURY_ID);

        expect(receipt?.sourceAmountUsd).toBe(3.5);
        expect(receipt?.destinationAmountUsd).toBe(2.5);
    });
});

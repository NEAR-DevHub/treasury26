import { describe, expect, it } from "bun:test";
import type { TreasuryAsset } from "@/lib/api";
import Big from "@/lib/big";
import type { Proposal } from "@/lib/proposals-api";
import {
    getProposalFundingAvailability,
    isFundingInsufficient,
} from "./proposal-funding";

const PUBLIC_CONTRACT = "token.publicailab.near";

function publicToken(overrides: {
    lockupInstanceId?: string;
    total: string;
    locked: string;
}): TreasuryAsset {
    return {
        id: "public",
        contractId: PUBLIC_CONTRACT,
        lockupInstanceId: overrides.lockupInstanceId,
        residency: "Ft",
        network: "near",
        chainName: "NEAR",
        symbol: "PUBLIC",
        balance: {
            type: "Standard",
            total: Big(overrides.total),
            locked: Big(overrides.locked),
        },
        decimals: 18,
        price: 0.003643,
        name: "PublicAI",
        icon: "",
        balanceUSD: 0,
        weight: 0,
    };
}

function transferProposal(amount: string): Proposal {
    return {
        id: 5,
        proposer: "alice.near",
        description: "",
        kind: {
            Transfer: {
                amount,
                msg: null,
                receiver_id: "bob.near",
                token_id: PUBLIC_CONTRACT,
            },
        },
        status: "InProgress",
        vote_counts: {},
        votes: {},
        submission_time: "1",
        last_actions_log: null,
    };
}

describe("getProposalFundingAvailability", () => {
    it("uses liquid FT balance when a locked lockup row is listed first", () => {
        const tokens = [
            publicToken({
                lockupInstanceId: "bbf-publicai-round-cliff.ft-lockup.near",
                total: "3088800000000000000000000",
                locked: "3088800000000000000000000",
            }),
            publicToken({
                total: "1029600000000000000000000",
                locked: "0",
            }),
        ];

        const funding = getProposalFundingAvailability(
            transferProposal("500000000000000000000000"),
            tokens,
        );

        expect(funding).not.toBeNull();
        expect(funding!.available.toFixed()).toBe("1029600000000000000000000");
        expect(isFundingInsufficient(funding!)).toBe(false);
    });

    it("reports insufficient when liquid FT is below the required amount", () => {
        const tokens = [
            publicToken({
                lockupInstanceId: "bbf-publicai-round-cliff.ft-lockup.near",
                total: "3088800000000000000000000",
                locked: "3088800000000000000000000",
            }),
            publicToken({
                total: "100000000000000000000000",
                locked: "0",
            }),
        ];

        const funding = getProposalFundingAvailability(
            transferProposal("500000000000000000000000"),
            tokens,
        );

        expect(funding).not.toBeNull();
        expect(funding!.available.toFixed()).toBe("100000000000000000000000");
        expect(isFundingInsufficient(funding!)).toBe(true);
    });

    it("treats lockup-only FT as unspendable", () => {
        const tokens = [
            publicToken({
                lockupInstanceId: "bbf-publicai-round-cliff.ft-lockup.near",
                total: "3088800000000000000000000",
                locked: "3088800000000000000000000",
            }),
        ];

        const funding = getProposalFundingAvailability(
            transferProposal("500000000000000000000000"),
            tokens,
        );

        expect(funding).not.toBeNull();
        expect(funding!.available.toFixed()).toBe("0");
        expect(isFundingInsufficient(funding!)).toBe(true);
    });
});

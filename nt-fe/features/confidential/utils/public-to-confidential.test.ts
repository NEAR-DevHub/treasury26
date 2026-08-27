import { describe, expect, it } from "bun:test";
import {
    NEAR_NETWORK_ID,
    NEP141_WRAP_NEAR_ASSET_ID,
    WRAP_NEAR_TOKEN_ID,
} from "@/constants/network-ids";
import {
    NEP141_USDC_NEAR_ASSET_ID,
    USDC_NEAR_CONTRACT_ID,
} from "@/constants/token";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import {
    getProposalFundingAvailability,
    isFundingInsufficient,
} from "@/features/proposals/utils/proposal-funding";
import { getProposalUIKind } from "@/features/proposals/utils/proposal-utils";
import type { IntentsQuoteResponse, TreasuryAsset } from "@/lib/api";
import Big from "@/lib/big";
import { FT_TRANSFER_GAS, STORAGE_DEPOSIT_GAS } from "@/lib/near-ft-gas";
import type { Proposal } from "@/lib/proposals-api";
import { decodeArgs, encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import {
    buildPublicToConfidentialProposal,
    buildPublicToConfidentialQuoteRequest,
    extractPublicToConfidentialTransfer,
    isPublicToConfidentialProposal,
    PUBLIC_TO_CONFIDENTIAL_ACTION,
    PublicToConfidentialError,
    parsePublicTransferAmount,
    preparePublicToConfidentialTransfer,
    publicAssetResidency,
} from "./public-to-confidential";

const TREASURY_ID = "conf.sputnik-dao.near";
const PROPOSAL_PERIOD = `${60 * 60 * 1_000_000_000}`;
const DEPOSIT_ADDRESS =
    "d32b552aa188face5952516a370bc5a9d91f77a19c48d5b7b16e6c59eb79b08e";
const ONE_NEAR = "1000000000000000000000000";
const TEN_USDC = "10000000";

function asset(overrides: Partial<TreasuryAsset>): TreasuryAsset {
    return {
        id: "near",
        residency: "Near",
        network: NEAR_NETWORK_ID,
        chainName: "Near Protocol",
        symbol: "NEAR",
        balance: { type: "Standard", total: Big(ONE_NEAR), locked: Big(0) },
        decimals: 24,
        price: 2,
        name: "NEAR",
        icon: "",
        balanceUSD: 2,
        weight: 100,
        ...overrides,
    };
}

const NATIVE_NEAR = asset({});
const PUBLIC_USDC = asset({
    id: "usdc",
    contractId: USDC_NEAR_CONTRACT_ID,
    residency: "Ft",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    price: 1,
    balance: { type: "Standard", total: Big(TEN_USDC), locked: Big(0) },
});
const INTENTS_USDC = asset({
    ...PUBLIC_USDC,
    contractId: NEP141_USDC_NEAR_ASSET_ID,
    residency: "Intents",
});

function proposalWith(
    kind: Proposal["kind"],
    description = encodeToMarkdown({
        proposal_action: PUBLIC_TO_CONFIDENTIAL_ACTION,
    }),
    verified = true,
): Proposal {
    return {
        id: 1,
        description,
        kind,
        last_actions_log: null,
        proposer: "alice.near",
        status: "InProgress",
        submission_time: "0",
        vote_counts: {},
        votes: {},
        confidential_metadata: {
            public_move: {
                verified,
                deposit_address: DEPOSIT_ADDRESS,
                origin_asset: NEP141_WRAP_NEAR_ASSET_ID,
                amount_raw: ONE_NEAR,
            },
        },
    } as Proposal;
}

function quoteResponse(
    overrides: Partial<IntentsQuoteResponse["quote"]> = {},
): IntentsQuoteResponse {
    return {
        quote: {
            amountIn: ONE_NEAR,
            amountInFormatted: "1",
            amountInUsd: "2",
            minAmountIn: ONE_NEAR,
            amountOut: ONE_NEAR,
            amountOutFormatted: "1",
            amountOutUsd: "2",
            minAmountOut: ONE_NEAR,
            timeEstimate: 10,
            depositAddress: DEPOSIT_ADDRESS,
            deadline: "2026-09-01T00:00:00.000Z",
            timeWhenInactive: "2026-09-01T00:00:00.000Z",
            ...overrides,
        },
        quoteRequest: {
            originAsset: NEP141_WRAP_NEAR_ASSET_ID,
            destinationAsset: NEP141_WRAP_NEAR_ASSET_ID,
            amount: ONE_NEAR,
            deadline: "2026-08-28T00:00:00.000Z",
        },
        signature: "sig",
        timestamp: "2026-08-27T00:00:00.000Z",
        correlationId: "corr",
    };
}

describe("publicAssetResidency", () => {
    it("accepts liquid Near / Ft / Intents and rejects the rest", () => {
        expect(publicAssetResidency(NATIVE_NEAR)).toBe("Near");
        expect(publicAssetResidency(PUBLIC_USDC)).toBe("Ft");
        expect(publicAssetResidency(INTENTS_USDC)).toBe("Intents");
        expect(publicAssetResidency(asset({ residency: "Lockup" }))).toBeNull();
        expect(publicAssetResidency(asset({ residency: "Staked" }))).toBeNull();
        expect(
            publicAssetResidency(
                asset({ residency: "Ft", lockupInstanceId: "lockup.near" }),
            ),
        ).toBeNull();
    });
});

describe("parsePublicTransferAmount", () => {
    it("converts exact decimals to base units", () => {
        const result = parsePublicTransferAmount("2.5", PUBLIC_USDC);
        expect(result).toEqual({ ok: true, raw: "2500000" });
    });

    it("accepts the full available balance", () => {
        expect(parsePublicTransferAmount("10", PUBLIC_USDC)).toEqual({
            ok: true,
            raw: TEN_USDC,
        });
    });

    it("returns a plain base-unit string for large raw amounts", () => {
        expect(parsePublicTransferAmount("1", NATIVE_NEAR)).toEqual({
            ok: true,
            raw: ONE_NEAR,
        });
    });

    it("rejects amounts above the available balance", () => {
        expect(parsePublicTransferAmount("10.000001", PUBLIC_USDC)).toEqual({
            ok: false,
            error: "exceedsBalance",
        });
        const partiallyLocked = asset({
            ...PUBLIC_USDC,
            balance: {
                type: "Standard",
                total: Big(TEN_USDC),
                locked: Big("4000000"),
            },
        });
        expect(parsePublicTransferAmount("6.000001", partiallyLocked)).toEqual({
            ok: false,
            error: "exceedsBalance",
        });
    });

    it("rejects invalid, zero and over-precise input", () => {
        expect(parsePublicTransferAmount("abc", PUBLIC_USDC)).toEqual({
            ok: false,
            error: "invalid",
        });
        expect(parsePublicTransferAmount("", PUBLIC_USDC)).toEqual({
            ok: false,
            error: "invalid",
        });
        expect(parsePublicTransferAmount("0", PUBLIC_USDC)).toEqual({
            ok: false,
            error: "zero",
        });
        expect(parsePublicTransferAmount("1.0000001", PUBLIC_USDC)).toEqual({
            ok: false,
            error: "tooManyDecimals",
        });
    });
});

describe("buildPublicToConfidentialQuoteRequest", () => {
    it("quotes native NEAR from the public chain into the confidential balance", () => {
        const request = buildPublicToConfidentialQuoteRequest(
            TREASURY_ID,
            NATIVE_NEAR,
            ONE_NEAR,
            PROPOSAL_PERIOD,
        );
        expect(request).toMatchObject({
            daoId: TREASURY_ID,
            swapType: "EXACT_INPUT",
            slippageTolerance: 0,
            originAsset: NEP141_WRAP_NEAR_ASSET_ID,
            destinationAsset: NEP141_WRAP_NEAR_ASSET_ID,
            depositType: "ORIGIN_CHAIN",
            refundType: "ORIGIN_CHAIN",
            refundTo: TREASURY_ID,
            recipient: TREASURY_ID,
            recipientType: "CONFIDENTIAL_INTENTS",
            amount: ONE_NEAR,
            isPayment: true,
        });
        expect(Date.parse(request.deadline)).toBeGreaterThan(Date.now());
    });

    it("quotes NEP-141 with the nep141 asset id and ORIGIN_CHAIN", () => {
        const request = buildPublicToConfidentialQuoteRequest(
            TREASURY_ID,
            PUBLIC_USDC,
            TEN_USDC,
            PROPOSAL_PERIOD,
        );
        expect(request).toMatchObject({
            originAsset: NEP141_USDC_NEAR_ASSET_ID,
            destinationAsset: NEP141_USDC_NEAR_ASSET_ID,
            depositType: "ORIGIN_CHAIN",
            refundType: "ORIGIN_CHAIN",
            recipientType: "CONFIDENTIAL_INTENTS",
        });
    });

    it("quotes public intents balances with INTENTS origin", () => {
        const request = buildPublicToConfidentialQuoteRequest(
            TREASURY_ID,
            INTENTS_USDC,
            TEN_USDC,
            PROPOSAL_PERIOD,
        );
        expect(request).toMatchObject({
            originAsset: NEP141_USDC_NEAR_ASSET_ID,
            destinationAsset: NEP141_USDC_NEAR_ASSET_ID,
            depositType: "INTENTS",
            refundType: "INTENTS",
            recipientType: "CONFIDENTIAL_INTENTS",
        });
    });

    it("refuses lockup and staked rows", () => {
        expect(() =>
            buildPublicToConfidentialQuoteRequest(
                TREASURY_ID,
                asset({ residency: "Lockup" }),
                ONE_NEAR,
                PROPOSAL_PERIOD,
            ),
        ).toThrow(PublicToConfidentialError);
    });
});

describe("buildPublicToConfidentialProposal", () => {
    it("wraps and transfers native NEAR to the deposit address", () => {
        const { description, kind } = buildPublicToConfidentialProposal({
            asset: NATIVE_NEAR,
            amountRaw: ONE_NEAR,
            depositAddress: DEPOSIT_ADDRESS,
        });
        expect(description).toBe(
            `* Proposal Action: ${PUBLIC_TO_CONFIDENTIAL_ACTION}`,
        );
        expect(kind.FunctionCall.receiver_id).toBe(WRAP_NEAR_TOKEN_ID);
        const [deposit, transfer] = kind.FunctionCall.actions;
        expect(deposit).toMatchObject({
            method_name: "near_deposit",
            deposit: ONE_NEAR,
            gas: STORAGE_DEPOSIT_GAS,
        });
        expect(transfer).toMatchObject({
            method_name: "ft_transfer",
            deposit: "1",
            gas: FT_TRANSFER_GAS,
        });
        expect(decodeArgs(transfer.args)).toEqual({
            receiver_id: DEPOSIT_ADDRESS,
            amount: ONE_NEAR,
        });
    });

    it("ft_transfers NEP-141 from the token contract", () => {
        const { kind } = buildPublicToConfidentialProposal({
            asset: PUBLIC_USDC,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        });
        expect(kind.FunctionCall.receiver_id).toBe(USDC_NEAR_CONTRACT_ID);
        expect(kind.FunctionCall.actions).toHaveLength(1);
        expect(kind.FunctionCall.actions[0].method_name).toBe("ft_transfer");
        expect(decodeArgs(kind.FunctionCall.actions[0].args)).toEqual({
            receiver_id: DEPOSIT_ADDRESS,
            amount: TEN_USDC,
        });
    });

    it("mt_transfers public intents balances on intents.near", () => {
        const { kind } = buildPublicToConfidentialProposal({
            asset: INTENTS_USDC,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        });
        expect(kind.FunctionCall.receiver_id).toBe("intents.near");
        expect(kind.FunctionCall.actions[0].method_name).toBe("mt_transfer");
        expect(decodeArgs(kind.FunctionCall.actions[0].args)).toEqual({
            receiver_id: DEPOSIT_ADDRESS,
            amount: TEN_USDC,
            token_id: NEP141_USDC_NEAR_ASSET_ID,
        });
    });

    it("keeps the description to the marker only", () => {
        const { description } = buildPublicToConfidentialProposal({
            asset: PUBLIC_USDC,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        });
        expect(description).not.toContain(TREASURY_ID);
        expect(description).not.toContain(TEN_USDC);
        expect(description).not.toContain(DEPOSIT_ADDRESS);
    });

    it("throws without a deposit address", () => {
        expect(() =>
            buildPublicToConfidentialProposal({
                asset: PUBLIC_USDC,
                amountRaw: TEN_USDC,
                depositAddress: "",
            }),
        ).toThrow(PublicToConfidentialError);
    });
});

describe("preparePublicToConfidentialTransfer", () => {
    it("returns the wet quote and the proposal payload", async () => {
        const calls: Array<{ dry: boolean | undefined }> = [];
        const result = await preparePublicToConfidentialTransfer({
            treasuryId: TREASURY_ID,
            asset: NATIVE_NEAR,
            amountRaw: ONE_NEAR,
            proposalPeriod: PROPOSAL_PERIOD,
            fetchQuote: async (_request, dry) => {
                calls.push({ dry });
                return quoteResponse();
            },
        });
        expect(calls).toEqual([{ dry: false }]);
        expect(result.quote.quote.depositAddress).toBe(DEPOSIT_ADDRESS);
        expect(
            decodeArgs(result.proposal.kind.FunctionCall.actions[1].args)
                .receiver_id,
        ).toBe(DEPOSIT_ADDRESS);
    });

    it("fails safely on a missing deposit address", async () => {
        await expect(
            preparePublicToConfidentialTransfer({
                treasuryId: TREASURY_ID,
                asset: NATIVE_NEAR,
                amountRaw: ONE_NEAR,
                proposalPeriod: PROPOSAL_PERIOD,
                fetchQuote: async () => quoteResponse({ depositAddress: "" }),
            }),
        ).rejects.toMatchObject({ code: "missingDepositAddress" });
    });

    it("fails on an amountIn mismatch", async () => {
        await expect(
            preparePublicToConfidentialTransfer({
                treasuryId: TREASURY_ID,
                asset: NATIVE_NEAR,
                amountRaw: ONE_NEAR,
                proposalPeriod: PROPOSAL_PERIOD,
                fetchQuote: async () => quoteResponse({ amountIn: "1" }),
            }),
        ).rejects.toMatchObject({ code: "amountMismatch" });
    });

    it("fails when the quote is unavailable", async () => {
        await expect(
            preparePublicToConfidentialTransfer({
                treasuryId: TREASURY_ID,
                asset: NATIVE_NEAR,
                amountRaw: ONE_NEAR,
                proposalPeriod: PROPOSAL_PERIOD,
                fetchQuote: async () => null,
            }),
        ).rejects.toMatchObject({ code: "quoteUnavailable" });
    });
});

describe("proposal inspection", () => {
    const nearProposal = proposalWith(
        buildPublicToConfidentialProposal({
            asset: NATIVE_NEAR,
            amountRaw: ONE_NEAR,
            depositAddress: DEPOSIT_ADDRESS,
        }).kind,
    );
    const ftProposal = proposalWith(
        buildPublicToConfidentialProposal({
            asset: PUBLIC_USDC,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        }).kind,
    );
    const intentsProposal = proposalWith(
        buildPublicToConfidentialProposal({
            asset: INTENTS_USDC,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        }).kind,
    );

    it("recognises all three kinds", () => {
        expect(extractPublicToConfidentialTransfer(nearProposal)).toEqual({
            residency: "Near",
            tokenId: NEAR_NETWORK_ID,
            amountRaw: ONE_NEAR,
            depositAddress: DEPOSIT_ADDRESS,
        });
        expect(extractPublicToConfidentialTransfer(ftProposal)).toEqual({
            residency: "Ft",
            tokenId: USDC_NEAR_CONTRACT_ID,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        });
        expect(extractPublicToConfidentialTransfer(intentsProposal)).toEqual({
            residency: "Intents",
            tokenId: NEP141_USDC_NEAR_ASSET_ID,
            amountRaw: TEN_USDC,
            depositAddress: DEPOSIT_ADDRESS,
        });
    });

    it("ignores exchange, payment and confidential-signer proposals", () => {
        const exchange = proposalWith(
            ftProposal.kind,
            encodeToMarkdown({ proposal_action: "asset-exchange" }),
        );
        const payment = proposalWith(
            {
                Transfer: {
                    token_id: "",
                    receiver_id: "bob.near",
                    amount: ONE_NEAR,
                    msg: null,
                },
            },
            encodeToMarkdown({ proposal_action: "payment-transfer" }),
        );
        const signer = proposalWith(
            {
                FunctionCall: {
                    receiver_id: "v1.signer",
                    actions: [
                        {
                            method_name: "sign",
                            args: jsonToBase64({}),
                            deposit: "1",
                            gas: FT_TRANSFER_GAS,
                        },
                    ],
                },
            },
            encodeToMarkdown({ proposal_action: "confidential" }),
        );
        for (const proposal of [exchange, payment, signer]) {
            expect(isPublicToConfidentialProposal(proposal)).toBe(false);
            expect(extractPublicToConfidentialTransfer(proposal)).toBeNull();
        }
    });

    it("ignores the marker when the call shape is not a move", () => {
        const extraAction = proposalWith({
            FunctionCall: {
                receiver_id: USDC_NEAR_CONTRACT_ID,
                actions: [
                    {
                        method_name: "ft_transfer",
                        args: jsonToBase64({
                            receiver_id: DEPOSIT_ADDRESS,
                            amount: TEN_USDC,
                        }),
                        deposit: "1",
                        gas: FT_TRANSFER_GAS,
                    },
                    {
                        method_name: "storage_deposit",
                        args: jsonToBase64({}),
                        deposit: "1",
                        gas: FT_TRANSFER_GAS,
                    },
                ],
            },
        });
        const wrongMethod = proposalWith({
            FunctionCall: {
                receiver_id: "v1.signer",
                actions: [
                    {
                        method_name: "sign",
                        args: jsonToBase64({}),
                        deposit: "1",
                        gas: FT_TRANSFER_GAS,
                    },
                ],
            },
        });
        for (const proposal of [extraAction, wrongMethod]) {
            expect(isPublicToConfidentialProposal(proposal)).toBe(false);
            expect(getProposalUIKind(proposal)).not.toBe(
                "Move to Confidential",
            );
        }
    });

    it("renders as a raw function call until the backend verifies the quote", () => {
        const unverified = proposalWith(
            buildPublicToConfidentialProposal({
                asset: NATIVE_NEAR,
                amountRaw: ONE_NEAR,
                depositAddress: DEPOSIT_ADDRESS,
            }).kind,
            undefined,
            false,
        );
        expect(getProposalUIKind(unverified)).toBe("Function Call");
        expect(isPublicToConfidentialProposal(unverified)).toBe(false);
        expect(extractPublicToConfidentialTransfer(unverified)).toBeNull();

        const noMetadata = { ...unverified, confidential_metadata: undefined };
        expect(getProposalUIKind(noMetadata)).toBe("Function Call");
    });

    it("rejects a wrap call whose near_deposit differs from the transfer", () => {
        const mismatch = proposalWith({
            FunctionCall: {
                receiver_id: WRAP_NEAR_TOKEN_ID,
                actions: [
                    {
                        method_name: "near_deposit",
                        args: jsonToBase64({}),
                        deposit: "1",
                        gas: STORAGE_DEPOSIT_GAS,
                    },
                    {
                        method_name: "ft_transfer",
                        args: jsonToBase64({
                            receiver_id: DEPOSIT_ADDRESS,
                            amount: ONE_NEAR,
                        }),
                        deposit: "1",
                        gas: FT_TRANSFER_GAS,
                    },
                ],
            },
        });
        expect(getProposalUIKind(mismatch)).toBe("Function Call");
    });

    it("returns null for a marked proposal with malformed args", () => {
        const malformed = proposalWith({
            FunctionCall: {
                receiver_id: USDC_NEAR_CONTRACT_ID,
                actions: [
                    {
                        method_name: "ft_transfer",
                        args: "not-base64-json",
                        deposit: "1",
                        gas: FT_TRANSFER_GAS,
                    },
                ],
            },
        });
        expect(isPublicToConfidentialProposal(malformed)).toBe(false);
        expect(getProposalUIKind(malformed)).toBe("Function Call");
        expect(extractPublicToConfidentialTransfer(malformed)).toBeNull();
    });
});

describe("requests list integration", () => {
    const nearProposal = proposalWith(
        buildPublicToConfidentialProposal({
            asset: NATIVE_NEAR,
            amountRaw: ONE_NEAR,
            depositAddress: DEPOSIT_ADDRESS,
        }).kind,
    );

    it("classifies as Move to Confidential, sent to the treasury itself", () => {
        expect(getProposalUIKind(nearProposal)).toBe("Move to Confidential");
        const { type, data } = extractProposalData(nearProposal, TREASURY_ID);
        expect(type).toBe("Move to Confidential");
        // The on-chain receiver is shown as-is, never relabelled by the
        // marker, and doubles as the deposit address for settlement tracking.
        expect(data).toMatchObject({
            tokenId: NEAR_NETWORK_ID,
            amount: ONE_NEAR,
            receiver: DEPOSIT_ADDRESS,
            depositAddress: DEPOSIT_ADDRESS,
        });
    });

    it("is funded from the public balance, not the confidential assets", () => {
        const confidentialOnly = getProposalFundingAvailability(
            nearProposal,
            [INTENTS_USDC],
            TREASURY_ID,
            [],
        );
        expect(
            confidentialOnly && isFundingInsufficient(confidentialOnly),
        ).toBe(true);

        const withPublic = getProposalFundingAvailability(
            nearProposal,
            [INTENTS_USDC],
            TREASURY_ID,
            [NATIVE_NEAR],
        );
        expect(withPublic?.kind).toBe("liquid");
        expect(withPublic && isFundingInsufficient(withPublic)).toBe(false);
    });
});

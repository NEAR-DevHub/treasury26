import type { IntentsQuoteResponse } from "@/lib/api";
import type { Token } from "@/components/token-input";
import { FT_TRANSFER_GAS, STORAGE_DEPOSIT_GAS } from "@/lib/near-ft-gas";
import { buildIntentsTransferProposal } from "@/lib/near-proposal-builders";
import { encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import { NEAR_NETWORK_ID, WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

// NEP-141 `storage_deposit` registrations are handled by the backend at
// approval time (see nt-be relay storage_deposit derivation), so these builders
// only produce the proposal — no extra storage transactions.

interface ProposalBuilderParams {
    proposalData: IntentsQuoteResponse;
    sellToken: Token;
    receiveToken: Token;
    slippageTolerance: number;
    treasuryId: string;
    proposalBond: string;
}

interface ProposalAction {
    method_name: string;
    args: string;
    deposit: string;
    gas: string;
}

interface ProposalResult {
    description: string;
    kind: {
        FunctionCall: {
            receiver_id: string;
            actions: ProposalAction[];
        };
    };
}

interface ExchangeProposalResult {
    proposal: ProposalResult;
}

/**
 * Builds a proposal description with encoded metadata
 */
export function buildProposalDescription(
    proposalData: IntentsQuoteResponse,
    sellToken: Token,
    receiveToken: Token,
    slippageTolerance: number,
): string {
    const deadline = proposalData.quote.deadline;
    return encodeToMarkdown({
        proposal_action: "asset-exchange",
        notes: `**Must be executed before ${deadline}** for transferring tokens to 1Click's deposit address for swap execution.`,
        tokenInAddress: sellToken.address,
        tokenOutAddress: receiveToken.address,
        amountIn: proposalData.quote.amountInFormatted,
        amountOut: proposalData.quote.amountOutFormatted,
        slippage: slippageTolerance.toString(),
        quoteDeadline: deadline,
        timeEstimate: proposalData.quote.timeEstimate
            ? proposalData.quote.timeEstimate.toString()
            : undefined,
        depositAddress: proposalData.quote.depositAddress,
        signature: proposalData.signature,
    });
}

/**
 * Builds the proposal structure for native NEAR swaps
 */
export function buildNativeNEARProposal(
    params: ProposalBuilderParams,
): ExchangeProposalResult {
    const { proposalData, sellToken, receiveToken, slippageTolerance } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;

    return {
        proposal: {
            description: buildProposalDescription(
                proposalData,
                sellToken,
                receiveToken,
                slippageTolerance,
            ),
            kind: {
                FunctionCall: {
                    receiver_id: WRAP_NEAR_TOKEN_ID,
                    actions: [
                        {
                            method_name: "near_deposit",
                            args: jsonToBase64({}),
                            deposit: amountInSmallestUnit,
                            gas: STORAGE_DEPOSIT_GAS, // 10 TGas
                        },
                        {
                            method_name: "ft_transfer",
                            args: jsonToBase64({
                                receiver_id: proposalData.quote.depositAddress,
                                amount: amountInSmallestUnit,
                            }),
                            deposit: "1", // 1 yoctoNEAR for storage
                            gas: FT_TRANSFER_GAS, // 150 TGas
                        },
                    ],
                },
            },
        },
    };
}

/**
 * Builds the proposal structure for fungible token swaps
 * - For FT tokens (network === "near"): Use ft_transfer on the token contract
 * - For Intents tokens (network !== "near"): Use mt_transfer on intents.near
 */
export function buildFungibleTokenProposal(
    params: ProposalBuilderParams,
): ExchangeProposalResult {
    const { proposalData, sellToken, receiveToken, slippageTolerance } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;
    const originAsset = sellToken.address;
    const isNearToken =
        sellToken.network === NEAR_NETWORK_ID &&
        !sellToken.address.startsWith("nep141:") &&
        !sellToken.address.startsWith("nep245:");

    const description = buildProposalDescription(
        proposalData,
        sellToken,
        receiveToken,
        slippageTolerance,
    );

    if (isNearToken) {
        // For NEAR FT tokens: ft_transfer on the token contract directly.
        return {
            proposal: {
                description,
                kind: {
                    FunctionCall: {
                        receiver_id: sellToken.address,
                        actions: [
                            {
                                method_name: "ft_transfer",
                                args: jsonToBase64({
                                    receiver_id:
                                        proposalData.quote.depositAddress,
                                    amount: amountInSmallestUnit,
                                }),
                                deposit: "1", // 1 yoctoNEAR for storage
                                gas: FT_TRANSFER_GAS, // 150 TGas
                            },
                        ],
                    },
                },
            },
        };
    }

    // For intents tokens: mt_transfer on intents.near.
    return {
        proposal: {
            description,
            kind: buildIntentsTransferProposal(
                originAsset,
                proposalData.quote.depositAddress,
                amountInSmallestUnit,
            ),
        },
    };
}

/**
 * Builds a proposal for depositing native NEAR to get wNEAR (FT NEAR)
 * This wraps native NEAR into wNEAR on wrap.near contract
 */
export function buildNEARDepositProposal(
    params: ProposalBuilderParams,
): ExchangeProposalResult {
    const { proposalData, sellToken, receiveToken, slippageTolerance } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;

    return {
        proposal: {
            description: buildProposalDescription(
                proposalData,
                sellToken,
                receiveToken,
                slippageTolerance,
            ),
            kind: {
                FunctionCall: {
                    receiver_id: WRAP_NEAR_TOKEN_ID,
                    actions: [
                        {
                            method_name: "near_deposit",
                            args: jsonToBase64({}),
                            deposit: amountInSmallestUnit,
                            gas: STORAGE_DEPOSIT_GAS, // 10 TGas
                        },
                    ],
                },
            },
        },
    };
}

/**
 * Builds a proposal for withdrawing wNEAR (FT NEAR) to get native NEAR
 * This unwraps wNEAR on wrap.near contract back to native NEAR
 */
export function buildNEARWithdrawProposal(
    params: ProposalBuilderParams,
): ExchangeProposalResult {
    const { proposalData, sellToken, receiveToken, slippageTolerance } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;

    return {
        proposal: {
            description: buildProposalDescription(
                proposalData,
                sellToken,
                receiveToken,
                slippageTolerance,
            ),
            kind: {
                FunctionCall: {
                    receiver_id: WRAP_NEAR_TOKEN_ID,
                    actions: [
                        {
                            method_name: "near_withdraw",
                            args: jsonToBase64({
                                amount: amountInSmallestUnit,
                            }),
                            deposit: "1", // 1 yoctoNEAR for storage
                            gas: FT_TRANSFER_GAS, // 150 TGas
                        },
                    ],
                },
            },
        },
    };
}

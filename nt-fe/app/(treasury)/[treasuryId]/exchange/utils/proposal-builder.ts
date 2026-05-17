import { IntentsQuoteResponse } from "@/lib/api";
import { Token } from "@/components/token-input";
import { isNearChainFtToken } from "@/lib/intents-fee";
import { FT_TRANSFER_GAS, STORAGE_DEPOSIT_GAS } from "@/lib/near-ft-gas";
import {
    buildIntentsTransferProposal,
    buildNep141StorageDepositTx,
} from "@/lib/near-proposal-builders";
import { encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import { NEAR_NETWORK_ID, WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

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
    // All additional transactions needed (storage deposits, registrations, etc.)
    additionalTransactions?: Array<{
        receiverId: string;
        actions: Array<{
            type: "FunctionCall";
            params: {
                methodName: string;
                args: any;
                gas: string;
                deposit: string;
            };
        }>;
    }>;
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
 * Helper to check if a token is an FT token that requires storage deposit
 */
function isFTToken(token: Token): boolean {
    return isNearChainFtToken(token);
}

/**
 * Helper to normalize additional transactions array
 * Returns undefined if empty, otherwise returns the array
 */
function normalizeAdditionalTransactions(
    transactions: ExchangeProposalResult["additionalTransactions"],
): ExchangeProposalResult["additionalTransactions"] {
    return transactions && transactions.length > 0 ? transactions : undefined;
}

/**
 * Builds the proposal structure for native NEAR swaps
 * Checks if treasury is registered on wrap.near and only adds storage deposit if needed
 * Always adds deposit address registration (required for swap execution)
 */
export async function buildNativeNEARProposal(
    params: ProposalBuilderParams,
): Promise<ExchangeProposalResult> {
    const {
        proposalData,
        sellToken,
        receiveToken,
        slippageTolerance,
        treasuryId,
    } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;

    const additionalTransactions = [];

    // Check if treasury is registered on wrap.near
    const registrations = await getBatchStorageDepositIsRegistered([
        { accountId: treasuryId, tokenId: WRAP_NEAR_TOKEN_ID },
    ]);

    const isTreasuryRegistered =
        registrations.length > 0 && registrations[0].isRegistered;

    // 1. Storage deposit for treasury account on wrap.near (only if not registered)
    if (!isTreasuryRegistered) {
        additionalTransactions.push(
            buildNep141StorageDepositTx(WRAP_NEAR_TOKEN_ID, treasuryId),
        );
    }

    // 2. Storage deposit for deposit address on wrap.near (always needed)
    additionalTransactions.push(
        buildNep141StorageDepositTx(
            WRAP_NEAR_TOKEN_ID,
            proposalData.quote.depositAddress,
        ),
    );

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
        additionalTransactions: normalizeAdditionalTransactions(
            additionalTransactions,
        ),
    };
}

/**
 * Builds the proposal structure for fungible token swaps
 * - For FT tokens (network === "near"): Use ft_transfer on the token contract
 * - For Intents tokens (network !== "near"): Use mt_transfer on intents.near
 * Checks treasury registration on receive token (if FT) and only adds if needed
 * Always adds deposit address registration on sell token (if FT, required for swap execution)
 */
export async function buildFungibleTokenProposal(
    params: ProposalBuilderParams,
): Promise<ExchangeProposalResult> {
    const {
        proposalData,
        sellToken,
        receiveToken,
        slippageTolerance,
        treasuryId,
    } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;
    const originAsset = sellToken.address;
    const isNearToken =
        sellToken.network === NEAR_NETWORK_ID &&
        !sellToken.address.startsWith("nep141:") &&
        !sellToken.address.startsWith("nep245:");

    const additionalTransactions = [];

    // Check if receive token is FT and needs treasury registration
    const isReceiveFT = isFTToken(receiveToken);
    let isTreasuryRegisteredOnReceiveToken = false;

    if (isReceiveFT && receiveToken.address) {
        const registrations = await getBatchStorageDepositIsRegistered([
            {
                accountId: treasuryId,
                tokenId: receiveToken.address,
            },
        ]);
        isTreasuryRegisteredOnReceiveToken =
            registrations[0]?.isRegistered || false;
    }

    if (isNearToken) {
        // For NEAR FT tokens: always add deposit address registration on sell token
        additionalTransactions.push(
            buildNep141StorageDepositTx(
                sellToken.address,
                proposalData.quote.depositAddress,
            ),
        );

        // Add treasury registration on receive token only if not registered and it's FT
        if (
            isReceiveFT &&
            receiveToken.address &&
            !isTreasuryRegisteredOnReceiveToken
        ) {
            additionalTransactions.push(
                buildNep141StorageDepositTx(receiveToken.address, treasuryId),
            );
        }

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
                        receiver_id: sellToken.address, // Call the token contract directly
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
            additionalTransactions: normalizeAdditionalTransactions(
                additionalTransactions,
            ),
        };
    } else {
        // For intents tokens: no deposit address registration needed
        // Only add treasury registration on receive token if not registered and it's FT
        if (
            isReceiveFT &&
            receiveToken.address &&
            !isTreasuryRegisteredOnReceiveToken
        ) {
            additionalTransactions.push(
                buildNep141StorageDepositTx(receiveToken.address, treasuryId),
            );
        }

        return {
            proposal: {
                description: buildProposalDescription(
                    proposalData,
                    sellToken,
                    receiveToken,
                    slippageTolerance,
                ),
                kind: buildIntentsTransferProposal(
                    originAsset,
                    proposalData.quote.depositAddress,
                    amountInSmallestUnit,
                ),
            },
            additionalTransactions: normalizeAdditionalTransactions(
                additionalTransactions,
            ),
        };
    }
}

/**
 * Builds a proposal for depositing native NEAR to get wNEAR (FT NEAR)
 * This wraps native NEAR into wNEAR on wrap.near contract
 */
export async function buildNEARDepositProposal(
    params: ProposalBuilderParams,
): Promise<ExchangeProposalResult> {
    const {
        proposalData,
        sellToken,
        receiveToken,
        slippageTolerance,
        treasuryId,
    } = params;
    const amountInSmallestUnit = proposalData.quote.amountIn;

    // Check if treasury is registered on wrap.near
    const registrations = await getBatchStorageDepositIsRegistered([
        { accountId: treasuryId, tokenId: WRAP_NEAR_TOKEN_ID },
    ]);
    const isTreasuryRegistered =
        registrations.length > 0 && registrations[0].isRegistered;

    const additionalTransactions = [];

    // Only add storage deposit if not registered
    if (!isTreasuryRegistered) {
        additionalTransactions.push(
            buildNep141StorageDepositTx(WRAP_NEAR_TOKEN_ID, treasuryId),
        );
    }

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
        additionalTransactions: normalizeAdditionalTransactions(
            additionalTransactions,
        ),
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

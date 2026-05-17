import {
    getBatchStorageDepositIsRegistered,
    getStorageDepositIsRegistered,
} from "@/lib/api";
import type { FunctionCallKind, TransferKind } from "@/lib/proposals-api";
import type { Token } from "@/components/token-input";
import { default_near_token } from "@/constants/token";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import {
    type AdditionalTx,
    buildNativeNearIntentsKind,
    buildNearFtIntentsKind,
    buildNep141StorageDepositTx,
} from "@/lib/near-proposal-builders";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type ProposalResult = {
    kind: FunctionCallKind | TransferKind;
    additionalTransactions?: AdditionalTx[];
};

// ─── Proposal builders ────────────────────────────────────────────────────────

/**
 * Builds a Transfer kind for a direct NEAR or NEAR FT payment.
 * Native NEAR uses token_id="" as per the DAO contract convention.
 */
export function buildDirectTransferKind(
    address: string,
    token: Token,
    parsedAmount: string,
    isConfidential: boolean,
): TransferKind {
    const isNEAR = token.address === default_near_token(isConfidential).address;
    return {
        Transfer: {
            token_id: isNEAR ? "" : token.address,
            receiver_id: address,
            amount: parsedAmount,
            msg: null,
        },
    };
}

/**
 * Returns storage deposit txs needed for a direct NEAR FT transfer.
 * Empty array if the recipient is already registered on the token contract.
 */
export async function buildDirectFtStorageDepositTxs(
    recipient: string,
    tokenAddress: string,
): Promise<AdditionalTx[]> {
    const isRegistered = await getStorageDepositIsRegistered(
        recipient,
        tokenAddress,
    );
    return isRegistered
        ? []
        : [buildNep141StorageDepositTx(tokenAddress, recipient)];
}

/**
 * Builds the proposal for native NEAR routed through Intents:
 *   1. near_deposit on wrap.near (wraps NEAR → wNEAR)
 *   2. ft_transfer on wrap.near to the 1Click deposit address
 * Also registers the treasury and deposit address on wrap.near if needed.
 */
export async function buildNativeNEARIntentsProposal(params: {
    treasuryId: string;
    depositAddress: string;
    amountIn: string;
}): Promise<ProposalResult> {
    const { treasuryId, depositAddress, amountIn } = params;

    const registrations = await getBatchStorageDepositIsRegistered([
        { accountId: treasuryId, tokenId: WRAP_NEAR_TOKEN_ID },
        { accountId: depositAddress, tokenId: WRAP_NEAR_TOKEN_ID },
    ]);

    const additionalTransactions: AdditionalTx[] = [];
    if (!registrations[0]?.isRegistered) {
        additionalTransactions.push(
            buildNep141StorageDepositTx(WRAP_NEAR_TOKEN_ID, treasuryId),
        );
    }
    if (!registrations[1]?.isRegistered) {
        additionalTransactions.push(
            buildNep141StorageDepositTx(WRAP_NEAR_TOKEN_ID, depositAddress),
        );
    }

    return {
        kind: buildNativeNearIntentsKind(depositAddress, amountIn),
        additionalTransactions:
            additionalTransactions.length > 0
                ? additionalTransactions
                : undefined,
    };
}

/**
 * Builds the proposal for a NEAR FT routed through Intents:
 *   ft_transfer on the token contract to the 1Click deposit address.
 * Also registers the deposit address on the token contract if needed.
 */
export async function buildNearFtIntentsProposal(params: {
    tokenAddress: string;
    depositAddress: string;
    amountIn: string;
}): Promise<ProposalResult> {
    const { tokenAddress, depositAddress, amountIn } = params;

    const isDepositRegistered = await getStorageDepositIsRegistered(
        depositAddress,
        tokenAddress,
    );

    return {
        kind: buildNearFtIntentsKind(tokenAddress, depositAddress, amountIn),
        additionalTransactions: isDepositRegistered
            ? undefined
            : [buildNep141StorageDepositTx(tokenAddress, depositAddress)],
    };
}

import type { FunctionCallKind, TransferKind } from "@/lib/proposals-api";
import type { Token } from "@/components/token-input";
import { default_near_token } from "@/constants/token";
import {
    buildNativeNearIntentsKind,
    buildNearFtIntentsKind,
} from "@/lib/near-proposal-builders";

// ─── Proposal builders ────────────────────────────────────────────────────────
//
// NEP-141 `storage_deposit` registrations are handled by the backend at
// approval time (see nt-be relay storage_deposit derivation), so these builders
// only produce the proposal kind — no extra storage transactions.

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
 * Builds the proposal kind for native NEAR routed through Intents:
 *   1. near_deposit on wrap.near (wraps NEAR → wNEAR)
 *   2. ft_transfer on wrap.near to the 1Click deposit address
 */
export function buildNativeNEARIntentsProposal(
    depositAddress: string,
    amountIn: string,
): FunctionCallKind {
    return buildNativeNearIntentsKind(depositAddress, amountIn);
}

/**
 * Builds the proposal kind for a NEAR FT routed through Intents:
 *   ft_transfer on the token contract to the 1Click deposit address.
 */
export function buildNearFtIntentsProposal(
    tokenAddress: string,
    depositAddress: string,
    amountIn: string,
): FunctionCallKind {
    return buildNearFtIntentsKind(tokenAddress, depositAddress, amountIn);
}

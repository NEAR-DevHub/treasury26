import type { FunctionCallKind } from "@/lib/proposals-api";
import { FT_TRANSFER_GAS, STORAGE_DEPOSIT_GAS } from "@/lib/near-ft-gas";
import { decodeArgs, jsonToBase64 } from "@/lib/utils";
import { NEAR_NETWORK_ID, WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import Big from "@/lib/big";

export function buildIntentsTransferProposal(
    tokenAddress: string,
    depositAddress: string,
    amountIn: string,
): FunctionCallKind {
    return {
        FunctionCall: {
            receiver_id: "intents.near",
            actions: [
                {
                    method_name: "mt_transfer",
                    args: jsonToBase64({
                        receiver_id: depositAddress,
                        amount: amountIn,
                        token_id: tokenAddress,
                    }),
                    deposit: "1",
                    gas: FT_TRANSFER_GAS,
                },
            ],
        },
    };
}

export function buildNativeNearIntentsKind(
    depositAddress: string,
    amountIn: string,
): FunctionCallKind {
    return {
        FunctionCall: {
            receiver_id: WRAP_NEAR_TOKEN_ID,
            actions: [
                {
                    method_name: "near_deposit",
                    args: jsonToBase64({}),
                    deposit: amountIn,
                    gas: STORAGE_DEPOSIT_GAS,
                },
                {
                    method_name: "ft_transfer",
                    args: jsonToBase64({
                        receiver_id: depositAddress,
                        amount: amountIn,
                    }),
                    deposit: "1",
                    gas: FT_TRANSFER_GAS,
                },
            ],
        },
    };
}

export function buildNearFtIntentsKind(
    tokenAddress: string,
    depositAddress: string,
    amountIn: string,
): FunctionCallKind {
    return {
        FunctionCall: {
            receiver_id: tokenAddress,
            actions: [
                {
                    method_name: "ft_transfer",
                    args: jsonToBase64({
                        receiver_id: depositAddress,
                        amount: amountIn,
                    }),
                    deposit: "1",
                    gas: FT_TRANSFER_GAS,
                },
            ],
        },
    };
}

export interface IntentsDepositCall {
    residency: "Near" | "Ft" | "Intents";
    /** Display token id: `near`, the NEP-141 contract, or the intents token id. */
    tokenId: string;
    depositAddress: string;
    amountRaw: string;
}

function parseTransferArgs(
    args: string,
): { depositAddress: string; amountRaw: string; tokenId?: string } | null {
    const decoded = decodeArgs(args);
    if (!decoded || typeof decoded !== "object") return null;
    const { receiver_id, amount, token_id } = decoded as Record<
        string,
        unknown
    >;
    if (typeof receiver_id !== "string" || receiver_id.length === 0) {
        return null;
    }
    if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return null;
    if (Big(amount).lte(0)) return null;
    return {
        depositAddress: receiver_id,
        amountRaw: amount,
        tokenId: typeof token_id === "string" ? token_id : undefined,
    };
}

/**
 * Decode and validate a public-to-confidential move call — exactly the
 * shapes the builders above produce (wrap-and-transfer, single `ft_transfer`,
 * single `mt_transfer`), with decodable args, a receiver, a positive amount
 * and (for wrap) `near_deposit` == the transferred amount. Used to validate
 * the proposer-controlled `public-to-confidential` marker; anything else is
 * not a move.
 */
export function parseIntentsDepositKind(
    kind: unknown,
): IntentsDepositCall | null {
    if (!kind || typeof kind !== "object" || !("FunctionCall" in kind)) {
        return null;
    }
    const { receiver_id, actions } = (kind as FunctionCallKind).FunctionCall;
    if (receiver_id === WRAP_NEAR_TOKEN_ID) {
        if (actions.length !== 2) return null;
        const [wrap, transfer] = actions;
        if (
            wrap.method_name !== "near_deposit" ||
            transfer.method_name !== "ft_transfer" ||
            transfer.deposit !== "1"
        ) {
            return null;
        }
        const parsed = parseTransferArgs(transfer.args);
        if (!parsed || wrap.deposit !== parsed.amountRaw) return null;
        return {
            residency: "Near",
            tokenId: NEAR_NETWORK_ID,
            depositAddress: parsed.depositAddress,
            amountRaw: parsed.amountRaw,
        };
    }
    if (actions.length !== 1 || actions[0].deposit !== "1") return null;
    const [action] = actions;
    if (receiver_id === "intents.near") {
        if (action.method_name !== "mt_transfer") return null;
        const parsed = parseTransferArgs(action.args);
        if (!parsed?.tokenId) return null;
        return {
            residency: "Intents",
            tokenId: parsed.tokenId,
            depositAddress: parsed.depositAddress,
            amountRaw: parsed.amountRaw,
        };
    }
    if (action.method_name !== "ft_transfer") return null;
    const parsed = parseTransferArgs(action.args);
    if (!parsed) return null;
    return {
        residency: "Ft",
        tokenId: receiver_id,
        depositAddress: parsed.depositAddress,
        amountRaw: parsed.amountRaw,
    };
}

export function isIntentsDepositKind(kind: unknown): kind is FunctionCallKind {
    return parseIntentsDepositKind(kind) !== null;
}

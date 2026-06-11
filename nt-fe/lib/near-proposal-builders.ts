import type { FunctionCallKind } from "@/lib/proposals-api";
import { FT_TRANSFER_GAS, STORAGE_DEPOSIT_GAS } from "@/lib/near-ft-gas";
import { jsonToBase64 } from "@/lib/utils";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

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

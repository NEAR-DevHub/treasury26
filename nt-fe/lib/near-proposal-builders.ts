import type { FunctionCallKind } from "@/lib/proposals-api";
import {
    FT_TRANSFER_GAS,
    STORAGE_DEPOSIT_AMOUNT,
    STORAGE_DEPOSIT_GAS,
} from "@/lib/near-ft-gas";
import { jsonToBase64 } from "@/lib/utils";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

type FunctionCallTxAction = {
    type: "FunctionCall";
    params: {
        methodName: string;
        args: Record<string, unknown>;
        gas: string;
        deposit: string;
    };
};

export type AdditionalTx = {
    receiverId: string;
    actions: FunctionCallTxAction[];
};

export function buildNep141StorageDepositTx(
    receiverId: string,
    accountId: string,
): AdditionalTx {
    return {
        receiverId,
        actions: [
            {
                type: "FunctionCall",
                params: {
                    methodName: "storage_deposit",
                    args: {
                        account_id: accountId,
                        registration_only: true,
                    },
                    gas: STORAGE_DEPOSIT_GAS,
                    deposit: STORAGE_DEPOSIT_AMOUNT,
                },
            },
        ],
    };
}

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

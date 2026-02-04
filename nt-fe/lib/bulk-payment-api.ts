import axios from "axios";

// Bulk Payment Contract Configuration
export const BULK_PAYMENT_CONTRACT_ID =
    process.env.NEXT_PUBLIC_BULK_PAYMENT_CONTRACT_ID || "bulkpayment.near";

// Backend API base URL
const BACKEND_API_BASE =
    process.env.NEXT_PUBLIC_BACKEND_API_BASE || "http://localhost:3001";

// Maximum number of recipients per bulk payment import
export const MAX_RECIPIENTS_PER_BULK_PAYMENT = 25;

/**
 * Generate a deterministic list_id (SHA-256 hash of canonical JSON)
 * Must match the backend's hash calculation
 */
export async function generateListId(
    submitterId: string,
    tokenId: string,
    payments: Array<{ recipient: string; amount: string }>,
): Promise<string> {
    // Sort payments by recipient for deterministic ordering (must match API)
    const sortedPayments = [...payments].sort((a, b) =>
        a.recipient.localeCompare(b.recipient),
    );

    // Create canonical JSON with alphabetically sorted keys (matches Rust serde_json)
    const canonical = JSON.stringify({
        payments: sortedPayments.map((p) => ({
            amount: p.amount,
            recipient: p.recipient,
        })),
        submitter: submitterId,
        token_id: tokenId,
    });

    if (typeof window !== "undefined" && window.crypto?.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(canonical);
        const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    throw new Error("SubtleCrypto not available");
}

/**
 * Submit payment list to the backend API
 */
export async function submitPaymentList(params: {
    listId: string;
    submitterId: string;
    daoContractId: string;
    tokenId: string;
    payments: Array<{ recipient: string; amount: string }>;
}): Promise<{ success: boolean; listId?: string; error?: string }> {
    try {
        const response = await axios.post(
            `${BACKEND_API_BASE}/api/bulk-payment/submit-list`,
            {
                listId: params.listId,
                submitterId: params.submitterId,
                daoContractId: params.daoContractId,
                tokenId: params.tokenId,
                payments: params.payments,
            },
            { withCredentials: true },
        );
        return response.data;
    } catch (error: any) {
        console.error("Error submitting payment list:", error);
        return { success: false, error: error.message };
    }
}

/**
 * Build the proposal transaction for bulk payment
 *
 * Supports three types of tokens:
 * 1. NEAR: Uses approve_list with deposit
 * 2. FT (Fungible Tokens): Uses ft_transfer_call
 * 3. Intents (Multi-Tokens): Uses mt_transfer_call for cross-chain assets
 *    - Token ID format: "nep141:btc.omft.near" (NEP-245 multi-token standard)
 */
export async function buildApproveListProposal(params: {
    daoAccountId: string;
    listId: string;
    tokenId: string;
    tokenResidency: "Near" | "Ft" | "Intents";
    totalAmount: string;
    description: string;
    proposalBond: string;
}): Promise<{
    contractName: string;
    methodName: string;
    args: any;
    gas: string;
    deposit: string;
}> {
    const {
        daoAccountId,
        listId,
        tokenId,
        tokenResidency,
        totalAmount,
        description,
        proposalBond,
    } = params;
    const isNEAR = tokenResidency === "Near";
    const isIntents = tokenResidency === "Intents";
    const gas = "300000000000000"; // 300 TGas

    if (isNEAR) {
        // For NEAR: FunctionCall proposal with deposit for approve_list
        return {
            contractName: daoAccountId,
            methodName: "add_proposal",
            args: {
                proposal: {
                    description,
                    kind: {
                        FunctionCall: {
                            receiver_id: BULK_PAYMENT_CONTRACT_ID,
                            actions: [
                                {
                                    method_name: "approve_list",
                                    args: Buffer.from(
                                        JSON.stringify({ list_id: listId }),
                                    ).toString("base64"),
                                    deposit: totalAmount, // Total amount to fund payments
                                    gas: "150000000000000", // 150 TGas
                                },
                            ],
                        },
                    },
                },
            },
            gas,
            deposit: proposalBond,
        };
    } else if (isIntents) {
        // For Intents (Multi-Tokens): FunctionCall proposal with mt_transfer_call
        // Token ID format: "nep141:btc.omft.near" (NEP-245 multi-token standard)
        const intentsContractId = "intents.near";
        const actions = [
            {
                method_name: "mt_transfer_call",
                args: Buffer.from(
                    JSON.stringify({
                        receiver_id: BULK_PAYMENT_CONTRACT_ID,
                        token_id: tokenId, // Full multi-token ID like "nep141:btc.omft.near"
                        amount: totalAmount,
                        msg: listId, // list_id as the message
                    }),
                ).toString("base64"),
                deposit: "1", // 1 yoctoNEAR for mt_transfer_call
                gas: "150000000000000", // 150 TGas
            },
        ];

        return {
            contractName: daoAccountId,
            methodName: "add_proposal",
            args: {
                proposal: {
                    description,
                    kind: {
                        FunctionCall: {
                            receiver_id: intentsContractId,
                            actions: actions,
                        },
                    },
                },
            },
            gas,
            deposit: proposalBond,
        };
    } else {
        // For FT: FunctionCall proposal with ft_transfer_call
        const actions = [
            {
                method_name: "ft_transfer_call",
                args: Buffer.from(
                    JSON.stringify({
                        receiver_id: BULK_PAYMENT_CONTRACT_ID,
                        amount: totalAmount,
                        msg: listId, // list_id as the message
                    }),
                ).toString("base64"),
                deposit: "1", // 1 yoctoNEAR for ft_transfer_call
                gas: "100000000000000", // 100 TGas
            },
        ];

        return {
            contractName: daoAccountId,
            methodName: "add_proposal",
            args: {
                proposal: {
                    description,
                    kind: {
                        FunctionCall: {
                            receiver_id: tokenId, // Call the token contract
                            actions: actions,
                        },
                    },
                },
            },
            gas,
            deposit: proposalBond,
        };
    }
}

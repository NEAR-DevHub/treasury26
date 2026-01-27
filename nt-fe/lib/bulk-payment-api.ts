// Bulk Payment Contract Configuration
export const BULK_PAYMENT_CONTRACT_ID = process.env.NEXT_PUBLIC_BULK_PAYMENT_CONTRACT_ID || 'bulkpayment.near';

// Backend API base URL
const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "http://localhost:3001";

// Maximum number of recipients per bulk payment import
export const MAX_RECIPIENTS_PER_BULK_PAYMENT = 25;

/**
 * Generate a deterministic list_id (SHA-256 hash of canonical JSON)
 * Must match the backend's hash calculation
 */
export async function generateListId(
  submitterId: string,
  tokenId: string,
  payments: Array<{ recipient: string; amount: string }>
): Promise<string> {
  // Sort payments by recipient for deterministic ordering (must match API)
  const sortedPayments = [...payments].sort((a, b) =>
    a.recipient.localeCompare(b.recipient)
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

  // For browser compatibility, use SubtleCrypto
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
 * Execute payout_batch for an approved bulk payment list
 * The backend will continuously call the contract until all payments are processed
 * Returns the total number of batches and payments processed
 */
export async function payoutBatch(listId: string): Promise<{
  success: boolean;
  total_batches_processed: number;
  total_payments_processed: number;
  error?: string;
}> {
  const response = await fetch(`${BACKEND_API_BASE}/api/bulk-payment/payout-batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      list_id: listId,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Failed to execute payout batch: ${response.statusText}`);
  }

  return data;
}

/**
 * View storage credits for a DAO in the bulk payment contract
 * 
 * Storage credits represent the number of payment records (recipients) that can be stored.
 * Each credit allows storage for one payment record.
 * 
 * Returns the number of bulk payments available per month (credits / 25).
 * Each bulk payment can contain up to 25 recipients.
 */
export async function viewStorageCredits(daoAccountId: string): Promise<number> {
  try {
    const response = await fetch(
      `${BACKEND_API_BASE}/api/bulk-payment/storage-credits?account_id=${encodeURIComponent(daoAccountId)}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: { success: boolean; credits?: string; error?: string } = await response.json();

    if (!data.success || !data.credits) {
      console.warn("Failed to fetch storage credits:", data.error);
      return 0;
    }
    const creditsCount = parseInt(data.credits, 10);
    
    // Convert credits to bulk payments per month (each bulk payment = 25 recipients max)
    const bulkPaymentsPerMonth = Math.floor(creditsCount / MAX_RECIPIENTS_PER_BULK_PAYMENT);
    
    return bulkPaymentsPerMonth;
  } catch (error) {
    console.warn("Error fetching storage credits:", error);
    return 0;
  }
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
}): Promise<{ success: boolean; list_id?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_API_BASE}/api/bulk-payment/submit-list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        list_id: params.listId,
        submitter_id: params.submitterId,
        dao_contract_id: params.daoContractId,
        token_id: params.tokenId,
        payments: params.payments,
      }),
    });

    const data = await response.json();
    return data;
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
  const { daoAccountId, listId, tokenId, tokenResidency, totalAmount, description, proposalBond } = params;
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
                    JSON.stringify({ list_id: listId })
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
          })
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
          })
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

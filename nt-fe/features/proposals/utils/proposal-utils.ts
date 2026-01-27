import { getKindFromProposal } from "@/lib/config-utils";
import { Proposal, ProposalStatus } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { ProposalUIKind } from "../types/index";
import { decodeArgs, decodeProposalDescription } from "@/lib/utils";

const BULK_PAYMENT_CONTRACT_ID = process.env.NEXT_PUBLIC_BULK_PAYMENT_CONTRACT_ID || "bulkpayment.near";

function isVestingProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;
  const receiver = functionCall.receiver_id;
  const isLockup = receiver.includes('lockup.near') || receiver === 'lockup.near';
  const firstAction = functionCall.actions[0];
  return isLockup && firstAction?.method_name === 'create';
}

function isBatchPaymentProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;

  // Check if calling bulk payment contract directly (NEAR payments)
  if (functionCall.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
    if (functionCall.actions.some(action => action.method_name === 'approve_list')) {
      return true;
    }
  }

  // Check if calling intents contract
  if(functionCall.actions.some(action => action.method_name === 'mt_transfer_call')) {
    const mtTransferAction = functionCall.actions.find(action => action.method_name === 'mt_transfer_call');
    if (mtTransferAction) {
      const args = decodeArgs(mtTransferAction.args);
      if (args?.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
        return true;
      }
    }
  }

  // Check if calling ft contract
  if(functionCall.actions.some(action => action.method_name === 'ft_transfer_call')) {
    const ftTransferAction = functionCall.actions.find(action => action.method_name === 'ft_transfer_call');
    if (ftTransferAction) {
      const args = decodeArgs(ftTransferAction.args);
      if (args?.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
        return true;
      }
    }
  }

  
  return false;
}

function processFTTransferProposal(proposal: Proposal): "Payment Request" | "Batch Payment Request" | "Exchange" | undefined {
  if (!('FunctionCall' in proposal.kind)) return undefined;
  const functionCall = proposal.kind.FunctionCall;
  if (isIntentWithdrawProposal(proposal) || isLookupTransferProposal(proposal)) {
    return "Payment Request" as const;
  }
  const proposalType = decodeProposalDescription("proposal action", proposal.description) === "asset-exchange";
  if (proposalType) {
    return "Exchange" as const;
  }

  if (functionCall.receiver_id === 'wrap.near' && functionCall.actions.some(action => action.method_name === 'near_withdraw' || action.method_name === 'near_deposit')) {
    return "Exchange" as const;
  }

  const action = functionCall.actions.find(action => action.method_name === 'ft_transfer' || action.method_name === 'ft_transfer_call');
  if (!action) return undefined;
  if (action.method_name === 'ft_transfer') {
    return "Payment Request" as const;
  }
  const args = decodeArgs(action.args);
  if (!args) return undefined;
  if (args.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
    return "Batch Payment Request" as const;
  }
  return "Payment Request" as const;
}

function processMTTransferProposal(proposal: Proposal): "Exchange" | "Batch Payment Request" | undefined {
  if (!('FunctionCall' in proposal.kind)) return undefined;
  const functionCall = proposal.kind.FunctionCall;
  const transfer = functionCall.actions.find(action => action.method_name === 'mt_transfer' || action.method_name === 'mt_transfer_call');
  if (transfer) {
    const args = decodeArgs(transfer?.args as string);
    if (args?.receiver_id === "bulkpayment.near") {
      return "Batch Payment Request" as const;
    }
    return "Exchange" as const;
  }
  return undefined;
}

function isIntentWithdrawProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;
  return functionCall.receiver_id === 'intents.near' && functionCall.actions.some(action => action.method_name === 'ft_withdraw');
}

function isLookupTransferProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;
  return functionCall.receiver_id.endsWith('.lockup.near') && functionCall.actions.some(action => action.method_name === 'transfer');
}

function stakingType(proposal: Proposal): "Earn NEAR" | "Withdraw Earnings" | "Unstake NEAR" | undefined {
  if (!('FunctionCall' in proposal.kind)) return undefined;
  const functionCall = proposal.kind.FunctionCall;

  const isPool = functionCall.receiver_id.endsWith('poolv1.near') || functionCall.receiver_id.endsWith('lockup.near');
  if (!isPool) return undefined;
  if (functionCall.actions.some(action => action.method_name === 'stake' || action.method_name === 'deposit_and_stake' || action.method_name === 'deposit')) {
    return "Earn NEAR";
  }
  if (functionCall.actions.some(action => action.method_name === 'withdraw' || action.method_name === 'withdraw_all' || action.method_name === 'withdraw_all_from_staking_pool')) {
    return "Withdraw Earnings";
  }
  if (functionCall.actions.some(action => action.method_name === 'unstake')) {
    return "Unstake NEAR";
  }
  return undefined;

}

/**
 * Determines the UI kind/category for a proposal
 * This classifies proposals into user-facing categories for display
 * @param proposal The proposal to classify
 * @returns The UI kind of the proposal
 */
export function getProposalUIKind(proposal: Proposal): ProposalUIKind {
  const proposalType = getKindFromProposal(proposal.kind);
  switch (proposalType) {
    case "transfer":
      return "Payment Request";
    case "call":
      if (isVestingProposal(proposal)) {
        return "Vesting";
      }
      const ftTransferResult = processFTTransferProposal(proposal);
      if (ftTransferResult) {
        return ftTransferResult;
      }
      if (isBatchPaymentProposal(proposal)) {
        return "Batch Payment Request";
      }
      const mtTransferResult = processMTTransferProposal(proposal);
      if (mtTransferResult) {
        return mtTransferResult;
      }
      const stakingTypeResult = stakingType(proposal);
      if (stakingTypeResult) {
        return stakingTypeResult;
      }
      return "Function Call";
    case "policy":
      return "Change Policy";
    case "config":
      return "Update General Settings";
    case "upgrade_self":
    case "upgrade_remote":
      return "Upgrade";
    default:
      return "Unsupported";
  }
}

export type UIProposalStatus = "Executed" | "Rejected" | "Pending" | "Expired" | "Removed" | "Moved";

export function getProposalStatus(proposal: Proposal, policy: Policy): UIProposalStatus {
  const proposalPeriod = parseInt(policy.proposal_period);
  const submissionTime = parseInt(proposal.submission_time);

  switch (proposal.status) {
    case "Approved":
      return "Executed";
    case "Rejected":
      return "Rejected";
    case "Failed":
      return "Rejected";
    case "InProgress":
      if ((submissionTime + proposalPeriod) / 1_000_000 < Date.now()) {
        return "Expired";
      }
      return "Pending";
    default:
      return proposal.status;
  }
}


/**
 * Helper to extract token ID and amount required for a proposal
 */
export function getProposalRequiredFunds(proposal: Proposal): { tokenId: string; amount: string } | null {
  // Transfer proposal
  if ("Transfer" in proposal.kind) {
    const transfer = proposal.kind.Transfer;
    const tokenId = transfer.token_id.length > 0 ? transfer.token_id : "near";
    return { tokenId, amount: transfer.amount };
  }

  // FunctionCall proposal
  if ("FunctionCall" in proposal.kind) {
    const functionCall = proposal.kind.FunctionCall;
    const actions = functionCall.actions;

    // Check for ft_transfer or ft_transfer_call (Payment Request)
    const ftTransferAction = actions.find(
      (a) => a.method_name === "ft_transfer" || a.method_name === "ft_transfer_call" || a.method_name === "mt_transfer" || a.method_name === "mt_transfer_call"
    );
    if (ftTransferAction) {
      const args = decodeArgs(ftTransferAction.args);
      if (args?.amount) {
        return { tokenId: ftTransferAction.method_name === "mt_transfer" || ftTransferAction.method_name === "mt_transfer_call" ? args.token_id : functionCall.receiver_id, amount: args.amount };
      }
    }

    // Check for ft_withdraw (Intents withdrawal)
    const ftWithdrawAction = actions.find((a) => a.method_name === "ft_withdraw");
    if (ftWithdrawAction) {
      const args = decodeArgs(ftWithdrawAction.args);
      if (args?.amount && args?.token) {
        return { tokenId: `nep141:${args.token}`, amount: args.amount };
      }
    }

    // Check for mt_transfer or mt_transfer_call (Exchange - intents)
    const mtTransferAction = actions.find(
      (a) => a.method_name === "mt_transfer" || a.method_name === "mt_transfer_call"
    );
    if (mtTransferAction) {
      const args = decodeArgs(mtTransferAction.args);
      if (args?.amount && args?.token_id) {
        return { tokenId: args.token_id, amount: args.amount };
      }
    }

    // Check for near_withdraw (wrap.near unwrap)
    const nearWithdrawAction = actions.find((a) => a.method_name === "near_withdraw");
    if (nearWithdrawAction && functionCall.receiver_id === "wrap.near") {
      const args = decodeArgs(nearWithdrawAction.args);
      if (args?.amount) {
        return { tokenId: "wrap.near", amount: args.amount };
      }
    }

    // Check for near_deposit (wrap.near wrap) - uses deposit amount
    const nearDepositAction = actions.find((a) => a.method_name === "near_deposit");
    if (nearDepositAction && functionCall.receiver_id === "wrap.near") {
      if (nearDepositAction.deposit && nearDepositAction.deposit !== "0") {
        return { tokenId: "near", amount: nearDepositAction.deposit };
      }
    }

    // Check for approve_list (Batch Payment with NEAR)
    const approveListAction = actions.find((a) => a.method_name === "approve_list");
    if (approveListAction && functionCall.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
      if (approveListAction.deposit && approveListAction.deposit !== "0") {
        return { tokenId: "near", amount: approveListAction.deposit };
      }
    }

    // Staking proposals (deposit_and_stake, stake, deposit)
    const stakingAction = actions.find((a) => a.method_name === "deposit_and_stake" || a.method_name === "deposit");
    if (stakingAction) {
      const args = decodeArgs(stakingAction.args);
      if (args?.amount) {
        return { tokenId: "near", amount: args.amount };
      }
    }

    // Vesting proposal (create with NEAR deposit)
    const createAction = actions.find((a) => a.method_name === "create");
    if (createAction && functionCall.receiver_id.includes("lockup.near")) {
      if (createAction.deposit && createAction.deposit !== "0") {
        return { tokenId: "near", amount: createAction.deposit };
      }
    }
  }

  return null;
}


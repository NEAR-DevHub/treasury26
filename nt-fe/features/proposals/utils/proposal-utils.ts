import { getKindFromProposal } from "@/lib/config-utils";
import { Proposal, ProposalStatus } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { ProposalUIKind } from "../types/index";
import { decodeArgs } from "@/lib/utils";

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

  if (functionCall.receiver_id !== 'bulkpayment.near') {
    return false;
  }

  if (functionCall.actions.some(action => action.method_name === 'approve_list')) {
    return true;
  }
  return false;
}

function processFTTransferProposal(proposal: Proposal): "Payment Request" | "Batch Payment Request" | undefined {
  if (!('FunctionCall' in proposal.kind)) return undefined;
  const functionCall = proposal.kind.FunctionCall;
  if (isIntentWithdrawProposal(proposal)) {
    return "Payment Request" as const;
  }
  const action = functionCall.actions.find(action => action.method_name === 'ft_transfer' || action.method_name === 'ft_transfer_call');
  if (!action) return undefined;
  if (action.method_name === 'ft_transfer') {
    return "Payment Request" as const;
  }
  const args = decodeArgs(action.args);
  if (!args) return undefined;
  if (args.receiver_id === "bulkpayment.near") {
    return "Batch Payment Request" as const;
  }
  return "Payment Request" as const;
}

function isMTTransferProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;
  return functionCall.actions.some(action => action.method_name === 'mt_transfer' || action.method_name === 'mt_transfer_call');
}

function isIntentWithdrawProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;
  return functionCall.receiver_id === 'intents.near' && functionCall.actions.some(action => action.method_name === 'ft_withdraw');
}

function stakingType(proposal: Proposal): "Earn NEAR" | "Withdraw Earnings" | "Unstake NEAR" | undefined {
  if (!('FunctionCall' in proposal.kind)) return undefined;
  const functionCall = proposal.kind.FunctionCall;

  if (isIntentWithdrawProposal(proposal)) {
    return "Withdraw Earnings";
  }

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
      if (isMTTransferProposal(proposal)) {
        return "Exchange";
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

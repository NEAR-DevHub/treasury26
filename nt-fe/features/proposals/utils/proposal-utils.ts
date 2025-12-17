import { getKindFromProposal } from "@/lib/config-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";

function isVestingProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;
  const receiver = functionCall.receiver_id;
  const isLockup = receiver.includes('lockup.near') || receiver === 'lockup.near';
  const firstAction = functionCall.actions[0];
  return isLockup && firstAction?.method_name === 'create';
}

function isFTTransferProposal(proposal: Proposal): boolean {
  if (!('FunctionCall' in proposal.kind)) return false;
  const functionCall = proposal.kind.FunctionCall;

  return functionCall.actions.some(action => action.method_name === 'ft_transfer' || action.method_name === 'ft_transfer_call');
}

export function getProposalType(proposal: Proposal) {
  const proposalType = getKindFromProposal(proposal.kind);
  switch (proposalType) {
    case "transfer":
      return "Payment Request";
    case "call":
      if (isVestingProposal(proposal)) {
        return "Vesting";
      }
      if (isFTTransferProposal(proposal)) {
        return "Payment Request";
      }
      return "Function Call";
    case "policy":
      return "Change Policy";
    default:
      return "Unknown";
  }
}

export function getProposalStatus(proposal: Proposal, policy: Policy): string {
  const { proposal_period } = policy;
  const proposalPeriod = parseInt(proposal_period);
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

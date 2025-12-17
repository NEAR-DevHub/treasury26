import type { Policy, RoleKind } from "@/types/policy";
import { ProposalKind } from "./proposals-api";

export type ProposalPermissionKind = "transfer" | "call" | "policy" | "config";


export function getKindFromProposal(proposalKind: ProposalKind): ProposalPermissionKind | undefined {
  if ('Transfer' in proposalKind) {
    return "transfer";
  }

  if ('FunctionCall' in proposalKind) {
    return "call";
  }

  if ('ChangePolicy' in proposalKind) {
    return "policy";
  }

  if ('ChangeConfig' in proposalKind) {
    return "config";
  }

  return undefined;
}


/**
 * Calculates the required number of votes and lists the approvers for a given action kind.
 *
 * @param daoPolicy - The DAO's policy configuration
 * @param accountId - The account ID of the user checking permissions
 * @param kind - The kind of proposal/action (e.g. "Transfer", "AddMember")
 * @param isDeleteCheck - Whether to check for delete permissions (VoteRemove) instead of approve/reject
 * @returns Object containing the list of approver accounts and the required vote count
 */
export function getApproversAndThreshold(daoPolicy: Policy, accountId: string, kindType: ProposalKind | ProposalPermissionKind, isDeleteCheck: boolean) {
  const kind: ProposalPermissionKind = typeof kindType === "string" ? kindType : getKindFromProposal(kindType)!;
  const groupWithPermission = (daoPolicy?.roles ?? []).filter((role) => {
    const permissions = isDeleteCheck
      ? ["*:*", `${kind}:*`, `${kind}:VoteRemove`, "*:VoteRemove"]
      : [
        "*:*",
        `${kind}:*`,
        `${kind}:VoteApprove`,
        `${kind}:VoteReject`,
        "*:VoteApprove",
        "*:VoteReject",
      ];
    return (role?.permissions ?? []).some((i) => permissions.includes(i));
  });

  let approversGroup: string[] = [];
  let ratios: number[] = [];
  let requiredVotes = null;
  let everyoneHasAccess = false;
  // if group kind is everyone, current user will have access
  groupWithPermission.map((i) => {
    approversGroup = approversGroup.concat(("Group" in i.kind) ? i.kind.Group : []);
    everyoneHasAccess = "Everyone" in i.kind;
    const votePolicy =
      Object.values(i?.vote_policy?.[kind] ?? {}).length > 0
        ? i.vote_policy[kind]
        : daoPolicy.default_vote_policy;
    if (votePolicy.weight_kind === "RoleWeight") {
      if (Array.isArray(votePolicy.threshold)) {
        ratios = ratios.concat(votePolicy.threshold);
        ratios = ratios.concat(votePolicy.threshold);
      } else {
        requiredVotes = parseFloat(votePolicy.threshold as string);
      }
    }
  });

  let numerator = 0;
  let denominator = 0;

  if (ratios.length > 0) {
    ratios.forEach((value, index) => {
      if (index == 0 || index % 2 === 0) {
        // Even index -> numerator
        numerator += value;
      } else {
        // Odd index -> denominator
        denominator += value;
      }
    });
  }
  const approverAccounts = Array.from(new Set(approversGroup));

  return {
    // if everyoneHasAccess, current account doesn't change the requiredVotes
    approverAccounts:
      everyoneHasAccess && accountId
        ? [...approverAccounts, accountId]
        : approverAccounts,

    requiredVotes:
      typeof requiredVotes === "number"
        ? requiredVotes
        : Math.floor((numerator / denominator) * approverAccounts.length) + 1,
  };
}

/**
 * Check if a user has permission for a specific action in the policy
 *
 * @param policy - The versioned policy from the treasury
 * @param accountId - The user's account ID
 * @param permission - The permission string to check (e.g. "Transfer:*")
 * @returns true if the user has the permission
 */
export function hasPermission(
  policy: Policy | null | undefined,
  accountId: string,
  kind: string,
  action: string
): boolean {
  if (!policy) return false;

  // Check each role to see if user is in it and has the permission
  for (const role of policy.roles) {
    const isInRole = checkRoleMembership(role.kind, accountId);
    const hasPermission = role.permissions.includes(`${kind}:${action}`) ||
      role.permissions.includes(`${kind}:*`) ||
      role.permissions.includes(`*:${action}`) ||
      role.permissions.includes("*:*");

    if (isInRole && hasPermission) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an account is a member of a role
 */
function checkRoleMembership(roleKind: RoleKind, accountId: string): boolean {
  if ("Everyone" in roleKind) {
    return true;
  }

  if ("Group" in roleKind) {
    return roleKind.Group.includes(accountId);
  }

  // Member role requires token balance check - can't determine from policy alone
  return false;
}

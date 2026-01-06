import { Policy, RolePermission, VotePolicy } from "@/types/policy";

export interface PolicyParameterDiff {
  proposal_bond?: { old: string; new: string };
  proposal_period?: { old: string; new: string };
  bounty_bond?: { old: string; new: string };
  bounty_forgiveness_period?: { old: string; new: string };
}

export interface RoleDiff {
  type: "added" | "removed" | "modified";
  roleName: string;
  old?: RolePermission;
  new?: RolePermission;
  changes?: {
    permissions?: {
      added: string[];
      removed: string[];
    };
    vote_policy?: {
      added: string[];
      removed: string[];
      modified: string[];
    };
    members?: {
      added: string[];
      removed: string[];
    };
  };
}

export interface VotePolicyDiff {
  weight_kind?: { old: string; new: string };
  quorum?: { old: string; new: string };
  threshold?: { old: string; new: string };
}

export function compareParameters(
  currentPolicy: Policy,
  newParameters: {
    proposal_bond: string | null;
    proposal_period: string | null;
    bounty_bond: string | null;
    bounty_forgiveness_period: string | null;
  }
): PolicyParameterDiff {
  const diff: PolicyParameterDiff = {};

  if (newParameters.proposal_bond !== null && newParameters.proposal_bond !== currentPolicy.proposal_bond) {
    diff.proposal_bond = { old: currentPolicy.proposal_bond, new: newParameters.proposal_bond };
  }

  if (newParameters.proposal_period !== null && newParameters.proposal_period !== currentPolicy.proposal_period) {
    diff.proposal_period = { old: currentPolicy.proposal_period, new: newParameters.proposal_period };
  }

  if (newParameters.bounty_bond !== null && newParameters.bounty_bond !== currentPolicy.bounty_bond) {
    diff.bounty_bond = { old: currentPolicy.bounty_bond, new: newParameters.bounty_bond };
  }

  if (
    newParameters.bounty_forgiveness_period !== null &&
    newParameters.bounty_forgiveness_period !== currentPolicy.bounty_forgiveness_period
  ) {
    diff.bounty_forgiveness_period = {
      old: currentPolicy.bounty_forgiveness_period,
      new: newParameters.bounty_forgiveness_period,
    };
  }

  return diff;
}

export function compareRole(
  currentPolicy: Policy,
  newRole: {
    name: string;
    permissions: string[];
    vote_policy: Record<string, VotePolicy>;
  }
): RoleDiff | null {
  const existingRole = currentPolicy.roles.find((r) => r.name === newRole.name);

  if (!existingRole) {
    return {
      type: "added",
      roleName: newRole.name,
      new: newRole as RolePermission,
    };
  }

  const changes: RoleDiff["changes"] = {};
  let hasChanges = false;

  // Compare permissions
  const oldPermissions = new Set(existingRole.permissions);
  const newPermissions = new Set(newRole.permissions);

  const addedPermissions = newRole.permissions.filter((p) => !oldPermissions.has(p));
  const removedPermissions = existingRole.permissions.filter((p) => !newPermissions.has(p));

  if (addedPermissions.length > 0 || removedPermissions.length > 0) {
    changes.permissions = { added: addedPermissions, removed: removedPermissions };
    hasChanges = true;
  }

  // Compare vote policies
  const oldPolicyKeys = new Set(Object.keys(existingRole.vote_policy));
  const newPolicyKeys = new Set(Object.keys(newRole.vote_policy));

  const addedPolicies = Object.keys(newRole.vote_policy).filter((k) => !oldPolicyKeys.has(k));
  const removedPolicies = Object.keys(existingRole.vote_policy).filter((k) => !newPolicyKeys.has(k));
  const modifiedPolicies: string[] = [];

  for (const key of Object.keys(newRole.vote_policy)) {
    if (oldPolicyKeys.has(key)) {
      const oldPolicy = existingRole.vote_policy[key];
      const newPolicy = newRole.vote_policy[key];

      if (
        oldPolicy.weight_kind !== newPolicy.weight_kind ||
        oldPolicy.quorum !== newPolicy.quorum ||
        JSON.stringify(oldPolicy.threshold) !== JSON.stringify(newPolicy.threshold)
      ) {
        modifiedPolicies.push(key);
      }
    }
  }

  if (addedPolicies.length > 0 || removedPolicies.length > 0 || modifiedPolicies.length > 0) {
    changes.vote_policy = { added: addedPolicies, removed: removedPolicies, modified: modifiedPolicies };
    hasChanges = true;
  }

  // Compare members (for Group roles)
  if (
    typeof existingRole.kind === "object" &&
    "Group" in existingRole.kind &&
    typeof newRole.kind === "object" &&
    "Group" in (newRole as any).kind
  ) {
    const oldMembers = new Set(existingRole.kind.Group);
    const newMembers = new Set((newRole as any).kind.Group);

    const addedMembers = [...newMembers].filter((m) => !oldMembers.has(m));
    const removedMembers = [...oldMembers].filter((m) => !newMembers.has(m));

    if (addedMembers.length > 0 || removedMembers.length > 0) {
      changes.members = { added: addedMembers, removed: removedMembers };
      hasChanges = true;
    }
  }

  if (!hasChanges) {
    return null;
  }

  return {
    type: "modified",
    roleName: newRole.name,
    old: existingRole,
    new: newRole as RolePermission,
    changes,
  };
}

export function findRoleToRemove(currentPolicy: Policy, roleName: string): RoleDiff | null {
  const existingRole = currentPolicy.roles.find((r) => r.name === roleName);

  if (!existingRole) {
    return null;
  }

  return {
    type: "removed",
    roleName,
    old: existingRole,
  };
}

export function compareVotePolicy(currentPolicy: Policy, newVotePolicy: VotePolicy): VotePolicyDiff {
  const diff: VotePolicyDiff = {};
  const oldPolicy = currentPolicy.default_vote_policy;

  if (oldPolicy.weight_kind !== newVotePolicy.weight_kind) {
    diff.weight_kind = { old: oldPolicy.weight_kind, new: newVotePolicy.weight_kind };
  }

  if (oldPolicy.quorum !== newVotePolicy.quorum) {
    diff.quorum = { old: oldPolicy.quorum, new: newVotePolicy.quorum };
  }

  const oldThreshold = JSON.stringify(oldPolicy.threshold);
  const newThreshold = JSON.stringify(newVotePolicy.threshold);

  if (oldThreshold !== newThreshold) {
    diff.threshold = { old: oldThreshold, new: newThreshold };
  }

  return diff;
}

export function formatThresholdForDisplay(threshold: any): string {
  if (typeof threshold === "string") {
    return threshold;
  }
  if (Array.isArray(threshold)) {
    return `${threshold[0]}/${threshold[1]}`;
  }
  return JSON.stringify(threshold);
}

import { Policy } from "@/types/policy";
import {
    PolicyChange,
    RoleChange,
    VotePolicyChange,
    MemberRoleChange,
    RoleDefinitionChange,
} from "../types/index";

/**
 * Helper function to compute member-level role changes
 * A member can belong to multiple roles (groups)
 */
export function computeMemberRoleChanges(currentPolicy: Policy, newPolicy: Policy): RoleChange {
    const addedMembers: MemberRoleChange[] = [];
    const removedMembers: MemberRoleChange[] = [];
    const updatedMembers: MemberRoleChange[] = [];
    const roleDefinitionChanges: RoleDefinitionChange[] = [];

    // Create a map of current member -> roles (array of role names)
    const currentMemberRoles = new Map<string, string[]>();
    for (const role of currentPolicy?.roles || []) {
        if (typeof role.kind === "object" && "Group" in role.kind) {
            for (const member of role.kind.Group) {
                const existing = currentMemberRoles.get(member) || [];
                currentMemberRoles.set(member, [...existing, role.name]);
            }
        }
    }

    // Create a map of new member -> roles (array of role names)
    const newMemberRoles = new Map<string, string[]>();
    for (const role of newPolicy.roles) {
        if (typeof role.kind === "object" && "Group" in role.kind) {
            for (const member of role.kind.Group) {
                const existing = newMemberRoles.get(member) || [];
                newMemberRoles.set(member, [...existing, role.name]);
            }
        }
    }

    // Get all unique members
    const allMembers = new Set([...currentMemberRoles.keys(), ...newMemberRoles.keys()]);

    for (const member of allMembers) {
        const oldRoles = currentMemberRoles.get(member) || [];
        const newRoles = newMemberRoles.get(member) || [];

        // Sort for comparison
        const oldRolesSorted = [...oldRoles].sort();
        const newRolesSorted = [...newRoles].sort();

        if (oldRoles.length === 0 && newRoles.length > 0) {
            // Member was added
            addedMembers.push({
                member,
                newRoles: newRolesSorted,
            });
        } else if (oldRoles.length > 0 && newRoles.length === 0) {
            // Member was removed
            removedMembers.push({
                member,
                oldRoles: oldRolesSorted,
            });
        } else if (JSON.stringify(oldRolesSorted) !== JSON.stringify(newRolesSorted)) {
            // Member's roles changed
            updatedMembers.push({
                member,
                oldRoles: oldRolesSorted,
                newRoles: newRolesSorted,
            });
        }
    }

    // Compare role definitions (vote policies and permissions)
    const currentRoleMap = new Map(currentPolicy?.roles?.map(r => [r.name, r]) || []);
    const newRoleMap = new Map(newPolicy.roles.map(r => [r.name, r]));

    // Check all roles that exist in both policies
    for (const [roleName, newRole] of newRoleMap) {
        const oldRole = currentRoleMap.get(roleName);
        if (!oldRole) continue; // Skip newly added roles (they don't have old values to compare)

        // For each proposal kind in the role's vote_policy
        for (const [proposalKind, newVotePolicy] of Object.entries(newRole.vote_policy)) {
            const oldVotePolicy = oldRole.vote_policy[proposalKind];
            if (!oldVotePolicy) continue; // Skip if this proposal kind didn't exist before

            const hasChanges =
                oldVotePolicy.weight_kind !== newVotePolicy.weight_kind ||
                oldVotePolicy.quorum !== newVotePolicy.quorum ||
                JSON.stringify(oldVotePolicy.threshold) !== JSON.stringify(newVotePolicy.threshold);

            const permissionsChanged =
                JSON.stringify([...oldRole.permissions].sort()) !== JSON.stringify([...newRole.permissions].sort());

            if (hasChanges || permissionsChanged) {
                roleDefinitionChanges.push({
                    roleName,
                    proposalKind,
                    oldThreshold: oldVotePolicy.threshold,
                    newThreshold: newVotePolicy.threshold,
                    oldQuorum: oldVotePolicy.quorum,
                    newQuorum: newVotePolicy.quorum,
                    oldWeightKind: oldVotePolicy.weight_kind,
                    newWeightKind: newVotePolicy.weight_kind,
                    oldPermissions: permissionsChanged ? oldRole.permissions : undefined,
                    newPermissions: permissionsChanged ? newRole.permissions : undefined,
                });
            }
        }
    }

    return {
        addedMembers,
        removedMembers,
        updatedMembers,
        roleDefinitionChanges,
    };
}

/**
 * Compute the difference between two policies based on the original proposal kind
 */
export function computePolicyDiff(
    currentPolicy: Policy,
    newPolicy: Policy | null,
    originalProposalKind: any
): {
    policyChanges: PolicyChange[];
    roleChanges: RoleChange;
    defaultVotePolicyChanges: VotePolicyChange[];
} {
    const policyChanges: PolicyChange[] = [];
    let roleChanges: RoleChange = {
        addedMembers: [],
        removedMembers: [],
        updatedMembers: [],
        roleDefinitionChanges: [],
    };
    const defaultVotePolicyChanges: VotePolicyChange[] = [];

    if ("ChangePolicy" in originalProposalKind && newPolicy) {
        // Compare policy parameters
        if (currentPolicy?.proposal_bond !== newPolicy?.proposal_bond) {
            policyChanges.push({
                field: "proposal_bond",
                oldValue: currentPolicy?.proposal_bond || "0",
                newValue: newPolicy.proposal_bond,
            });
        }
        if (currentPolicy?.proposal_period !== newPolicy?.proposal_period) {
            policyChanges.push({
                field: "proposal_period",
                oldValue: currentPolicy?.proposal_period || "0",
                newValue: newPolicy.proposal_period,
            });
        }
        if (currentPolicy?.bounty_bond !== newPolicy?.bounty_bond) {
            policyChanges.push({
                field: "bounty_bond",
                oldValue: currentPolicy?.bounty_bond || "0",
                newValue: newPolicy.bounty_bond,
            });
        }
        if (currentPolicy?.bounty_forgiveness_period !== newPolicy?.bounty_forgiveness_period) {
            policyChanges.push({
                field: "bounty_forgiveness_period",
                oldValue: currentPolicy?.bounty_forgiveness_period || "0",
                newValue: newPolicy.bounty_forgiveness_period,
            });
        }

        // Compare roles at member level
        roleChanges = computeMemberRoleChanges(currentPolicy, newPolicy);

        // Compare default vote policy
        const oldVP = currentPolicy?.default_vote_policy;
        const newVP = newPolicy.default_vote_policy;
        if (oldVP?.weight_kind !== newVP.weight_kind) {
            defaultVotePolicyChanges.push({
                field: "weight_kind",
                oldValue: oldVP?.weight_kind,
                newValue: newVP.weight_kind,
            });
        }
        if (oldVP?.quorum !== newVP.quorum) {
            defaultVotePolicyChanges.push({
                field: "quorum",
                oldValue: oldVP?.quorum,
                newValue: newVP.quorum,
            });
        }
        if (JSON.stringify(oldVP?.threshold) !== JSON.stringify(newVP.threshold)) {
            defaultVotePolicyChanges.push({
                field: "threshold",
                oldValue: oldVP?.threshold,
                newValue: newVP.threshold,
            });
        }
    }

    if ("ChangePolicyUpdateParameters" in originalProposalKind) {
        const parameters = originalProposalKind.ChangePolicyUpdateParameters.parameters;

        if (parameters?.proposal_bond !== null && parameters?.proposal_bond !== currentPolicy?.proposal_bond) {
            policyChanges.push({
                field: "proposal_bond",
                oldValue: currentPolicy.proposal_bond,
                newValue: parameters.proposal_bond,
            });
        }
        if (parameters?.proposal_period !== null && parameters?.proposal_period !== currentPolicy?.proposal_period) {
            policyChanges.push({
                field: "proposal_period",
                oldValue: currentPolicy?.proposal_period,
                newValue: parameters.proposal_period,
            });
        }
        if (parameters?.bounty_bond !== null && parameters?.bounty_bond !== currentPolicy?.bounty_bond) {
            policyChanges.push({
                field: "bounty_bond",
                oldValue: currentPolicy?.bounty_bond,
                newValue: parameters.bounty_bond,
            });
        }
        if (
            parameters?.bounty_forgiveness_period !== null &&
            parameters?.bounty_forgiveness_period !== currentPolicy?.bounty_forgiveness_period
        ) {
            policyChanges.push({
                field: "bounty_forgiveness_period",
                oldValue: currentPolicy?.bounty_forgiveness_period,
                newValue: parameters.bounty_forgiveness_period,
            });
        }
    }

    if ("ChangePolicyAddOrUpdateRole" in originalProposalKind) {
        // For single role changes, create a temporary policy with just that change
        const role = originalProposalKind.ChangePolicyAddOrUpdateRole.role;
        const tempNewPolicy = { ...currentPolicy, roles: [...currentPolicy.roles] };

        const existingRoleIndex = tempNewPolicy.roles.findIndex((r: any) => r.name === role.name);
        if (existingRoleIndex >= 0) {
            tempNewPolicy.roles[existingRoleIndex] = role as any;
        } else {
            tempNewPolicy.roles.push(role as any);
        }

        roleChanges = computeMemberRoleChanges(currentPolicy, tempNewPolicy as Policy);
    }

    if ("ChangePolicyRemoveRole" in originalProposalKind) {
        const roleName = originalProposalKind.ChangePolicyRemoveRole.role;
        // Create a temporary policy without the removed role
        const tempNewPolicy = {
            ...currentPolicy,
            roles: currentPolicy.roles.filter((r) => r.name !== roleName),
        };

        roleChanges = computeMemberRoleChanges(currentPolicy, tempNewPolicy);
    }

    if ("ChangePolicyUpdateDefaultVotePolicy" in originalProposalKind) {
        const newVotePolicy = originalProposalKind.ChangePolicyUpdateDefaultVotePolicy.vote_policy;
        const oldVP = currentPolicy.default_vote_policy;

        if (oldVP.weight_kind !== newVotePolicy.weight_kind) {
            defaultVotePolicyChanges.push({
                field: "weight_kind",
                oldValue: oldVP.weight_kind,
                newValue: newVotePolicy.weight_kind,
            });
        }
        if (oldVP.quorum !== newVotePolicy.quorum) {
            defaultVotePolicyChanges.push({
                field: "quorum",
                oldValue: oldVP.quorum,
                newValue: newVotePolicy.quorum,
            });
        }
        if (JSON.stringify(oldVP.threshold) !== JSON.stringify(newVotePolicy.threshold)) {
            defaultVotePolicyChanges.push({
                field: "threshold",
                oldValue: oldVP.threshold,
                newValue: newVotePolicy.threshold,
            });
        }
    }

    return {
        policyChanges,
        roleChanges,
        defaultVotePolicyChanges,
    };
}

